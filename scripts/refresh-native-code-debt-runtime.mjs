import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonArchive, writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const directory = "docs/operational-value/proof/native-code-debt";
const predecessor = "68b921b3ff5ab7adc9fafac37609b760805a39b8";
const currentRuntime = "21bfd97e7f1bb224d8d73a5b5ecf3b92262280f0";
const slugs = ["code-simplifier", "daily-code-debt-aider"];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const json = file => JSON.parse(readFileSync(file));
const archiveFile = `${directory}/runtime-v0185.json.gz`;
const changedHelpers = ["pulse-model.mjs", "review-value.mjs", "verify-value-function.mjs"]
  .map(name => `.github/skills/add-operational-value/scripts/${name}`);
const original = file => execFileSync("git", ["show", `${predecessor}:${file}`],
  { env: { ...process.env, GIT_NO_LAZY_FETCH: "1" }, maxBuffer: 8 * 1024 * 1024 });
const row = (file, bytes) => ({ path: file, bytes: bytes.length, sha256: hash(bytes) });

export function preservedRuntime() {
  const archive = readJsonArchive(archiveFile);
  assert.equal(archive.kind, "native-code-debt-preserved-runtime");
  assert.equal(archive.commit, predecessor);
  const files = new Map();
  for (const member of archive.files) {
    assert.ok(typeof member.path === "string" && !path.isAbsolute(member.path)
      && member.path.split("/").every(part => part && part !== "." && part !== ".."));
    assert.ok(!files.has(member.path));
    const bytes = Buffer.from(member.contentBase64, "base64");
    assert.equal(bytes.toString("base64"), member.contentBase64);
    assert.equal(bytes.length, member.bytes);
    assert.equal(hash(bytes), member.sha256);
    files.set(member.path, bytes);
  }
  return files;
}

export function assertRuntimeParity(previous, current, lock) {
  const result = structuredClone(current);
  assert.equal(result.valueFunction.definition.evidence.instrument,
    hash(readFileSync(`${directory}/instrument-lock.json`)));
  assert.deepEqual(result.valueFunction.definition.evidence.interpreterBindings, lock.files);
  assert.equal(result.valueFunction.sha256,
    hash(readFileSync(`docs/operational-value/proof/functions/${current.workflowSlug}.mjs`)));
  const before = previous.valueFunction.definition.evidence;
  result.valueFunction.sha256 = previous.valueFunction.sha256;
  result.valueFunction.definition.evidence.instrument = before.instrument;
  result.valueFunction.definition.evidence.interpreterBindings = before.interpreterBindings;
  for (const snapshot of result.snapshots) {
    assert.equal(snapshot.evidence.instrument, current.valueFunction.definition.evidence.instrument);
    snapshot.evidence.instrument = before.instrument;
    for (const ref of snapshot.provenance) {
      if (ref.kind !== "frozen-native-code-debt-instrument") continue;
      assert.equal(ref.ref, current.valueFunction.definition.evidence.instrument);
      ref.ref = before.instrument;
    }
  }
  delete result.generatedAt;
  const expected = structuredClone(previous);
  delete expected.generatedAt;
  assert.deepEqual(result, expected, "Native facts or timeline changed beyond the explicitly versioned runtime identity");
}

function prepare() {
  const oldBytes = original(`${directory}/instrument-lock.json`);
  assert.equal(hash(readFileSync(`${directory}/instrument-lock.json`)), hash(oldBytes),
    "Prepare only the original, unmodified instrument; never silently repin a refreshed lock");
  const oldLock = JSON.parse(oldBytes);
  const differences = oldLock.files.filter(member => hash(readFileSync(member.path)) !== member.sha256);
  assert.deepEqual(differences.map(member => member.path).sort(), [...changedHelpers].sort());
  const names = [...new Set([
    ...oldLock.unchangedBaselineDependencies,
    ".github/skills/add-operational-value/SKILL.md",
    ".github/skills/add-operational-value/references/module-contract.md",
    `${directory}/instrument-lock.json`, `${directory}/replay-baseline.json`,
    `${directory}/assessment.json`, `${directory}/validation.json`,
    ...slugs.map(slug => `docs/operational-value/proof/functions/${slug}.mjs`),
    ...readdirSync(`${directory}/reports/github-gh-aw`)
      .map(name => `${directory}/reports/github-gh-aw/${name}`),
  ])].sort();
  const members = names.map(file => {
    const bytes = original(file);
    const pinned = oldLock.files.find(member => member.path === file);
    if (pinned) assert.deepEqual(row(file, bytes), pinned);
    return { ...row(file, bytes), contentBase64: bytes.toString("base64") };
  });
  writeJsonArchive(archiveFile, { schemaVersion: 1, kind: "native-code-debt-preserved-runtime",
    commit: predecessor, files: members }, { gzipLevel: 9 });
  const baseline = JSON.parse(original(`${directory}/replay-baseline.json`));
  baseline.baselineCommit = currentRuntime;
  baseline.runtimeVersion = "0.19.0";
  baseline.files = baseline.files.map(member => row(member.path, readFileSync(member.path)));
  writeFileSync(`${directory}/replay-baseline.json`, `${JSON.stringify(baseline, null, 2)}\n`);
  const lock = { ...oldLock, runtimeRefresh: {
    version: "0.19.0", predecessorCommit: predecessor, predecessorLockSha256: hash(oldBytes),
    preservedRuntimeSha256: hash(readFileSync(archiveFile)),
    changedHelpers,
    scope: "Portable reporting and verification runtime only; native source, oracle, contracts, eligibility and numerical facts unchanged.",
  }, files: oldLock.files.map(member => row(member.path, readFileSync(member.path))) };
  const bytes = Buffer.from(`${JSON.stringify(lock, null, 2)}\n`);
  writeFileSync(`${directory}/instrument-lock.json`, bytes);
  for (const slug of slugs) {
    const file = `docs/operational-value/proof/functions/${slug}.mjs`;
    const source = original(file).toString("utf8");
    assert.equal(source.split(hash(oldBytes)).length, 2);
    writeFileSync(file, source.replace(hash(oldBytes), hash(bytes)));
  }
}

function verify() {
  const files = preservedRuntime(), lock = json(`${directory}/instrument-lock.json`);
  assert.equal(hash(readFileSync(archiveFile)), lock.runtimeRefresh.preservedRuntimeSha256);
  const results = {};
  for (const slug of slugs) {
    const file = `${directory}/reports/github-gh-aw/${slug}-timeline.json`;
    const previous = JSON.parse(files.get(file));
    const current = json(file);
    assertRuntimeParity(previous, current, lock);
    results[slug] = { previousFunctionSha256: previous.valueFunction.sha256,
      currentFunctionSha256: current.valueFunction.sha256,
      periods: current.snapshots.length,
      nativeValues: current.snapshots.map(snapshot => snapshot.metrics["native-partial"]),
      fullGoalAcceptance: null, workflowContribution: null };
  }
  writeFileSync(`${directory}/runtime-reconciliation.json`, `${JSON.stringify({
    schemaVersion: 1, predecessorCommit: predecessor, runtimeVersion: "0.19.0",
    preservedRuntimeSha256: hash(readFileSync(archiveFile)), archivedFiles: files.size,
    comparison: "Entire standard timelines equal except root generatedAt and explicitly validated runtime identities.",
    nativeSourceOracleContractsAndNumericalFactsChanged: false, newEvidenceAcquired: false,
    results,
  }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(["--prepare", "--verify"].includes(process.argv[2]) && process.argv.length === 3);
  if (process.argv[2] === "--prepare") prepare();
  else verify();
}
