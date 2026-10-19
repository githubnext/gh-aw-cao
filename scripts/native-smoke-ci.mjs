import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

const base = new URL("../docs/operational-value/proof/smoke-ci/", import.meta.url);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
export const sourceBlob = "435a00b593ced2327e01fd84c7cc93fdb45f8fae";
const repositoryId = 1036865607;
const cutoff = "2026-10-18T15:00:12Z";

export function verifiedBytes(record, directory = base, packs = new Map()) {
  if (typeof record.file !== "string" || record.file.startsWith("/")
    || record.file.split("/").some(part => part === ".." || part === "")) throw new Error("Unsafe evidence path");
  const file = new URL(record.file, directory);
  let bytes;
  if (record.member) {
    if (!/^[a-f0-9]{40}$/.test(record.member) || !record.file.endsWith(".br")) throw new Error("Wrong source-pack identity");
    if (!packs.has(file.href)) {
      packs.set(file.href, JSON.parse(brotliDecompressSync(readFileSync(file), { maxOutputLength: 32 * 1024 * 1024 })));
    }
    const pack = packs.get(file.href), object = pack.objects?.[record.member];
    if (pack.schemaVersion !== 1 || !object || !["utf8", "base64"].includes(object.encoding)
      || typeof object.data !== "string") throw new Error("Missing complete original source-pack member");
    bytes = Buffer.from(object.data, object.encoding);
  } else {
    const stored = readFileSync(file);
    bytes = record.file.endsWith(".gz") ? gunzipSync(stored, { maxOutputLength: 32 * 1024 * 1024 }) : stored;
  }
  if (bytes.length !== record.bytes || sha(bytes) !== record.sha256) throw new Error("Original evidence integrity mismatch");
  if (record.gitObject) {
    const gitSha = createHash("sha1").update(`${record.type} ${bytes.length}\0`).update(bytes).digest("hex");
    if (gitSha !== record.gitObject) throw new Error("Git source identity mismatch");
  }
  return bytes;
}

export function treeEntries(bytes) {
  const entries = new Map();
  for (let offset = 0; offset < bytes.length;) {
    const space = bytes.indexOf(32, offset), nul = bytes.indexOf(0, space);
    if (space < offset || nul < space || nul + 21 > bytes.length) throw new Error("Malformed original Git tree");
    const name = bytes.subarray(space + 1, nul).toString();
    if (entries.has(name)) throw new Error("Duplicate original tree entry");
    entries.set(name, { mode: bytes.subarray(offset, space).toString(),
      id: bytes.subarray(nul + 1, nul + 21).toString("hex") });
    offset = nul + 21;
  }
  return entries;
}

export function verifySources(directory = base) {
  const index = JSON.parse(readFileSync(new URL("sources.json", directory)));
  const packs = new Map();
  const objects = new Map(index.records.map(record => [record.gitObject, verifiedBytes(record, directory, packs)]));
  const addition = "42fe9bee6733515d6e875be9e929d3b9b11126db";
  const parent = "a7e0dfb04765978f1048e37339e50462cb1fa612";
  const intro = objects.get(addition)?.toString();
  if (!intro?.includes(`\nparent ${parent}\n`)) throw new Error("Actual introduction parent missing");
  const introducedAt = intro.match(/\ncommitter [^\n]+ ([0-9]+) [+-][0-9]{4}\n/)?.[1];
  if (new Date(Number(introducedAt) * 1000).toISOString() !== "2026-04-18T11:23:19.000Z") {
    throw new Error("Actual introduction clock mismatch");
  }
  for (const [id, expected] of [[addition, "10911c56fd7f0d10b7f888867a0677f2f4693de1"], [parent, null]]) {
    let tree = objects.get(id)?.toString().match(/^tree ([a-f0-9]{40})\n/)?.[1];
    for (const component of [".github", "workflows"]) {
      const row = treeEntries(objects.get(tree)).get(component);
      if (row?.mode !== "40000") throw new Error("Adoption source ancestry missing");
      tree = row.id;
    }
    const row = treeEntries(objects.get(tree)).get("smoke-ci.md");
    if ((row?.id ?? null) !== expected) throw new Error("Actual source addition/parent absence not proven");
  }
  if (!objects.has(sourceBlob)) throw new Error("Reference source unavailable");
  const compiled = objects.get("6a947c51b5a786279cf8ebda6645db373301bebe")?.toString();
  const samples = compiled?.match(/GH_AW_SAMPLES: \|\n[ ]+(\[[^\n]+\])\n/)?.[1];
  if (!samples) throw new Error("Frozen compiled samples missing");
  const entries = JSON.parse(samples);
  if (JSON.stringify(entries.map(entry => entry.tool)) !==
    JSON.stringify(["add_comment", "add_labels", "create_issue", "remove_labels", "update_issue"])) {
    throw new Error("Frozen compiled request population mismatch");
  }
  if (!compiled.includes('node "${RUNNER_TEMP}/gh-aw/actions/apply_samples.cjs"')
    || !objects.get("b985ab5c518a3d77076cd0962b63c7e62c186032")?.toString()
      .includes("Append a synthetic terminal_reason: completed marker")) {
    throw new Error("Frozen replay driver binding missing");
  }
  return index.records.map(record => ({
    repository: "github/gh-aw", kind: `original-git-${record.type}`,
    ref: `git:${record.gitObject};sha256:${record.sha256}`,
  }));
}

export function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw new Error("Invalid native UTC timestamp");
  }
  return Date.parse(value);
}

export function verifyRun(run) {
  if (!Number.isSafeInteger(run.id) || run.id < 1 || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1
    || run.repository?.id !== repositoryId || run.repository?.full_name !== "github/gh-aw"
    || run.path !== ".github/workflows/smoke-ci.lock.yml"
    || !/^[a-f0-9]{40}$/.test(run.head_sha ?? "")
    || timestamp(run.created_at) >= timestamp(cutoff)) throw new Error("Original run identity/clock mismatch");
  return run;
}

export function inspectPersisted(run, issue, comments = []) {
  verifyRun(run);
  if (issue === null) return [];
  if (!Number.isSafeInteger(issue.id) || issue.id < 1 || !Number.isSafeInteger(issue.number) || issue.number < 1
    || typeof issue.node_id !== "string"
    || issue.url !== `https://api.github.com/repos/github/gh-aw/issues/${issue.number}`
    || issue.pull_request) throw new Error("Wrong native issue identity");
  const runText = String(run.id);
  const nativeBody = `Deterministic samples replay for run ${runText}.\n\nThis issue is produced by \`safe-outputs.create-issue.samples\`, not by an agent.`;
  const body = issue.body?.trim();
  const result = [];
  const created = timestamp(issue.created_at);
  if (created < timestamp(run.created_at) || created >= timestamp(cutoff)) throw new Error("Issue clock outside original attempt");
  const bodyValid = typeof body === "string" && body.startsWith(nativeBody);
  const event = (operation, nativeId, at) => ({
    key: `${repositoryId}/${run.id}/${run.run_attempt}/${operation}/${nativeId}`,
    operation, nativeId: String(nativeId), runId: run.id, attempt: run.run_attempt,
    target: issue.node_id, timestamp: at, receiptLinked: false,
  });
  if (issue.title === "[smoke-ci] safe-outputs samples replay" && bodyValid) {
    result.push(event("create_issue", issue.node_id, issue.created_at));
  }
  for (const comment of comments) {
    if (comment.issue_url !== issue.url || typeof comment.node_id !== "string"
      || !Number.isSafeInteger(comment.id)) throw new Error("Wrong native comment identity");
    const at = timestamp(comment.created_at);
    if (at < created || at >= timestamp(cutoff)) throw new Error("Comment clock outside native attempt");
    if (comment.body === `smoke-ci samples replay comment for run ${runText}.`) {
      result.push(event("add_comment", comment.node_id, comment.created_at));
    }
  }
  // Current mutable bodies cannot date an append or prove label transitions.
  // Native protected mutation receipts/events are required for those facets.
  return result;
}

export function inspectCliComment(run, comment) {
  verifyRun(run);
  if (run.event !== "pull_request" || run.pull_requests?.length !== 1) {
    throw new Error("CLI comment opportunity needs original unambiguous PR identity");
  }
  const pr = run.pull_requests[0];
  if (!Number.isSafeInteger(pr.number) || pr.number < 1
    || pr.url !== `https://api.github.com/repos/github/gh-aw/pulls/${pr.number}`) {
    throw new Error("Wrong original CLI target identity");
  }
  if (comment === null) return [];
  if (!Number.isSafeInteger(comment.id) || comment.id < 1 || typeof comment.node_id !== "string"
    || comment.issue_url !== `https://api.github.com/repos/github/gh-aw/issues/${pr.number}`) {
    throw new Error("Wrong persisted CLI comment identity");
  }
  const at = timestamp(comment.created_at);
  if (at < timestamp(run.created_at) || at >= timestamp(cutoff)) throw new Error("CLI comment clock mismatch");
  if (comment.updated_at !== comment.created_at) return [];
  const expected = `\u2705 smoke-ci: safeoutputs CLI comment + comment-memory run (${run.id})`;
  if (comment.body !== expected) return [];
  return [{
    key: `${repositoryId}/${run.id}/${run.run_attempt}/cli_add_comment/${comment.node_id}`,
    operation: "cli_add_comment", nativeId: comment.node_id,
    runId: run.id, attempt: run.run_attempt, target: String(pr.number),
    timestamp: comment.created_at, receiptLinked: false,
    profile: "historical-cli-contract-v2",
  }];
}

export function inspectPostconditions(run, pr, comments) {
  verifyRun(run);
  if (pr.base?.repo?.id !== repositoryId || pr.base.repo.full_name !== "github/gh-aw"
    || pr.base.repo.private !== false || !Number.isSafeInteger(pr.number) || pr.number < 1
    || typeof pr.node_id !== "string"
    || pr.url !== `https://api.github.com/repos/github/gh-aw/pulls/${pr.number}`
    || !Array.isArray(comments)) throw new Error("Wrong independent native PR postcondition identity");
  const expected = `\u2705 smoke-ci: safeoutputs CLI comment + comment-memory run (${run.id})`;
  const identities = new Set();
  const effects = [];
  for (const comment of comments) {
    if (!Number.isSafeInteger(comment.id) || typeof comment.node_id !== "string" || identities.has(comment.node_id)
      || comment.issue_url !== `https://api.github.com/repos/github/gh-aw/issues/${pr.number}`
      || comment.html_url !== `https://github.com/github/gh-aw/pull/${pr.number}#issuecomment-${comment.id}`
      || typeof comment.body !== "string") throw new Error("Wrong original native comment identity");
    identities.add(comment.node_id);
    const created = timestamp(comment.created_at);
    timestamp(comment.updated_at);
    if (created < timestamp(run.created_at) || created >= timestamp(cutoff)
      || comment.updated_at !== comment.created_at) continue;
    if (comment.body.split(/\r?\n/).filter(line => line === expected).length !== 1) continue;
    effects.push({
      key: `${repositoryId}/comment/${comment.node_id}`, operation: "persisted_message_line",
      nativeId: comment.node_id, runId: run.id, attempt: null, target: pr.node_id,
      timestamp: comment.created_at, receiptLinked: false,
      profile: "persisted-postcondition-contract-v3",
    });
  }
  return { effects, capturedCommentCount: comments.length,
    matchingUnchangedNativeLines: effects.length,
    originalTriggerTargetBound: false, executedWorkflowBound: false,
    nativeEffectCount: effects.length > 0 ? effects.length : null,
    interpretation: effects.length > 0
      ? "Independently observed narrow postcondition only; no protected execution or contribution claim."
      : "No accepted unchanged source-defined line in captured native comments. Missing historical/execution binding is not native zero.",
  };
}

export function evaluateNative() {
  verifySources();
  const archiveBytes = readFileSync(new URL("native-index.json", base));
  const archive = JSON.parse(archiveBytes);
  if (archive.schemaVersion !== 1 || archive.repositoryId !== repositoryId
    || archive.repository !== "github/gh-aw" || archive.cutoff !== cutoff
    || !Array.isArray(archive.attempts) || archive.attempts.length > 2) {
    throw new Error("Invalid or out-of-scope native archive");
  }
  for (const record of archive.discoveryReceipts ?? []) verifiedBytes(record);
  const results = archive.attempts.map(attempt => {
    const originals = new Map(attempt.files.map(record => [record.role, verifiedBytes(record)]));
    if (originals.size !== attempt.files.length) throw new Error("Duplicate original native role");
    const run = verifyRun(JSON.parse(originals.get("run")));
    if (run.id !== attempt.runId || run.run_attempt !== attempt.attempt) throw new Error("Native index identity mismatch");
    const postconditions = inspectPostconditions(run, JSON.parse(originals.get("pr")), JSON.parse(originals.get("comments")));
    const artifacts = originals.has("artifacts") ? JSON.parse(originals.get("artifacts")) : null;
    const jobs = originals.has("jobs") ? JSON.parse(originals.get("jobs")) : null;
    if (artifacts && artifacts.total_count !== artifacts.artifacts.length
      || jobs && jobs.jobs.some(job => job.run_id !== run.id)) {
      throw new Error("Wrong original artifact/job identities");
    }
    return { runId: run.id, attempt: run.run_attempt, timestamp: run.created_at,
      profile: "executed-source-unknown", nativeObservationComplete: false,
      artifactCount: artifacts?.total_count ?? null, capturedJobCount: jobs?.jobs.length ?? null,
      protectedLogsStatus: attempt.files.find(record => record.role === "expired-logs")?.status ?? null,
      ...postconditions };
  });
  return {
    attempts: results, effects: results.flatMap(result => result.effects),
    provenance: [
      { repository: "github/gh-aw", kind: "verified-original-git-custody",
        ref: `sha256:${sha(readFileSync(new URL("sources.json", base)))}` },
      { repository: "github/gh-aw", kind: "verified-original-native-index",
        ref: `sha256:${sha(archiveBytes)}` },
    ],
  };
}
