import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { cutoff, repository, revision, historyStart, gitBlob, sha256, validatePacket,
  validateTransitions } from "./native-changeset.mjs";

export const output = "docs/operational-value/proof/changeset";
const required = [".github/workflows/changeset.md", ".github/workflows/shared/changeset-format.md",
  ".github/skills/jqschema/SKILL.md", ".github/skills/jqschema/jqschema.sh",
  ".github/workflows/shared/otlp.md", ".github/workflows/shared/graders.md",
  ".github/workflows/shared/graders/state-revisit-probability-rep.md",
  ".github/workflows/shared/graders/recurrence-determinism.md",
  ".github/workflows/shared/graders/recurrence-laminarity.md",
  "scripts/changeset.js", "scripts/changeset.test.js", ".changeset/README"];

export function collect(cache, history) {
  const git = args => execFileSync("git", [`--git-dir=${cache}`, ...args],
    { env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
      encoding: null, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  if (git(["remote", "get-url", "origin"]).toString().trim() !== `https://github.com/${repository}.git`) {
    throw new Error("Shared Git repository identity mismatch");
  }
  const tree = commit => git(["ls-tree", "-r", "-z", commit]).toString().split("\0").filter(Boolean).map(line => {
    const match = line.match(/^(\d{6}) blob ([a-f0-9]{40})\t(.+)$/);
    return match ? { mode: match[1], gitBlob: match[2], path: match[3] } : null;
  }).filter(Boolean);
  const entries = tree(revision);
  const unavailable = (row, reason) => ({ ...row, status: "unavailable", reason });
  const blob = row => {
    if (!row) throw new Error("Missing required tree identity");
    let bytes;
    try { bytes = git(["cat-file", "blob", row.gitBlob]); }
    catch (error) {
      if (error.status !== 128) throw error;
      return unavailable(row, `Local immutable Git blob unavailable (exit 128); ${String(error.stderr).trim()}`);
    }
    if (gitBlob(bytes) !== row.gitBlob) throw new Error("Native Git blob mismatch");
    return { ...row, status: "available", content: bytes.toString("base64"), bytes: bytes.length, sha256: sha256(bytes) };
  };
  mkdirSync(output, { recursive: true });
  const sources = required.map(file => blob(entries.find(row => row.path === file)));
  const rawTree = git(["ls-tree", "-r", "-z", revision]);
  const selected = entries.filter(row => /^\.changeset\/[^/]+\.md$/.test(row.path));
  const sourcePacket = { schemaVersion: 1, repository, repositoryId: 1036865607, revision, cutoff,
    rawTree: rawTree.toString("base64"), treeSha256: sha256(rawTree), sources,
    tree: selected, entries: selected.map(blob), historyStart };
  const commits = git(["log", "--first-parent", `--since=${historyStart}`, `--until=${cutoff}`,
    "--format=%H", revision, "--", ".changeset"]).toString().trim().split("\n").filter(Boolean);
  const transitions = commits.map(commit => {
    const raw = git(["cat-file", "commit", commit]);
    const parent = raw.toString().match(/^parent ([a-f0-9]{40})$/m)?.[1];
    if (!parent) throw new Error("Native first-parent missing");
    const at = new Date(Number(raw.toString().match(/^committer .+ ([0-9]+) [+-][0-9]{4}$/m)[1]) * 1000)
      .toISOString().replace(".000Z", "Z");
    if (at < historyStart || at >= cutoff) throw new Error("Native history escaped half-open cutoff");
    const diff = git(["diff-tree", "--raw", "-z", "-r", "--no-renames", parent, commit, "--", ".changeset"]);
    const tokens = diff.toString().split("\0").filter(Boolean);
    const changes = [];
    for (let i = 0; i < tokens.length; i += 2) {
      const match = tokens[i].match(/^:(\d{6}) (\d{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) [AMD]$/);
      if (!match) throw new Error("Unsupported diff-tree native record");
      const file = tokens[i + 1];
      if (!/^\.changeset\/[^/]+\.md$/.test(file)) continue;
      changes.push({ path: file,
        before: match[3] === "0".repeat(40) ? null : blob({ mode: match[1], gitBlob: match[3], path: file }),
        after: match[4] === "0".repeat(40) ? null : blob({ mode: match[2], gitBlob: match[4], path: file }) });
    }
    const profile = ref => ["scripts/changeset.js", ".github/workflows/shared/changeset-format.md"].map(file => {
      const response = git(["ls-tree", ref, "--", file]).toString();
      return response.match(/^\d{6} blob ([a-f0-9]{40})\t/)?.[1] ?? null;
    });
    return { commit, parent, at, rawCommit: raw.toString("base64"),
      rawDiff: diff.toString("base64"), diffSha256: sha256(diff),
      profileBefore: profile(parent), profileAfter: profile(commit), changes };
  });
  const packet = { ...sourcePacket, commitInventory: commits, transitions };
  const adoptionCommit = "06d7770e80228207b6436fd22cd01ce145daf71c";
  const adoptionParent = "feef623b4840ab0b26128b8bc3d7d96907b07fd5";
  const adoptionSource = tree(adoptionCommit);
  const parentSource = tree(adoptionParent);
  const sourcePath = ".github/workflows/changeset.md", lockPath = sourcePath.replace(".md", ".lock.yml");
  if (parentSource.some(row => [sourcePath, lockPath].includes(row.path))
    || !adoptionSource.some(row => row.path === sourcePath)
    || !adoptionSource.some(row => row.path === lockPath)) throw new Error("Source introduction not established against real parent");
  const adoptionRaw = git(["cat-file", "commit", adoptionCommit]);
  if (adoptionRaw.toString().match(/^parent ([a-f0-9]{40})$/m)?.[1] !== adoptionParent) {
    throw new Error("Source introduction real parent mismatch");
  }
  const adoptionEvidence = { commit: adoptionCommit, parent: adoptionParent,
    rawCommit: adoptionRaw.toString("base64"), rawParent: git(["cat-file", "commit", adoptionParent]).toString("base64"),
    rawTree: git(["ls-tree", "-r", "-z", adoptionCommit]).toString("base64"),
    rawParentTree: git(["ls-tree", "-r", "-z", adoptionParent]).toString("base64"),
    sources: [sourcePath, lockPath].map(file => blob(adoptionSource.find(row => row.path === file))),
    interpretation: "Actual source-and-lock introduction checked against real parent; unavailable original contents do not establish historical rule applicability." };
  writeJsonArchive(`${output}/adoption.json.gz`, adoptionEvidence, { maxDecodedBytes: 32 * 1024 * 1024, maxParts: 256 });
  validatePacket(packet);
  validateTransitions(packet);
  writeJsonArchive(`${output}/native.json.gz`, packet, { maxDecodedBytes: 32 * 1024 * 1024, maxParts: 256 });
  const { index, entities } = readOutputHistory(history);
  if (index.repository !== repository || index.repositoryId !== 1036865607 || index.until !== cutoff
    || index.sourceRevision !== revision || !index.complete) throw new Error("Shared production history scope mismatch");
  const direct = entities.filter(row => row.workflowReference?.workflowId === "changeset"
    || row.workflowReference?.workflow === "changeset" || row.unverifiedWorkflowId === "changeset");
  const all = new Map(entities.map(row => [row.number, row]));
  const selectedNumbers = new Set(direct.map(row => row.number));
  let growing = true;
  while (growing) {
    growing = false;
    for (const row of entities) {
      if (selectedNumbers.has(row.number) || row.relatedCandidates.some(number => selectedNumbers.has(number))) {
        if (!selectedNumbers.has(row.number)) { selectedNumbers.add(row.number); growing = true; }
        for (const number of row.relatedCandidates) {
          if (!selectedNumbers.has(number)) { selectedNumbers.add(number); growing = true; }
        }
      }
    }
  }
  const lineage = { schemaVersion: 1, repository, repositoryId: index.repositoryId,
    cutoff, history: { partitions: index.partitions.length, entities: index.totalEntities,
      complete: index.complete, indexSha256: sha256(readFileSync(path.join(history, "history.json.gz"))) },
    direct, closure: [...selectedNumbers].sort((a, b) => a - b).map(number => all.get(number)
      ?? { number, status: "absent-reference", reason: "Not retained in the production history inventory." }),
    limitations: index.limitations,
    interpretation: "Full forward/reverse candidate closure; editable body references are not accepted graph edges or creation/acceptance proof." };
  writeJsonArchive(`${output}/discovery.json.gz`, lineage, { maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512 });
  const missing = [...packet.entries, ...transitions.flatMap(row => row.changes.flatMap(change =>
    [change.before, change.after].filter(Boolean))), ...adoptionEvidence.sources]
    .filter(row => row.status === "unavailable");
  const byBlob = new Map();
  for (const row of missing) {
    if (!byBlob.has(row.gitBlob)) byBlob.set(row.gitBlob, {
      repository, gitBlob: row.gitBlob, endpoint: `repos/${repository}/git/blobs/${row.gitBlob}`,
      paths: [], status: "not acquired: offline-only assignment" });
    const item = byBlob.get(row.gitBlob);
    if (!item.paths.includes(row.path)) item.paths.push(row.path);
  }
  const nativeRequests = lineage.closure.map(row => ({
    number: row.number, id: row.id ?? null, kind: row.kind ?? "absent-reference",
    metadata: `repos/${repository}/${row.kind === "PullRequest" ? "pulls" : "issues"}/${row.number}`,
    timeline: `repos/${repository}/issues/${row.number}/timeline`,
    ...(row.kind === "PullRequest" ? {
      files: `repos/${repository}/pulls/${row.number}/files`,
      commits: `repos/${repository}/pulls/${row.number}/commits`,
      reviews: `repos/${repository}/pulls/${row.number}/reviews`,
    } : {}),
  }));
  writeJsonArchive(`${output}/source-requests.json.gz`, {
    schemaVersion: 1, repository, repositoryId: index.repositoryId, revision, cutoff,
    immutableMissingBlobs: [...byBlob.values()],
    introductionSources: {
      source: { commit: adoptionCommit, path: sourcePath, gitBlob: "5e7ba55aba29d40d35516838aa8aa8920a434e24" },
      lock: { commit: adoptionCommit, path: lockPath, gitBlob: "a7d2f1f94bed3f34a00833de0e093546b62a7c2b" },
      furtherImports: "Resolve the actual original workflow imports after its exact missing blob is acquired; do not substitute current imports.",
    },
    nativeRequests,
    runRequests: direct.filter(row => row.workflowReference).map(row => ({
      entityId: row.id, number: row.number, runId: row.workflowReference.runId,
      attempt: row.workflowReference.attempt,
      run: `repos/${repository}/actions/runs/${row.workflowReference.runId}`,
      jobs: `repos/${repository}/actions/runs/${row.workflowReference.runId}/jobs`,
      artifacts: `repos/${repository}/actions/runs/${row.workflowReference.runId}/artifacts`,
      logs: `repos/${repository}/actions/runs/${row.workflowReference.runId}/logs`,
    })),
    semanticAcceptanceGap: "Even complete metadata, files and reviews are insufficient without independent actual-change semantic acceptance against a source-defined rubric. No merge, label, editable prose or workflow eval question is accepted as that oracle.",
    sourceRetention: "Missing immutable local content is unavailable, not exhausted GitHub history. Run/log/artifact expiry is not assumed without an exact response.",
    authorization: "Request to coordinator only. This collector does not acquire these endpoints or execute target code.",
  }, { maxDecodedBytes: 32 * 1024 * 1024, maxParts: 256 });
  writeFileSync(`${output}/acquisition.json`, `${JSON.stringify({ revision, cutoff, historyStart,
    nativeCommits: commits.length, sources: sources.map(({ content, ...row }) => row),
    adoptionInvestigation: { candidateCommit: "06d7770e80228207b6436fd22cd01ce145daf71c",
      actualParent: "feef623b4840ab0b26128b8bc3d7d96907b07fd5",
      adoptedAt: "2025-11-01T16:31:43Z",
      sourceBlob: "5e7ba55aba29d40d35516838aa8aa8920a434e24",
      compiledBlob: "a7d2f1f94bed3f34a00833de0e093546b62a7c2b",
      originalSourceStatus: "missing local blob; historical acceptance rules not reconstructed" },
    directCandidates: direct.length, closure: selectedNumbers.size }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw new Error("usage: collect-changeset.mjs READ_ONLY_GIT_DIR HISTORY_DIR");
  collect(process.argv[2], process.argv[3]);
}
