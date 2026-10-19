import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readJson } from "../.github/skills/add-operational-value/scripts/common.mjs";
import { definition, scoreMetric } from "../docs/operational-value/proof/functions/daily-model-resolution.mjs";

const root = "docs/operational-value/proof/daily-model-resolution";
const module = "docs/operational-value/proof/functions/daily-model-resolution.mjs";
const sha256 = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const log = [];
const run = args => {
  const output = execFileSync(process.execPath, args, { encoding: "utf8" });
  log.push({ command: [process.execPath, ...args], output, status: "passed" });
};
run(["--test", "tests/unit/daily-model-resolution-source.test.mjs",
  "tests/unit/daily-model-resolution.test.mjs"]);
run([".github/skills/add-operational-value/scripts/verify-value-function.mjs", "--collector", module]);
const ownedScripts = readdirSync("scripts").filter(file => /^daily-model-resolution.*\.mjs$/.test(file));
for (const file of [module, ...ownedScripts.map(file => `scripts/${file}`),
  "tests/unit/daily-model-resolution-source.test.mjs", "tests/unit/daily-model-resolution.test.mjs"]) {
  run(["--check", file]);
}
run([".github/skills/add-operational-value/scripts/evaluate.mjs",
  "--end", "2026-10-18T15:00:12Z", "--output-dir", `${root}/reports`,
  "--function", module, "--no-runs", "github/gh-aw", "daily-model-resolution"]);
const reportRoot = `${root}/reports/github-gh-aw`;
const timelineFile = `${reportRoot}/daily-model-resolution-timeline.json`;
const timeline = readJson(timelineFile);
assert.equal(timeline.valueFunction.sha256, sha256(module));
assert.equal(timeline.snapshots.length, 59);
for (const [index, snapshot] of timeline.snapshots.entries()) {
  assert.equal(snapshot.evidence.coverageStatus, "missing");
  for (const metric of definition.metrics) {
    assert.equal(snapshot.metrics[metric.id], null);
    assert.equal(scoreMetric(metric.id, snapshot.evidence), null);
  }
  if (index) assert.equal(timeline.snapshots[index - 1].window.endAt, snapshot.window.startAt);
}
const originalRoot = `${root}/predecessors/24b6e9a21c36cebfa48d41b96fb9f8c5ff992e893227b905a5007bcc673d5b41`;
assert.equal(sha256(`${originalRoot}/daily-model-resolution.mjs`),
  "24b6e9a21c36cebfa48d41b96fb9f8c5ff992e893227b905a5007bcc673d5b41");
const files = directory => readdirSync(directory).flatMap(file => {
  const item = path.join(directory, file);
  return statSync(item).isDirectory() ? files(item) : [item];
});
for (const file of [...files(root), module]) {
  assert.ok(statSync(file).size <= 256 * 1024, `Oversized member: ${file}`);
}
writeFileSync(`${root}/verification.json`, `${JSON.stringify({
  schemaVersion: 1, endpoint: "2026-10-18T15:00:12Z", functionSha256: sha256(module),
  sourceSha256: definition.sourceProfile.sha256,
  compiledSourceSha256: definition.sourceProfile.compiledSha256,
  timelineSha256: sha256(timelineFile), snapshotCount: timeline.snapshots.length,
  numericNativeObservations: 0, nativeEvidenceReady: false, nativePlotReady: false,
  lineage: readJson(`${root}/lineage-summary.json`),
  reportHashes: Object.fromEntries(files(reportRoot).map(file => [path.relative(root, file), sha256(file)])),
  commands: log,
  lint: { status: "blocked", reason: "ESLint is not installed in this worktree; dependency installation is prohibited." },
  typecheck: { status: "blocked", reason: "TypeScript is not installed. Owned plain ECMAScript files passed node --check, which is not a type-check." },
  compile: { status: "not-run", reason: "Only evaluator-generated Markdown changed. No editable workflow source changed; offline scope forbids remote import acquisition or workflow execution." },
  acquisition: "Only explicitly delivered central source packet read locally; no network requests made by this session.",
}, null, 2)}\n`);
console.log(`Verified ${timeline.snapshots.length} missing assessments, original definition retention and owned file budgets.`);
