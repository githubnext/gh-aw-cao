#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const file = "/tmp/gh-aw/drive-memory/smoke-drive.txt";
export const hashBytes = bytes => createHash("sha256").update(bytes).digest("hex");

export function parseGitTree(bytes) {
  const entries = [];
  for (let at = 0; at < bytes.length;) {
    const space = bytes.indexOf(32, at), end = bytes.indexOf(0, space);
    if (space < at || end < space || end + 21 > bytes.length) throw new Error("Malformed native Git tree");
    entries.push({ mode: bytes.subarray(at, space).toString(), name: bytes.subarray(space + 1, end).toString(),
      sha: bytes.subarray(end + 1, end + 21).toString("hex") });
    at = end + 21;
  }
  return entries;
}

export function verifyLineage(lineage) {
  const verify = record => {
    const commit = Buffer.from(record.commitBytesBase64, "base64");
    if (createHash("sha1").update(`commit ${commit.length}\0`).update(commit).digest("hex") !== record.commit) {
      throw new Error("Introduction commit object mismatch");
    }
    const text = commit.toString("utf8");
    const parent = /^parent ([a-f0-9]{40})$/m.exec(text)?.[1] ?? null;
    const seconds = /^committer .+ (\d+) [+-]\d{4}$/m.exec(text)?.[1];
    if (!seconds || new Date(Number(seconds) * 1000).toISOString().replace(".000Z", "Z") !== record.at) {
      throw new Error("Introduction commit clock mismatch");
    }
    let expected = /^tree ([a-f0-9]{40})$/m.exec(text)?.[1];
    if (record.trees.length !== 3) throw new Error("Incomplete introduction tree path");
    for (let index = 0; index < 3; index++) {
      const tree = record.trees[index], bytes = Buffer.from(tree.bytesBase64, "base64");
      if (tree.gitTree !== expected || hashBytes(bytes) !== tree.sha256
        || createHash("sha1").update(`tree ${bytes.length}\0`).update(bytes).digest("hex") !== expected) {
        throw new Error("Introduction tree object mismatch");
      }
      const entries = parseGitTree(bytes);
      if (index === 2) return { parent, files: entries.filter(row =>
        ["smoke-drive.md", "smoke-drive.lock.yml"].includes(row.name)) };
      const child = entries.find(row => row.name === [".github", "workflows"][index] && row.mode === "40000");
      if (!child) throw new Error("Introduction tree path missing");
      expected = child.sha;
    }
  };
  const { addition, parent } = lineage.proof;
  const added = verify(addition), previous = verify(parent);
  if (lineage.repository !== "github/gh-aw" || lineage.actualAdoption.commit !== addition.commit
    || lineage.actualAdoption.at !== addition.at || lineage.baseline.commit !== parent.commit
    || lineage.baseline.at !== parent.at || added.parent !== parent.commit
    || added.files.length !== 2 || added.files.some(row => row.mode !== "100644") || previous.files.length !== 0) {
    throw new Error("Actual introduction/real parent not established");
  }
  return lineage;
}

export function verifySourceProfile(profile) {
  const commit = Buffer.from(profile.commit.text);
  if (hashBytes(commit) !== profile.commit.sha256
    || createHash("sha1").update(`commit ${commit.length}\0`).update(commit).digest("hex") !== profile.revision) {
    throw new Error("Native source commit object mismatch");
  }
  let expected = /^tree ([a-f0-9]{40})$/m.exec(profile.commit.text)?.[1];
  if (profile.trees?.length !== 4) throw new Error("Incomplete portable source/import tree proof");
  let workflowEntries, importEntries;
  for (let index = 0; index < 4; index++) {
    const tree = profile.trees[index], bytes = Buffer.from(tree.bytesBase64, "base64");
    if (tree.gitTree !== expected || hashBytes(bytes) !== tree.sha256
      || createHash("sha1").update(`tree ${bytes.length}\0`).update(bytes).digest("hex") !== expected) {
      throw new Error("Native source tree object mismatch");
    }
    const entries = parseGitTree(bytes);
    if (index === 2) workflowEntries = entries;
    if (index === 3) importEntries = entries;
    else {
      const child = entries.find(row => row.name === [".github", "workflows", "shared"][index] && row.mode === "40000");
      if (!child) throw new Error("Native source/import path mismatch");
      expected = child.sha;
    }
  }
  if (profile.files.length !== 4 || new Set(profile.files.map(row => row.path)).size !== 4) {
    throw new Error("Incomplete native source/import identities");
  }
  for (const file of profile.files) {
    const entries = file.path.startsWith(".github/workflows/shared/") ? importEntries : workflowEntries;
    const entry = entries.find(row => row.name === path.basename(file.path));
    if (!entry || entry.mode !== "100644" || entry.sha !== file.gitBlob) throw new Error("Native source/import not in actual run tree");
    if (file.text !== undefined) {
      const bytes = Buffer.from(file.text);
      if (bytes.length !== file.bytes || hashBytes(bytes) !== file.sha256
        || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== entry.sha) {
        throw new Error("Native source/import bytes mismatch");
      }
    }
  }
  return profile;
}

export function readOriginalPacket(directory) {
  const manifestBytes = readFileSync(path.join(directory, "manifest.json"));
  const manifest = JSON.parse(manifestBytes);
  if (manifest.repository !== "github/gh-aw" || manifest.repositoryId !== 1036865607
    || !/^[a-f0-9]{64}$/.test(manifest.upstreamManifestSha256 ?? "")
    || !Array.isArray(manifest.requests)) throw new Error("Invalid retained original packet");
  const requests = manifest.requests.map(receipt => {
    if (typeof receipt.file !== "string" || path.basename(receipt.file) !== receipt.file
      || receipt.workflow !== "smoke-drive" || !receipt.endpoint.startsWith("repos/github/gh-aw/")) {
      throw new Error("Original packet escaped scope");
    }
    const bytes = readFileSync(path.join(directory, receipt.file));
    if (bytes.length !== receipt.bytes || hashBytes(bytes) !== receipt.sha256) throw new Error("Original packet tampering");
    return { receipt, bytes };
  });
  return { manifest, requests, manifestSha256: hashBytes(manifestBytes) };
}

export function validateRunMetadata(run, runId) {
  if (run.id !== Number(runId) || run.repository?.id !== 1036865607 || run.repository?.private !== false
    || run.head_repository?.id !== 1036865607 || run.workflow_id !== 340038681
    || run.path !== ".github/workflows/smoke-drive.lock.yml"
    || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1 || !/^[a-f0-9]{40}$/.test(run.head_sha ?? "")) {
    throw new Error("Unbound native run/repository/workflow identity");
  }
  return { runId: String(run.id), attempt: run.run_attempt, head: run.head_sha, event: run.event };
}

export function inspectNotStarted(execution, job, log, compiled) {
  const steps = job.steps ?? [];
  const initialization = steps.find(step => step.name === "Initialize agent execution evidence");
  const checkout = steps.find(step => step.name === "Checkout drive-memory file share (default)");
  const execute = steps.find(step => step.name === "Execute Codex CLI");
  const denied = log.match(/^(\d{4}-\d\d-\d\dT\S+Z) ##\[error\]gh-drives-service denied this request \(permission_denied\): drives are disabled for public repositories\..*$/m);
  const sourceBound = compiled.includes('run_id":%s,"run_attempt":%s,"state":"not_started"')
    && compiled.includes('run_id":%s,"run_attempt":%s,"state":"started"')
    && compiled.includes('drive-name: "smoke-drive"') && compiled.includes("- name: Execute Codex CLI");
  if (execution.version !== 1 || execution.component !== "agent" || execution.state !== "not_started"
    || job.run_id !== execution.run_id || job.run_attempt !== execution.run_attempt
    || job.name !== "agent" || !sourceBound
    || initialization?.conclusion !== "success" || checkout?.conclusion !== "failure"
    || execute?.conclusion !== "skipped" || initialization.number >= checkout.number
    || checkout.number >= execute.number || !denied) {
    return null;
  }
  if (![denied[1], checkout.started_at, job.completed_at].every(at => Number.isFinite(Date.parse(at)))
    || Date.parse(denied[1]) < Date.parse(checkout.started_at)
    || Date.parse(denied[1]) >= Date.parse(job.completed_at)) throw new Error("Protected drive failure clock mismatch");
  return {
    sameRun: { attained: false, reason: "Protected drive checkout denied before agent execution; no workflow write/readback occurred." },
    fullGoal: { attained: false, reason: "Required drive checkout and exact current-run memory test were not executed." },
    persistence: { attained: null, missingReason: "Stored cross-run state not read; denial is not evidence of lost or correct persisted bytes." },
    repositoryAccess: { attained: null, missingReason: "Agent git-log requirement not executed; checkout success alone is not that native test." },
    failure: { kind: "drive-service-permission-denied", at: denied[1], step: checkout.number },
  };
}

export function readRetainedAttempts(directory) {
  const metadata = readOriginalPacket(path.join(directory, "originals/metadata"));
  const protectedPacket = readOriginalPacket(path.join(directory, "originals/protected"));
  const profiles = JSON.parse(readFileSync(path.join(directory, "source-profiles.json"))).profiles;
  const compiledDir = path.join(directory, "originals/compiled");
  const compiledManifest = JSON.parse(readFileSync(path.join(compiledDir, "manifest.json")));
  const unzip = (receipt, name) => execFileSync("unzip", ["-p",
    path.join(directory, "originals/protected", receipt.file), name], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  return metadata.requests.filter(({ receipt }) => /^repos\/github\/gh-aw\/actions\/runs\/\d+$/.test(receipt.endpoint))
    .map(({ receipt, bytes }) => {
      const run = JSON.parse(bytes);
      const identity = validateRunMetadata(run, run.id);
      const prefix = `repos/github/gh-aw/actions/runs/${run.id}`;
      const inventory = JSON.parse(metadata.requests.find(row => row.receipt.endpoint === `${prefix}/artifacts?per_page=100`).bytes);
      const artifact = inventory.artifacts.find(row => row.name === "agent");
      if (!artifact || artifact.workflow_run?.id !== run.id || artifact.workflow_run?.repository_id !== 1036865607
        || artifact.workflow_run?.head_sha !== run.head_sha) throw new Error("Native artifact/run/source mismatch");
      const zip = protectedPacket.requests.find(row => row.receipt.endpoint === `repos/github/gh-aw/actions/artifacts/${artifact.id}/zip`);
      if (!zip || artifact.digest !== `sha256:${hashBytes(zip.bytes)}`) throw new Error("Native provider digest mismatch");
      const jobs = JSON.parse(protectedPacket.requests.find(row =>
        row.receipt.endpoint === `${prefix}/attempts/${identity.attempt}/jobs?per_page=100`).bytes);
      const job = jobs.jobs.find(row => row.name === "agent");
      if (!job || job.run_id !== run.id || job.run_attempt !== identity.attempt || job.head_sha !== identity.head
        || !Number.isFinite(Date.parse(job.completed_at))) throw new Error("Native protected job mismatch");
      const logs = protectedPacket.requests.find(row => row.receipt.endpoint === `${prefix}/attempts/${identity.attempt}/logs`);
      if (!logs) throw new Error("Missing protected attempt logs");
      const log = unzip(logs.receipt, "4_agent.txt");
      const upload = new RegExp(`Artifact agent has been successfully uploaded! Final size is ${zip.bytes.length} bytes\\. Artifact ID is ${artifact.id}\\b`);
      if (!upload.test(log) || !log.includes(`SHA256 digest of uploaded artifact is ${hashBytes(zip.bytes)}`)) {
        throw new Error("Agent artifact lacks agreeing protected attempt upload receipt");
      }
      const profile = profiles.find(row => row.runId === identity.runId && row.revision === identity.head);
      if (!profile) throw new Error("Missing native source profile");
      verifySourceProfile(profile);
      const source = profile?.files.find(row => row.path === ".github/workflows/smoke-drive.md");
      if (!source || source.gitBlob !== "b807269a21552c0e6ac518da7c44056024047e95"
        || hashBytes(source.text) !== source.sha256
        || createHash("sha1").update(`blob ${Buffer.byteLength(source.text)}\0`).update(source.text).digest("hex") !== source.gitBlob) {
        throw new Error("Unsupported native source era");
      }
      const compiledRef = profile.files.find(row => row.path.endsWith(".lock.yml"));
      const compiledReceipt = compiledManifest.receipts.find(row => row.sha === compiledRef.gitBlob);
      if (!compiledReceipt || typeof compiledReceipt.blob !== "string"
        || path.basename(compiledReceipt.blob) !== compiledReceipt.blob) throw new Error("Missing original compiled source");
      const compiledBytes = readFileSync(path.join(compiledDir, compiledReceipt.blob));
      if (compiledBytes.length !== compiledReceipt.blobBytes || hashBytes(compiledBytes) !== compiledReceipt.blobSha256
        || createHash("sha1").update(`blob ${compiledBytes.length}\0`).update(compiledBytes).digest("hex") !== compiledRef.gitBlob) {
        throw new Error("Compiled source tampering");
      }
      const execution = JSON.parse(unzip(zip.receipt, "agent_execution.json"));
      if (execution.run_id !== run.id || execution.run_attempt !== identity.attempt) throw new Error("Native execution receipt mismatch");
      let facets = inspectNotStarted(execution, job, log, compiledBytes.toString("utf8"));
      if (!facets && execution.state === "started") {
        const commands = parseCodexCommands(unzip(zip.receipt, "agent-stdio.log"));
        facets = {
          sameRun: inspectExactReadback(commands, run.id),
          repositoryAccess: inspectRepositoryAccess(commands, [identity.head]),
          persistence: { attained: null, missingReason: "No supported protected prior-producer/restored-state receipts." },
          fullGoal: { attained: null, missingReason: "Exact same-run commands alone do not establish persistence or all source/import obligations." },
        };
      }
      if (!facets) throw new Error("Unsupported native execution profile; retain originals and implement its source-bound parser");
      return { key: `github/gh-aw/${run.id}/${identity.attempt}`, ...identity,
        completedAt: job.completed_at,
        originalsAcquiredAt: [receipt.receivedAt, zip.receipt.receivedAt,
          logs.receipt.receivedAt, compiledReceipt.receivedAt].toSorted().at(-1),
        ...facets,
        provenance: [
          { kind: "original-run-metadata", ref: `${receipt.endpoint}#sha256:${receipt.sha256}` },
          { kind: "provider-agent-artifact", ref: `artifact:${artifact.id}#${artifact.digest}` },
          { kind: "protected-attempt-logs", ref: `${logs.receipt.endpoint}#sha256:${logs.receipt.sha256}` },
          { kind: "immutable-compiled-source", ref: `${identity.head}:${compiledRef.path}#git:${compiledRef.gitBlob}` },
        ] };
    });
}

export function parseCodexCommands(text) {
  const commands = [];
  for (const line of text.split("\n").filter(line => line.trim())) {
    let event;
    try { event = JSON.parse(line); } catch { throw new Error("Malformed Codex JSONL"); }
    if (event.type !== "item.completed" || event.item?.type !== "command_execution") continue;
    const item = event.item;
    if (typeof item.id !== "string" || typeof item.command !== "string"
      || typeof item.aggregated_output !== "string" || !Number.isInteger(item.exit_code)) {
      throw new Error("Malformed native command result");
    }
    commands.push({ id: item.id, command: item.command, output: item.aggregated_output, exitCode: item.exit_code });
  }
  if (new Set(commands.map(command => command.id)).size !== commands.length) throw new Error("Repeated native command identity");
  return commands;
}

export function inspectExactReadback(commands, runId) {
  if (!/^[1-9]\d*$/.test(String(runId))) throw new Error("Invalid native run id");
  const expected = `run_id=${runId}\n`;
  const writes = new Set([
    `printf 'run_id=${runId}\\n' > ${file}`,
    `printf "run_id=${runId}\\n" > ${file}`,
    `printf '%s\\n' 'run_id=${runId}' > ${file}`,
    `printf '%s\\n' "run_id=${runId}" > ${file}`,
  ]);
  let wrote = null, observedFailure = false;
  for (const command of commands) {
    if (writes.has(command.command)) {
      wrote = command.exitCode === 0 ? command : null;
      observedFailure ||= command.exitCode !== 0;
    } else if (command.command === `cat ${file}` && wrote) {
      if (command.exitCode === 0 && command.output === expected) {
        return { attained: true, writeCommand: wrote.id, readCommand: command.id, bytesSha256: hashBytes(expected) };
      }
      observedFailure = true;
    } else {
      // An unsupported operation may mutate the drive; never match across it.
      wrote = null;
    }
  }
  return { attained: observedFailure ? false : null,
    missingReason: observedFailure ? null : "No supported exact write followed by an unmodified byte-exact native readback." };
}

export function inspectRepositoryAccess(commands, commits) {
  for (const command of commands) {
    if (command.command !== "git log --oneline -1" || command.exitCode !== 0) continue;
    const match = /^([a-f0-9]{7,40}) [^\n]+\n$/.exec(command.output);
    if (!match) continue;
    const matches = commits.filter(commit => /^[a-f0-9]{40}$/.test(commit) && commit.startsWith(match[1]));
    if (matches.length === 1) return { attained: true, commit: matches[0], command: command.id };
  }
  return { attained: null, missingReason: "No exact native git-log result matched a retained target-repository commit." };
}

export function aggregateAttempts(attempts, request) {
  const { windowStart, windowEnd, observedAt } = request;
  if (![windowStart, windowEnd, observedAt].every(at => typeof at === "string" && Number.isFinite(Date.parse(at)))
    || Date.parse(windowStart) >= Date.parse(windowEnd) || Date.parse(observedAt) < Date.parse(windowEnd)) {
    throw new Error("Invalid bounded native observation");
  }
  const byId = new Map();
  for (const attempt of attempts) {
    if (typeof attempt.key !== "string" || !attempt.key || !Number.isFinite(Date.parse(attempt.completedAt))) {
      throw new Error("Missing native attempt identity or authoritative completion timestamp");
    }
    const previous = byId.get(attempt.key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(attempt)) throw new Error("Conflicting duplicate native attempt");
    byId.set(attempt.key, attempt);
  }
  const rows = [...byId.values()].filter(row => Date.parse(row.completedAt) >= Date.parse(windowStart)
    && Date.parse(row.completedAt) < Date.parse(windowEnd));
  const count = field => rows.some(row => row[field]?.attained !== null && row[field]?.attained !== undefined)
    ? rows.filter(row => row[field]?.attained === true).length : null;
  return {
    coverageStatus: rows.length ? "partial" : "missing",
    measurementKind: "interval",
    windowStart, windowEnd, observedAt,
    assessedAttemptCount: rows.length,
    sameRunReadbacks: count("sameRun"),
    restoredTransitions: count("persistence"),
    repositoryAccesses: count("repositoryAccess"),
    fullGoalAttainments: count("fullGoal"),
    attempts: rows,
    missingReason: rows.length ? "Retained native attempts are not a complete execution census; broader facets remain independently qualified."
      : "No original native attempt with an authoritative completion timestamp retained in this period.",
  };
}
