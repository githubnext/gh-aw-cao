import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectBatch, definition, scoreMetric } from "../docs/operational-value/proof/functions/artifacts-summary.mjs";
import { readJson } from "../.github/skills/add-operational-value/scripts/common.mjs";
import { writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const [outputDirectory, seedArchive, seedManifest, compilationLog] = process.argv.slice(2).map(value => path.resolve(value));
if (!outputDirectory || !seedArchive || !seedManifest) {
  throw new Error("usage: package-artifacts-summary.mjs OUTPUT_DIRECTORY SEED.tar.gz SEED.manifest.json");
}
mkdirSync(outputDirectory, { recursive: true });
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const sha = file => digest(readFileSync(file));
const proof = "docs/operational-value/proof/artifacts-summary";
const module = "docs/operational-value/proof/functions/artifacts-summary.mjs";
const cutoff = "2026-10-18T15:00:12Z";
const prospectiveEnd = "2026-10-19T11:17:25Z";
if (compilationLog) {
  writeJsonArchive(`${proof}/compilation.json.gz`, {
    command: "npm run compile",
    stdoutAndStderr: readFileSync(compilationLog, "utf8"),
    sha256: sha(compilationLog),
  });
}
const verifyArgs = [".github/skills/add-operational-value/scripts/verify-value-function.mjs", "--collector", module];
const evaluateArgs = (end, output) => [
  ".github/skills/add-operational-value/scripts/evaluate.mjs", "--end", end,
  "--output-dir", output, "--function", module, "--no-runs", "github/gh-aw", "artifacts-summary",
];
const run = (args, cwd = root) => {
  const result = spawnSync(process.execPath, args, {
    cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
  });
  if (result.error) throw result.error;
  return { executable: process.execPath, args, status: result.status,
    stdout: result.stdout, stderr: result.stderr };
};
const baseline = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
if (baseline.status !== 0) throw new Error(baseline.stderr);
const seed = JSON.parse(readFileSync(seedManifest));
if (sha(seedArchive) !== "b30a55ef9a389bbce4500270bfdac715c87bbd9cef68e3463e9661de873ef835"
  || sha(seedManifest) !== "e15c42d73b26ceb2cc560378f25a28155bc5454ef929e861ffd9bacc57bf09fd") {
  throw new Error("Portable dependency seed identity mismatch");
}
for (const file of seed.files) {
  if (sha(file.path) !== file.sha256) throw new Error(`Dependency changed: ${file.path}`);
}
const verification = run(verifyArgs);
if (verification.status !== 0) throw new Error(JSON.stringify(verification));
const focusedTests = run(["--test", "tests/unit/operational-value-artifacts-summary.test.mjs"]);
if (focusedTests.status !== 0) throw new Error(JSON.stringify(focusedTests));
const frozen = run(evaluateArgs(cutoff, `${proof}/frozen`));
if (frozen.status !== 1 || !frozen.stderr.includes(`evaluation end must follow ${definition.adoption.adoptedAt}`)) {
  throw new Error(`Expected genuine historical inapplicability: ${JSON.stringify(frozen)}`);
}
const prospective = run(evaluateArgs(prospectiveEnd, `${proof}/prospective`));
if (prospective.status !== 0) throw new Error(JSON.stringify(prospective));
const [snapshot] = await collectBatch([{
  windowStart: "2026-09-18T15:00:12Z", windowEnd: cutoff, observedAt: cutoff,
}]);
const acquisition = readJson(`${proof}/acquisition.json.gz`);
const runMetadata = acquisition.retainedRunMetadata.rows[0];
const assessment = {
  schemaVersion: 1, workflow: "artifacts-summary", repository: "github/gh-aw",
  frozenCutoff: cutoff, sourceRevision: definition.nativeSourceRevision,
  contractActivation: definition.adoption.adoptedAt, prospectiveEndpoint: prospectiveEnd,
  historical: { status: "inapplicable", reason: frozen.stderr.trim(), snapshot,
    scores: Object.fromEntries(definition.metrics.map(metric => [metric.id, scoreMetric(metric.id, snapshot.evidence)])),
    adoptionCandidate: { commit: "ef37eeea0258edb874145caa6113073d32d98fdc",
      parent: "a49aad11e544880f9d4fb5f7559d0475b23e3224",
      parentWorkflowAndCompiledAbsent: true, sourceContentAvailable: false,
      missingEndpoints: [
        "repos/github/gh-aw/git/blobs/1eb9d5e706a5d7753b44b90c5e2716c1e69bba01",
        "repos/github/gh-aw/git/blobs/c88ce17237c43fbac262baec9dc133de61d98b8d",
      ] } },
  discovery: { ...acquisition.history, directCandidates: acquisition.discovery.directCandidates,
    closureEntities: acquisition.discovery.entities.length, absentReferences: acquisition.discovery.absentReferences,
    interpretation: acquisition.discovery.interpretation },
  nativePartialFacts: { kind: "retained-acquisition-metadata-not-inventory-accuracy",
    runId: runMetadata.run.id, listedArtifacts: runMetadata.artifacts.items.length,
    listedBytes: runMetadata.artifacts.items.reduce((total, item) => total + item.sizeBytes, 0),
    limitation: "One run, not the repository population. Original raw API response bytes and payloads were not preserved in the supplied seed." },
  readiness: {
    implementation: "schema3 function, native original-byte decoder and independent inventory reconciliation implemented",
    nativeEvidence: "not-ready; no original report bodies or independent full inventory pages",
    standardCollector: "passed",
    frozenStandardEvaluation: "actual inapplicability rejection preserved",
    prospectiveEvaluation: "generated; all native metrics unavailable, not an accepted measurement",
    plot: "portable missingness plot generated; not a measured-value plot",
    historicalFunctionApplicability: "unknown; contemporaneous source blobs missing",
    fullGoal: "unknown; inventory proof absent and narrative/retention/optimization safeguards unmeasured",
    attribution: "not-ready; markers alone do not prove creation; no protected original delivery/Claim receipts",
    costs: "unmeasured",
    keepDecision: "not-rated; no agreed keep bar",
    lint: existsSync("node_modules/.bin/eslint") ? "available" : "unavailable; not installed by assignment",
    typecheck: existsSync("node_modules/.bin/tsc") ? "available" : "unavailable; not installed by assignment",
  },
  compilation: existsSync(`${proof}/compilation.json.gz`) ? readJson(`${proof}/compilation.json.gz`) : null,
  blockers: [
    "Contemporaneous original report content and assigned report_date for all11 candidates; current metadata is not backdated.",
    "Repository-wide independently preserved Actions workflow inventory, bounded thirty-day run pages, and artifact pages for every non-cancelled run; complete pagination and original JSON bytes.",
    "Discussions inventory/readbacks, which supplied production issue/PR history explicitly excludes.",
    "Exact historical source blobs and imports/compiled era to establish applicability before prospective activation.",
    "Independent publication/run/head/Claim identity and original-content binding for workflow-linked delivery, not required for narrower native inventory facts.",
  ],
  reusableSkillImprovement: {
    rule: "For inventory/report goals, distinguish the discovery instrument's entity types from the workflow's output types before interpreting an empty result. A complete issues/PR traversal excludes Discussions and says nothing about Discussion delivery. Reconcile original per-item bytes and coverage independently; preserve known workflow-row subtotals without making full repository coverage or strong attribution prerequisites for those subtotals.",
    evidence: "artifacts-summary declares create-discussion; the supplied346-partition history explicitly excludes Discussions and contains11 issue-marker candidates with no native inventory receipts.",
    proposedOnly: "No global skill or portfolio files edited by this assignment.",
  },
  responses: { verification, focusedTests, frozen, prospective },
};
writeJsonArchive(`${proof}/assessment.json`, assessment, { maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512 });

const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const file = path.join(directory, entry.name);
  if (entry.isSymbolicLink()) throw new Error(`Symlink in owned evidence: ${file}`);
  return entry.isDirectory() ? walk(file) : [file];
});
const owned = () => [module, ...walk(proof), "scripts/collect-artifacts-summary.mjs",
  "scripts/native-artifacts-summary.mjs", "scripts/package-artifacts-summary.mjs",
  "tests/unit/operational-value-artifacts-summary.test.mjs"].sort();
const archive = path.join(outputDirectory, "artifacts-summary-owned.tar.gz");
const manifestPath = path.join(outputDirectory, "artifacts-summary-owned.manifest.json");
const pack = () => {
  const files = owned();
  for (const file of files) {
    if (statSync(file).size > 256 * 1024) throw new Error(`Oversized owned member: ${file}`);
    if (file.endsWith(".mjs") && readFileSync(file, "utf8").split("\n").length > 3000) {
      throw new Error(`Oversized executable module: ${file}`);
    }
  }
  const tar = spawnSync("tar", ["-czf", archive, ...files], { cwd: root, encoding: "utf8" });
  if (tar.status !== 0) throw new Error(tar.stderr);
  writeFileSync(manifestPath, `${JSON.stringify({
    schemaVersion: 1, archive, archiveSha256: sha(archive), baseline: baseline.stdout.trim(),
    seedArchiveSha256: sha(seedArchive), seedManifestSha256: sha(seedManifest),
    files: files.map(file => ({ path: file, bytes: statSync(file).size, sha256: sha(file) })),
  }, null, 2)}\n`);
};
pack();
const temporary = mkdtempSync(path.join(outputDirectory, "artifacts-summary-replay-"));
const replay = { baseline: baseline.stdout.trim(), sharedEvidenceOrCacheReads: false, dependencyMembersVerified: 0 };
try {
  const execute = (command, args) => {
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`${command}: ${result.stderr}`);
  };
  const baselineTar = path.join(temporary, "baseline.tar");
  execute("git", ["archive", "--format=tar", `--output=${baselineTar}`, "HEAD"]);
  const checkout = path.join(temporary, "checkout");
  mkdirSync(checkout);
  execute("tar", ["-xf", baselineTar, "-C", checkout]);
  execute("tar", ["-xzf", seedArchive, "-C", checkout]);
  for (const file of seed.files) {
    if (sha(path.join(checkout, file.path)) !== file.sha256) throw new Error("Isolated dependency replay mismatch");
    replay.dependencyMembersVerified++;
  }
  execute("tar", ["-xzf", archive, "-C", checkout]);
  for (const file of JSON.parse(readFileSync(manifestPath)).files) {
    if (sha(path.join(checkout, file.path)) !== file.sha256) throw new Error("Isolated owned replay mismatch");
  }
  replay.verification = run(verifyArgs, checkout);
  replay.focusedTests = run(["--test", "tests/unit/operational-value-artifacts-summary.test.mjs"], checkout);
  replay.frozen = run(evaluateArgs(cutoff, `${proof}/replay-frozen`), checkout);
  replay.prospective = run(evaluateArgs(prospectiveEnd, `${proof}/replay-prospective`), checkout);
  if (replay.verification.status !== 0 || replay.focusedTests.status !== 0
    || replay.prospective.status !== 0 || replay.frozen.status !== frozen.status
    || replay.frozen.stderr !== frozen.stderr) throw new Error(JSON.stringify(replay));
  const original = readJson(`${proof}/prospective/github-gh-aw/artifacts-summary-timeline.json`);
  const reproduced = readJson(path.join(checkout, `${proof}/replay-prospective/github-gh-aw/artifacts-summary-timeline.json`));
  if (JSON.stringify(original.snapshots) !== JSON.stringify(reproduced.snapshots)
    || JSON.stringify(original.valueReview) !== JSON.stringify(reproduced.valueReview)) {
    throw new Error("Independent replay changed native evidence, scores or review");
  }
  replay.nativeEvidenceScoresAndReviewIdentical = true;
  replay.reportIdentities = walk(path.join(checkout, `${proof}/replay-prospective`)).map(file => ({
    path: path.relative(checkout, file), bytes: statSync(file).size, sha256: sha(file),
  }));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
writeJsonArchive(`${proof}/replay.json`, replay, { maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512 });
pack();
console.log(JSON.stringify({ archive, archiveSha256: sha(archive),
  manifest: manifestPath, manifestSha256: sha(manifestPath),
  replay: "passed; isolated baseline + all32 seed members + owned-only package; no shared history/cache",
  readiness: assessment.readiness }, null, 2));
