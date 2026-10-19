import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as relocated from "../functions/daily-model-inventory.mjs";
import { readJsonArchive, writeJsonArchive } from "../../../../.github/skills/add-operational-value/scripts/json-archive.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "../../../..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const predecessor = readJsonArchive(path.join(directory, "pre-relocation.json.gz"));
const originalManifest = JSON.parse(predecessor.manifestOriginal);
assert.equal(hash(predecessor.manifestOriginal), predecessor.manifestSha256);
assert.equal(predecessor.files.length, 20);
assert.equal(originalManifest.files.length, 20);
const originals = new Map(predecessor.files.map(file => {
  const bytes = Buffer.from(file.base64, "base64");
  const expected = originalManifest.files.find(entry => entry.path === file.path);
  assert.ok(expected);
  assert.equal(bytes.length, expected.bytes);
  assert.equal(hash(bytes), expected.sha256);
  assert.equal(file.sha256, expected.sha256);
  assert.ok(file.path.startsWith("docs/operational-value/gh-aw-workflows/proof/"));
  assert.ok(!file.path.split("/").includes(".."));
  return [file.path, bytes];
}));
assert.equal(originals.size, 20);
const oldPrefix = "docs/operational-value/gh-aw-workflows/proof/";
const originalModulePath = `${oldPrefix}functions/daily-model-inventory.mjs`;
const relocatedModulePath = "docs/operational-value/proof/functions/daily-model-inventory.mjs";
const originalFunction = originals.get(originalModulePath).toString();
const currentFunction = readFileSync(path.join(root, relocatedModulePath), "utf8");
assert.equal(hash(originalFunction), "9cd92ee723af124ad252dcca90d719244ee89c63c074053540303c60a94c3f45");
assert.equal(originalFunction.replace(
  'from "../../../../../.github/skills/add-operational-value/scripts/json-archive.mjs"',
  'from "../../../../.github/skills/add-operational-value/scripts/json-archive.mjs"',
), currentFunction);
const testPath = "tests/unit/operational-value-daily-model-inventory.test.mjs";
assert.equal(originals.get(`${oldPrefix}daily-model-inventory/native.test.mjs`).toString()
  .replace('from "../functions/daily-model-inventory.mjs"', 'from "../../docs/operational-value/proof/functions/daily-model-inventory.mjs"')
  .replace('from "../../../../../.github/skills/add-operational-value/scripts/common.mjs"',
    'from "../../.github/skills/add-operational-value/scripts/common.mjs"'),
readFileSync(path.join(root, testPath), "utf8"));

const scratch = mkdtempSync(path.join(root, ".aw-model-inventory-equivalence-"));
try {
  for (const [name, bytes] of originals) {
    const target = path.join(scratch, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  symlinkSync(path.join(root, ".github"), path.join(scratch, ".github"), "dir");
  const original = await import(pathToFileURL(path.join(scratch, originalModulePath)));
  assert.deepEqual(original.definition, relocated.definition);
  const request = { windowStart: relocated.definition.adoption.adoptedAt,
    windowEnd: relocated.definition.sourceProfile.cutoff, observedAt: relocated.definition.sourceProfile.cutoff };
  const requests = [
    request,
    { windowStart: "2026-10-18T15:00:12Z", windowEnd: "2026-10-19T15:00:12Z", observedAt: "2026-10-19T15:00:12Z" },
    { windowStart: "2026-05-03T00:00:00Z", windowEnd: "2026-05-04T00:00:00Z", observedAt: "2026-05-04T00:00:00Z" },
  ];
  const oldCollections = await original.collectBatch(requests);
  assert.deepEqual(oldCollections, await relocated.collectBatch(requests));
  const fixtures = relocated.definition.validationExamples;
  for (const metric of relocated.definition.metrics) {
    for (const evidence of Object.values(fixtures)) {
      assert.equal(original.scoreMetric(metric.id, evidence), relocated.scoreMetric(metric.id, evidence));
    }
  }
  assert.deepEqual(await original.collectBatch([request], { inventories: fixtures.targetAttained.inventories }),
    await relocated.collectBatch([request], { inventories: fixtures.targetAttained.inventories }));
  execFileSync(process.execPath, ["--test", path.join(scratch, `${oldPrefix}daily-model-inventory/native.test.mjs`)],
    { cwd: scratch, stdio: "inherit" });
  const originalObservation = JSON.parse(originals.get(`${oldPrefix}daily-model-inventory/native-observation.json`));
  const currentObservation = readJsonArchive(path.join(directory, "native-observation.json"));
  assert.equal(originalObservation.functionSha256, hash(originalFunction));
  assert.equal(currentObservation.functionSha256, hash(currentFunction));
  delete originalObservation.functionSha256;
  delete currentObservation.functionSha256;
  assert.deepEqual(originalObservation, currentObservation);
  const originalTimeline = JSON.parse(originals.get(
    `${oldPrefix}daily-model-inventory/reports/github-gh-aw/daily-model-inventory-timeline.json`));
  const currentTimeline = readJsonArchive(path.join(directory, "reports/github-gh-aw/daily-model-inventory-timeline.json"));
  assert.deepEqual(originalTimeline.snapshots, currentTimeline.snapshots);
  const oldPulse = JSON.parse(originals.get(
    `${oldPrefix}daily-model-inventory/reports/github-gh-aw/daily-model-inventory-pulse.json`));
  const newPulse = readJsonArchive(path.join(directory, "reports/github-gh-aw/daily-model-inventory-pulse.json"));
  delete oldPulse.valueFunctionSha256;
  delete newPulse.valueFunctionSha256;
  assert.deepEqual(oldPulse, newPulse);
  const receipt = {
    schemaVersion: 1, reason: "Ownership-path correction only; no outcome, acceptance or temporal change.",
    originalFunction: { path: originalModulePath, sha256: hash(originalFunction) },
    relocatedFunction: { path: relocatedModulePath, sha256: hash(currentFunction) },
    preservedPackage: { archiveSha256: predecessor.archiveSha256, manifestSha256: predecessor.manifestSha256,
      archive: "pre-relocation.json.gz", originalMembers: originalManifest.files },
    equivalence: {
      functionDifference: "Exactly one relative shared-codec import, pointing to the same helper.",
      definitionIdentical: true, threeCutoffCollectionsIdentical: true, fixtureCollectionsIdentical: true,
      allMetricExamplesIdentical: true, originalObservationsIdenticalExceptPathOnlyFunctionIdentity: true,
      reportSnapshotsIdentical: true, pulseIdenticalExceptPathOnlyFunctionIdentity: true,
      focusedTestsDifference: "Only two imports; all 18 tests preserved under normal tests/unit/*.test.mjs discovery.",
      originalFocusedTestsPassed: 18,
    },
  };
  writeJsonArchive(path.join(directory, "relocation-equivalence.json"), receipt);
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
