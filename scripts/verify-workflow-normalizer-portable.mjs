import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { definition, collectBatch } from "../docs/operational-value/proof/functions/workflow-normalizer.mjs";
import { sha256 } from "../docs/operational-value/proof/workflow-normalizer/native.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ownedDirectory = "docs/operational-value/proof/workflow-normalizer";
const modulePath = "docs/operational-value/proof/functions/workflow-normalizer.mjs";
const testPath = "tests/unit/operational-value-workflow-normalizer.test.mjs";
const skill = ".github/skills/add-operational-value/scripts";
const reportDirectory = `${ownedDirectory}/prospective-evaluation/github-gh-aw`;
const [outputDirectory, seedArchive, seedManifest] = process.argv.slice(2).map(file => path.resolve(file));
if (!outputDirectory || !seedArchive || !seedManifest || process.argv.length !== 5) {
  throw new Error("usage: verify-workflow-normalizer-portable.mjs OUTPUT-DIRECTORY SEED-ARCHIVE SEED-MANIFEST");
}
const seeds = JSON.parse(readFileSync(seedManifest, "utf8"));
assert.equal(sha256(readFileSync(seedArchive)), "b30a55ef9a389bbce4500270bfdac715c87bbd9cef68e3463e9661de873ef835");
assert.equal(sha256(readFileSync(seedManifest)), "e15c42d73b26ceb2cc560378f25a28155bc5454ef929e861ffd9bacc57bf09fd");
assert.equal(seeds.files.length, 32);

function run(command, args, cwd = root, expected = 0) {
  const result = spawnSync(command, args, {
    cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
    timeout: 120000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, expected, result.stderr || result.stdout);
  return { command: [command === process.execPath ? "node" : command, ...args],
    exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}

const tests = run(process.execPath, ["--test", testPath]);
const collector = run(process.execPath, [`${skill}/verify-value-function.mjs`, "--collector", modulePath]);
const frozen = run(process.execPath, [`${skill}/evaluate.mjs`, "--end", definition.nativeContract.cutoff,
  "--function", modulePath, "--output-dir", `${ownedDirectory}/frozen-evaluation`, "--no-runs",
  "github/gh-aw", "workflow-normalizer"], root, 1);
assert.match(frozen.stderr, /evaluation end must follow 2026-10-19T10:31:43Z/);
const timeline = readJsonArchive(path.join(root, reportDirectory, "workflow-normalizer-timeline.json"));
const endpoint = timeline.window.endAt;
const reports = readdirSync(path.join(root, reportDirectory)).sort().map(file => {
  const relative = `${reportDirectory}/${file}`;
  return { path: relative, sha256: sha256(readFileSync(path.join(root, relative))) };
});
assert.equal(timeline.valueFunction.sha256, sha256(readFileSync(path.join(root, modulePath))));
assert.equal(timeline.snapshots.length, 1);
assert.equal(timeline.snapshots[0].metrics["native-style-repaired-reports"], null);

const identity = file => ({ path: file, sha256: sha256(readFileSync(path.join(root, file))) });
const handoffFile = path.join(root, ownedDirectory, "handoff.json");
const handoff = {
  schemaVersion: 1, workflow: "github/gh-aw:workflow-normalizer",
  status: "blocked-native-producer-not-acquired",
  readiness: definition.nativeContract.readiness,
  sourceRevision: definition.nativeContract.revision,
  workflowBlob: definition.nativeContract.workflowBlob,
  frozenCutoff: definition.nativeContract.cutoff,
  contractActivation: definition.adoption.adoptedAt,
  independentNativeFacts: {
    originalSourceFiles: 6, sourceBytes: "complete, Git-blob and SHA256 checked",
    sharedHistoryPartitions: 346, sharedHistoryEntities: 58048,
    selectedDiscoveryCandidates: 267,
    reportBodies: "unacquired", activeReportingCohort: "unacquired",
    acceptedNativeImprovements: null, contribution: null, fullAcceptance: null,
  },
  collector: identity(`${skill}/verify-value-function.mjs`),
  sourceCollector: identity("scripts/collect-workflow-normalizer-native.mjs"),
  module: identity(modulePath),
  checker: identity(`${ownedDirectory}/native.mjs`),
  sourceArchive: identity(`${ownedDirectory}/native-scope.json.gz`),
  historyReader: identity(`${skill}/collect-output-history.mjs`),
  evaluator: identity(`${skill}/evaluate.mjs`),
  codec: identity(`${skill}/json-archive.mjs`),
  validation: {
    focusedTests: tests, actualStandardCollector: collector,
    frozenEvaluation: { ...frozen, status: "correctly-rejected-current-only-profile",
      report: null, reason: "Frozen endpoint precedes contract activation; no backdating." },
    syntaxChecks: "node --check passed for module, native checker and source collector",
    sizeCheck: "node scripts/check-file-sizes.mjs passed",
    compile: "npm run compile: 71 succeeded, 2 warnings; no emitted locks",
    eslint: "blocked: node_modules/eslint/bin/eslint.js missing; no installation/network authorized",
    typecheck: "blocked: node_modules/typescript/bin/tsc missing; no installation/network authorized",
  },
  prospectiveOnly: {
    endpoint, reports,
    status: "unavailable-native-measurement-not-a-measured-zero",
    observation: { eligibleCount: null, nativeStyleRepairs: null, fullAcceptance: null, contribution: null },
    decision: "not-rated", costs: "not-measured",
    warning: "Post-cutoff diagnostic pipeline replay, not frozen historical results or a completed native measurement.",
  },
  exactMissingScope: collectBatch([{
    windowStart: definition.adoption.adoptedAt, windowEnd: endpoint, observedAt: endpoint,
  }])[0].evidence.requiredInputs,
  limitations: [
    "Closed partial report-style syntax checker only. The production scorer has no protected native report input bindings; only explicitly sealed synthetic fixtures can score numerically.",
    "No protected producer protocol or readability standard has been invented. A new independent producer/source scope and reviewed input bindings are needed before production numbers.",
    "Prompt instruction compliance is not report readability. Reports in comments/Discussions and other Markdown forms need native decoders before a complete-scope claim.",
    "History remains unacquired/unknown, not exhausted. No adoption date, keep bar, utility, agent score, causation or reader-study claim is inferred.",
  ],
};
writeFileSync(handoffFile, `${JSON.stringify(handoff, null, 2)}\n`);

function walk(relative) {
  const target = path.join(root, relative);
  const stat = lstatSync(target);
  if (stat.isDirectory()) return readdirSync(target).sort().flatMap(file => walk(`${relative}/${file}`));
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `Non-regular owned artifact: ${relative}`);
  assert.ok(stat.size <= 256 * 1024, `Oversize owned member: ${relative}`);
  if (relative.endsWith(".mjs")) assert.ok(readFileSync(target, "utf8").split("\n").length <= 3000);
  return [relative];
}
const ownedFiles = () => [
  modulePath, ...walk(ownedDirectory),
  ...readdirSync(path.join(root, "scripts")).filter(file => /workflow-normalizer.*\.mjs$/.test(file)).map(file => `scripts/${file}`),
  testPath,
].sort();
mkdirSync(outputDirectory, { recursive: true });
const archive = path.join(outputDirectory, "workflow-normalizer-owned.tar.gz");
const manifest = path.join(outputDirectory, "workflow-normalizer-owned.manifest.json");
const pack = () => {
  const files = ownedFiles();
  assert.ok(files.every(file => !seeds.files.some(seed => seed.path === file)));
  for (const file of files) walk(file);
  run("tar", ["-czf", archive, ...files]);
  const members = run("tar", ["-tzf", archive]).stdout.trim().split("\n").sort();
  assert.deepEqual(members, files);
  return files;
};
let files = pack();
const replay = mkdtempSync(path.join(root, ".normalizer-portable-replay-"));
try {
  const baseline = path.join(replay, "baseline.tar");
  run("git", ["archive", "--format=tar", `--output=${baseline}`, "HEAD"]);
  run("tar", ["-xf", baseline, "-C", replay]);
  rmSync(baseline);
  assert.deepEqual(run("tar", ["-tzf", seedArchive]).stdout.trim().split("\n").sort(), seeds.files.map(file => file.path).sort());
  run("tar", ["-xzf", seedArchive, "-C", replay]);
  for (const seed of seeds.files) {
    const bytes = readFileSync(path.join(replay, seed.path));
    assert.equal(bytes.length, seed.bytes);
    assert.equal(sha256(bytes), seed.sha256);
  }
  run("tar", ["-xzf", archive, "-C", replay]);
  for (const file of files) assert.equal(sha256(readFileSync(path.join(replay, file))), sha256(readFileSync(path.join(root, file))));
  const replayTests = run(process.execPath, ["--test", testPath], replay);
  const replayCollector = run(process.execPath, [`${skill}/verify-value-function.mjs`, "--collector", modulePath], replay);
  const replayOutput = ".normalizer-prospective-replay";
  run(process.execPath, [`${skill}/evaluate.mjs`, "--end", endpoint, "--function", modulePath,
    "--output-dir", replayOutput, "--no-runs", "github/gh-aw", "workflow-normalizer"], replay);
  const replayTimeline = readJsonArchive(path.join(replay, replayOutput, "github-gh-aw/workflow-normalizer-timeline.json"));
  assert.deepEqual(replayTimeline.valueFunction, timeline.valueFunction);
  assert.deepEqual(replayTimeline.snapshots, timeline.snapshots);
  assert.deepEqual(replayTimeline.valueReview, timeline.valueReview);
  handoff.independentReplay = {
    status: "passed",
    seedMembersVerified: 32,
    focusedTestsExitCode: replayTests.exitCode, standardCollectorExitCode: replayCollector.exitCode,
    standardEvaluatorEndpoint: endpoint,
    identical: ["frozen definition", "module fingerprint", "complete snapshots/evidence/provenance", "native metrics", "value review"],
    caveat: "Standard report generation timestamps can differ; prospective unavailable values are not native improvements.",
  };
  writeFileSync(handoffFile, `${JSON.stringify(handoff, null, 2)}\n`);
  files = pack();
  run("tar", ["-xzf", archive, "-C", replay]);
  for (const file of files) assert.equal(sha256(readFileSync(path.join(replay, file))), sha256(readFileSync(path.join(root, file))));
  run(process.execPath, [`${skill}/verify-value-function.mjs`, "--collector", modulePath], replay);
  const result = {
    schemaVersion: 1, kind: "owned-only-workflow-normalizer-handoff",
    archive: path.basename(archive), archiveSha256: sha256(readFileSync(archive)),
    seedDependency: { archiveSha256: seeds.archiveSha256,
      manifestSha256: sha256(readFileSync(seedManifest)), membersVerified: 32, owned: false },
    baselineCommit: run("git", ["rev-parse", "HEAD"]).stdout.trim(),
    status: handoff.status, replay: handoff.independentReplay,
    files: files.map(file => ({ path: file, bytes: lstatSync(path.join(root, file)).size,
      sha256: sha256(readFileSync(path.join(root, file))) })),
  };
  writeFileSync(manifest, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ archive, archiveSha256: result.archiveSha256,
    manifest, manifestSha256: sha256(readFileSync(manifest)), ownedFiles: files.length,
    status: result.status, replay: "passed" }));
} finally {
  rmSync(replay, { recursive: true, force: true });
}
