import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { loadNative } from "./native-smoke-copilot-small.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const root = process.cwd();
const proof = "docs/operational-value/proof/smoke-copilot-small";
const modulePath = "docs/operational-value/proof/functions/smoke-copilot-small.mjs";
const testPath = "tests/unit/operational-value-smoke-copilot-small.test.mjs";
const skill = ".github/skills/add-operational-value/scripts";
const options = {};
const args = process.argv.slice(2);
while (args.length) {
  const flag = args.shift();
  if (!["--seed", "--seed-manifest", "--output-dir"].includes(flag) || !args.length) throw new Error("Invalid packaging arguments");
  options[flag] = path.resolve(args.shift());
}
if (!options["--seed"] || !options["--seed-manifest"] || !options["--output-dir"]) {
  throw new Error("Required: --seed ARCHIVE --seed-manifest JSON --output-dir DIR");
}
assert.equal(hash(readFileSync(options["--seed"])), "1135075ada0f45ea04aec54323a4b9a74c345cdc90a85393d848f3d458386b40");
assert.equal(hash(readFileSync(options["--seed-manifest"])), "7a723df38743959ffe0b0f107508f582737c76a17f0816bf0c24d76555c617bf");
const seed = JSON.parse(readFileSync(options["--seed-manifest"]));
assert.equal(seed.files.length, 32);
for (const file of seed.files) {
  const bytes = readFileSync(file.path);
  assert.equal(bytes.length, file.bytes);
  assert.equal(hash(bytes), file.sha256, `Seed member changed: ${file.path}`);
}

const run = (command, commandArgs, cwd = root) => execFileSync(command, commandArgs, {
  cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
});
const validate = cwd => {
  run(process.execPath, ["--test", testPath], cwd);
  run(process.execPath, [`${skill}/verify-value-function.mjs`, "--collector", modulePath], cwd);
  run(process.execPath, [`${skill}/evaluate.mjs`, "--root", cwd,
    "--end", "2026-10-18T15:00:12Z", "--output-dir", `${proof}/report`, "--function", modulePath,
    "--no-runs", "--refresh", "github/gh-aw", "smoke-copilot-small"], cwd);
};
validate(root);

const references = new Set();
for (const file of ["sources.json", "packets.json"]) {
  const visit = value => {
    if (!value || typeof value !== "object") return;
    if (typeof value.file === "string" && /^originals\/[a-f0-9]{64}-\d+\.gz$/.test(value.file)) references.add(value.file);
    for (const child of Object.values(value)) visit(child);
  };
  visit(JSON.parse(readFileSync(path.join(proof, file))));
}
for (const name of readdirSync(path.join(proof, "originals"))) {
  const relative = `originals/${name}`;
  if (!references.has(relative)) rmSync(path.join(proof, relative));
}

const facts = loadNative(path.join(root, proof));
const discovery = JSON.parse(gunzipSync(readFileSync(path.join(proof, "discovery.json.gz"))));
const timelinePath = `${proof}/report/github-gh-aw/smoke-copilot-small-timeline.json`;
const timeline = JSON.parse(readFileSync(timelinePath));
const baseline = run("git", ["rev-parse", "HEAD"]).trim();
const assessment = {
  schemaVersion: 1, repository: "github/gh-aw", workflow: "smoke-copilot-small",
  revision: "c86377ec47b38f0b5af463277ee55d1d03d08da8", cutoff: "2026-10-18T15:00:12Z",
  baseline, seedArchiveSha256: seed.archiveSha256, seedMembers: seed.files.length,
  predecessorPackage: { archiveSha256: "b73c4f4f16c007574e8dec1d0c0d06c453db485237d61873393653f66ca1335f",
    change: "Add missing strict write/readback byte-and-order join, preserving every established native quantity and frozen acceptance rule" },
  acceptanceSha256: hash(readFileSync(`${proof}/acceptance.json`)),
  moduleSha256: hash(readFileSync(modulePath)),
  evaluation: {
    standardCollector: "passed", standardOfflineRefresh: "passed", snapshots: timeline.snapshots.length,
    acceptedNativePeriods: timeline.snapshots.filter(row => row.metrics.arithmetic !== null).length,
    unavailablePeriods: timeline.snapshots.filter(row => row.metrics.arithmetic === null).length,
    actualStandardRejection: null,
    classification: "attainment-only",
    retrospectiveScope: "Source-matched retained native facet at actual historical run head; no backdated new goal or invented adoption",
  },
  quantities: {
    completeDiscoveryPartitions: discovery.history.partitions.length,
    completeDiscoveryEntities: discovery.history.totalEntities,
    directCandidates: discovery.direct.length,
    distinctDirectRunIds: new Set(discovery.direct.map(row => row.workflowReference?.runId).filter(Boolean)).size,
    relatedIdentities: discovery.related.length, absentReferences: discovery.absentReferences.length,
    retainedRunMetadata: facts.length, nativeAssessedAttempts: facts.filter(row => row.sourceApplicable).length,
    verifiedArithmeticAttempts: facts.filter(row => row.arithmetic === true).length,
    nativeThreeNewlineReads: facts.flatMap(row => row.nativeNewlineReads ?? []).filter(row => row.newlineCount === 3).length,
    nativeThreeNewlineCreations: facts.flatMap(row => row.nativeFileCreations ?? []).filter(row => row.newlineCount === 3).length,
    strictContentReadback: null, writePlusContentReadback: null, originalTestingHaikuAcceptance: null,
    knownImportedFailures: facts.flatMap(row => row.knownImportedFailures ?? []),
  },
  facts,
  readiness: {
    intentGrounded: true, deterministicNativeChecker: true, genuineOutcomeMeasured: true,
    primaryNativePartialReady: true, portableOfflineReplay: "passed",
    fullWorkflowAcceptanceReady: false, allHistoricalAttemptsCovered: false,
    comparableRecentTrendReady: false, adoptionComparisonReady: false,
    contribution: "Direct protected execution demonstrates this attempt's arithmetic contribution; not exclusive causation or repository-wide improvement",
    runtimeIdentity: "Native session records claude-haiku-5.5; complete source/provider small-alias wire identity is not promoted to a full-acceptance claim",
    costs: "not measured", keepDecision: "not rated", keepBar: null,
    deployment: "Sealed historical case study; no continuous collector deployed",
  },
  limitations: [
    "84 issue candidates are not successes, and 80 referenced runs are not an exhaustive workflow-run inventory.",
    "Mutable discovery states were observed after cutoff, not backdated. Selected identities retain full bidirectional related references.",
    "wc -l proves newline count, not nonempty full-content cat readback, software-testing relevance or originality.",
    "Native Playwright launch failure is retained even though the shell pipeline exited zero. It does not erase the independent arithmetic effect.",
    "Missing previous periods are null; no improvement, sustained trend, full workflow all-clear or keep recommendation is inferred.",
    "Selected original receipt manifests and original bodies are preserved; replay does not require coordinator cache or history. The all-history scan was performed at acquisition and is not a fresh remote census.",
  ],
  reusableSkillImprovement: {
    title: "Accept native shell encodings without weakening semantic facets",
    recommendation: "For Copilot native receipts, support both shell_exit contents and typed shellExecution plus anchored shell-completion content, corroborated by protected job/session summaries. Split cat|wc newline evidence from full-content readback. A successful pipeline cannot override native browser errors.",
    createOnceObserveMany: "Compile intent/source acceptance once; new original observations pass deterministic acquisition, parse, score and report only. Reauthor solely for a reviewed contract/source-era change.",
  },
  validation: { focusedRealParserTests: "passed", nativeCollectorGate: "passed", standardRefreshEvaluator: "passed",
    lint: "ESLint is not installed; no dependencies installed under offline task constraint",
    syntax: "Node imported/executed all owned modules",
    freshDefaultBaselinePlusSeedPlusOwned: "passed", originalCustodyAndSourceGitHashes: "passed" },
};
writeFileSync(`${proof}/assessment.json`, `${JSON.stringify(assessment, null, 2)}\n`);

const filesIn = directory => readdirSync(directory).sort().flatMap(name => {
  const file = path.join(directory, name);
  return statSync(file).isDirectory() ? filesIn(file) : [file];
});
const owned = [
  modulePath, ...filesIn(proof),
  "scripts/collect-smoke-copilot-small.mjs", "scripts/native-smoke-copilot-small.mjs",
  "scripts/package-smoke-copilot-small.mjs", testPath,
].sort();
assert.equal(new Set(owned).size, owned.length);
assert.ok(!seed.files.some(file => owned.includes(file.path)));
const manifestFiles = owned.map(file => {
  const bytes = readFileSync(file);
  assert.ok(bytes.length <= 256 * 1024, `Oversized member: ${file}`);
  if (file.endsWith(".mjs")) assert.ok(bytes.toString().split("\n").length < 3000);
  return { path: file, bytes: bytes.length, sha256: hash(bytes) };
});
const output = options["--output-dir"];
mkdirSync(output, { recursive: true });
const archive = path.join(output, "smoke-copilot-small-owned-v2.tar.gz");
const manifestPath = path.join(output, "smoke-copilot-small-owned-v2.manifest.json");
if (existsSync(archive) || existsSync(manifestPath)) throw new Error("Preserve predecessor package; choose a fresh output directory");
run("tar", ["-czf", archive, ...owned]);
const work = mkdtempSync(path.join(root, ".smoke-small-replay-"));
try {
  const baselineArchive = path.join(work, "baseline.tar");
  const fresh = path.join(work, "checkout");
  mkdirSync(fresh);
  run("git", ["archive", "--format=tar", `--output=${baselineArchive}`, baseline]);
  run("tar", ["-xf", baselineArchive, "-C", fresh]);
  run("tar", ["-xzf", options["--seed"], "-C", fresh]);
  run("tar", ["-xzf", archive, "-C", fresh]);
  for (const file of [...seed.files, ...manifestFiles]) {
    const bytes = readFileSync(path.join(fresh, file.path));
    assert.equal(bytes.length, file.bytes);
    assert.equal(hash(bytes), file.sha256);
  }
  validate(fresh);
  const replay = JSON.parse(readFileSync(path.join(fresh, timelinePath)));
  assert.deepEqual(replay.snapshots.map(row => ({ window: row.window, metrics: row.metrics, evidence: row.evidence })),
    timeline.snapshots.map(row => ({ window: row.window, metrics: row.metrics, evidence: row.evidence })));
  assert.deepEqual(replay.valueReview, timeline.valueReview);
  for (const file of seed.files) assert.equal(hash(readFileSync(path.join(fresh, file.path))), file.sha256);
} finally { rmSync(work, { recursive: true, force: true }); }
const manifest = { schemaVersion: 1, repository: "github/gh-aw", workflow: "smoke-copilot-small",
  baseline, seedArchiveSha256: seed.archiveSha256, archiveSha256: hash(readFileSync(archive)),
  replay: "passed: fresh default baseline + all 32 immutable seed members + owned archive, no coordinator caches/history",
  files: manifestFiles };
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ archive, manifestPath, archiveSha256: manifest.archiveSha256,
  manifestSha256: hash(readFileSync(manifestPath)), members: owned.length, nativeArithmetic: assessment.quantities.verifiedArithmeticAttempts,
  replay: "passed" }, null, 2));
