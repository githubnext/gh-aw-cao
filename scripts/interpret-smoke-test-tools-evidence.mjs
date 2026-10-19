import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { smokeToolsContract as contract } from "./smoke-test-tools-contract.mjs";
import { parseNativeCodexToolLog, parseNativePiToolLog, protectedExecutionLineMatches, verifyNativeToolReceipt } from "./native-smoke-test-tools.mjs";
import { verifyPublicGitBlob } from "./immutable-public-git-source.mjs";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";

const directory = "docs/operational-value/proof/smoke-test-tools";
const cache = process.argv[2] ?? ".smoke-test-tools-cache/api";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const rows = readCensusJson(`${directory}/observations.json.gz`);
const index = readCensusJson(`${directory}/index.json`);
if (!index.complete || censusDigest(rows) !== index.observationsSha256) throw new Error("Incomplete original acquisition");
const review = readCensusJson(`${directory}/source-review.json.gz`);
if (review.contractSha256 !== censusDigest(contract) || !review.complete) throw new Error("Missing complete source review");
const profiles = new Map(), retainedSources = new Map(), projections = [];
function acquire(file, revision) {
  const key = `${revision}:${file}`;
  if (retainedSources.has(key)) return retainedSources.get(key);
  const endpoint = `repos/${contract.repository}/contents/${file}?ref=${revision}`;
  const destination = path.join(cache, `${sha(endpoint)}.json`);
  let source;
  if (!existsSync(destination)) {
    const bare = ".smoke-test-tools-cache/source.git";
    const entry = execFileSync("git", [`--git-dir=${bare}`, "ls-tree", revision, "--", file], { encoding: "utf8" }).trim();
    const match = entry.match(/^100644 blob ([a-f0-9]{40})\t/);
    if (!match) return null;
    const bytes = execFileSync("git", [`--git-dir=${bare}`, "show", `${revision}:${file}`], { maxBuffer: 4 * 1024 * 1024 });
    verifyPublicGitBlob(bytes, match[1]);
    source = { type: "file", encoding: "base64", sha: match[1], content: bytes.toString("base64") };
  }
  source ??= JSON.parse(readFileSync(destination, "utf8"));
  if (source.type !== "file" || source.encoding !== "base64") throw new Error("Invalid immutable execution source");
  writeFileSync(destination, JSON.stringify(source));
  const bytes = verifyPublicGitBlob(Buffer.from(source.content, "base64"), source.sha);
  const row = { path: file, revision, gitBlob: source.sha, sha256: sha(bytes), content: bytes.toString("base64") };
  retainedSources.set(key, row);
  return row;
}
for (const row of rows) {
  row.nativeProofs = [];
  if (row.logStatus !== "available" || !row.execution) continue;
  if (row.headRepositoryId !== contract.repositoryId) {
    row.nativeGap = "Execution source is outside the authorized repository."; continue;
  }
  if (!profiles.has(row.headSha)) {
    const source = acquire(".github/workflows/smoke-test-tools.md", row.headSha);
    const known = source && review.profiles.find(profile => profile.sourceGitBlob === source.gitBlob);
    const lock = known && acquire(".github/workflows/smoke-test-tools.lock.yml", row.headSha);
    const parsed = lock && parse(Buffer.from(lock.content, "base64").toString("utf8"));
    const steps = parsed?.jobs?.agent?.steps?.filter(step => step.id === "agentic_execution");
    const step = steps?.length === 1 ? steps[0] : null;
    profiles.set(row.headSha, source && known && lock && step ? { source, lock, known, step } : null);
  }
  const profile = profiles.get(row.headSha);
  const engine = profile?.known.engine;
  if (!profile || !["pi", "codex"].includes(engine) || profile.step.name !== row.execution.name
    || profile.step["continue-on-error"] || typeof profile.step.run !== "string"
    || !profile.step.run.includes("awf --config") || !profile.step.run.includes("-- /bin/bash -c")
    || !(engine === "pi" ? profile.step.run.includes("pi --print --mode json") : profile.step.run.includes("codex"))) {
    row.nativeGap = "No reviewed container-bound structured native command transport. Unstructured Copilot replies or mutable session artifacts cannot establish command/output lineage."; continue;
  }
  const endpoint = `repos/${contract.repository}/actions/runs/${row.runId}/attempts/1/logs`;
  const file = path.join(cache, `${sha(endpoint)}.zip`);
  if (!existsSync(file)) throw new Error("Retained protected log archive disappeared");
  const archive = readFileSync(file);
  if (sha(archive) !== row.logsSha256) throw new Error("Protected log archive digest changed");
  const entries = row.logEntries.filter(entry => /^\d+_[Aa]gent\.txt$/.test(entry));
  if (entries.length !== 1) {
    row.nativeGap = "No unique supported protected agent-job log layout."; continue;
  }
  const text = execFileSync("unzip", ["-p", file, entries[0]], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 60000 });
  const lines = text.split(/\r?\n/);
  const runLines = profile.step.run.trimEnd().split("\n");
  const stripped = lines.map(line => line.replace(/^\S+ /, "").replace(/\x1b\[[0-9;]*m/g, ""));
  const starts = stripped.map((line, position) => line === `##[group]Run ${runLines[0]}` ? position : -1)
    .filter(position => position >= 0 && runLines.every((line, offset) => protectedExecutionLineMatches(line, stripped[position + offset + 1])));
  if (starts.length !== 1) {
    row.nativeGap = "Protected runner did not echo the exact immutable container execution script (PR/base or source mismatch)."; continue;
  }
  const bodyStart = stripped.indexOf("##[endgroup]", starts[0]);
  const nextGroup = stripped.findIndex((line, position) => position > bodyStart && line.startsWith("##[group]Run "));
  const body = lines.slice(bodyStart + 1, nextGroup < 0 ? undefined : nextGroup).join("\n");
  const parsed = (engine === "pi" ? parseNativePiToolLog : parseNativeCodexToolLog)(body, row.execution);
  const expandedSourceLines = runLines.flatMap((line, offset) => line === stripped[starts[0] + offset + 1]
    ? [] : [{ source: line, expanded: stripped[starts[0] + offset + 1] }]);
  const sourceProfileSha256 = censusDigest({
    headSha: row.headSha, sourceGitBlob: profile.source.gitBlob, lockGitBlob: profile.lock.gitBlob,
    engine: profile.known.engine, executionSha256: censusDigest(profile.step), expandedSourceLines,
  });
  const receipt = verifyNativeToolReceipt({ runId: row.runId, at: row.at, sourceBound: true,
    logsSha256: row.logsSha256, hostStepSha256: sha(body), hostEntry: entries[0],
    sourceProfileSha256, results: parsed.results });
  const acceptedCalls = new Set(parsed.results.map(result => result.toolCallId));
  const nativeLines = body.split("\n").filter(line => {
    const match = line.match(/^\S+ (\{.*\})$/);
    if (!match) return false;
    let event;
    try { event = JSON.parse(match[1]); } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return false;
    }
    return engine === "pi"
      ? ["tool_execution_start", "tool_execution_end"].includes(event.type) && acceptedCalls.has(event.toolCallId)
      : ["item.started", "item.completed"].includes(event.type) && acceptedCalls.has(event.item?.id);
  });
  if (/(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|npm_[A-Za-z0-9]{30,})/.test(nativeLines.join("\n"))) throw new Error("Credential-shaped native receipt cannot be retained");
  const projection = { runId: row.runId, engine, step: row.execution, sourceProfileSha256, sourceBound: true,
    sourceHead: row.headSha, sourceGitBlob: profile.source.gitBlob, lockGitBlob: profile.lock.gitBlob,
    protectedScriptSha256: censusDigest(profile.step.run), protectedRunLines: lines.slice(starts[0], starts[0] + runLines.length + 1),
    expandedSourceLines,
    hostStepSha256: sha(body),
    logsSha256: row.logsSha256, hostEntry: entries[0], nativeLines,
    resultsSha256: censusDigest(parsed.results), rejected: parsed.rejected };
  projections.push(projection);
  row.nativeProofs.push(receipt);
  row.nativeGap = parsed.results.some(result => result.passed === true) ? null
    : "Protected engine log retained, but no closed source-required command/output pair is independently established.";
}
writeCensusJson(`${directory}/native-receipts.json.gz`, { sources: [...retainedSources.values()], projections });
writeCensusJson(`${directory}/observations.json.gz`, rows);
const proofs = rows.flatMap(row => row.nativeProofs.flatMap(receipt => receipt.results))
  .filter(result => result.passed === true);
index.observationsSha256 = censusDigest(rows);
index.nativeReceiptsSha256 = sha(readFileSync(`${directory}/native-receipts.json.gz`));
index.sourceReviewSha256 = sha(readFileSync(`${directory}/source-review.json.gz`));
index.retainedProofs = proofs.length;
index.provenRunTools = rows.reduce((count, row) => count + new Set(row.nativeProofs.flatMap(receipt => receipt.results)
  .filter(result => result.passed === true).map(result => result.toolId)).size, 0);
index.evidenceReady = proofs.length > 0;
index.nativeGaps = Object.fromEntries([...new Set(rows.map(row => row.nativeGap).filter(Boolean))]
  .map(reason => [reason, rows.filter(row => row.nativeGap === reason).length]));
writeCensusJson(`${directory}/index.json`, index);
console.log(JSON.stringify({ retainedProofs: index.retainedProofs, provenRunTools: index.provenRunTools,
  evidenceReady: index.evidenceReady, nativeGaps: index.nativeGaps }, null, 2));
