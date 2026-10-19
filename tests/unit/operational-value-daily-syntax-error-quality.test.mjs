import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  collectBatch, definition, scoreMetric,
} from "../../docs/operational-value/proof/functions/daily-syntax-error-quality.mjs";
import {
  assessCase, cutoff, decodeBuildInfo, decodeCompileResult, decodeDiagnostic, decodeMutation,
  profileStart, revision, summarizeCases, validateNativeSchema,
} from "../../docs/operational-value/proof/daily-syntax-error-quality/native-diagnostics.mjs";
import { readJsonArchive } from "../../.github/skills/add-operational-value/scripts/json-archive.mjs";

const root = "docs/operational-value/proof/daily-syntax-error-quality";
const clone = value => structuredClone(value);
const evidence = () => clone(definition.validationExamples.targetAttained);
const nativeCase = () => evidence().nativeCases[0];
const metrics = definition.metrics.map(metric => metric.id);
const changeResult = (item, update) => {
  const rows = JSON.parse(item.originals.afterResult);
  update(rows[0]);
  item.originals.afterResult = JSON.stringify(rows);
  return item;
};

test("schema 3 keeps native partial value separate from usability, delivery and producer judgments", () => {
  assert.equal(definition.schemaVersion, 3);
  assert.equal(definition.metrics.filter(metric => metric.role === "primary").length, 1);
  assert.equal(definition.evaluation.mode, "attainment-only");
  assert.equal(definition.adoption.baselineCommit, null);
  assert.equal(definition.intent.temporalAnchor, "contract-activation");
  for (const metric of definition.metrics) {
    assert.equal(metric.unit, "percent");
    assert.equal(metric.presentation.transform, "identity");
    assert.equal(scoreMetric(metric.id, definition.validationExamples.targetAttained), 100);
    assert.equal(scoreMetric(metric.id, definition.validationExamples.targetMissed), 0);
    assert.equal(scoreMetric(metric.id, definition.validationExamples.missing), null);
    assert.equal(scoreMetric(metric.id, definition.validationExamples.malformed), null);
  }
});

test("decode actual native ValidationResult and ValidationIssue, rejecting report-shaped substitutes", () => {
  const item = nativeCase();
  assert.equal(decodeCompileResult(item.originals.beforeResult, item.workflow).valid, true);
  assert.equal(decodeCompileResult(item.originals.afterResult, item.workflow).errors[0].type, "parse_error");
  for (const raw of ["", "not json", "null", "{}", '[{"valid":true}]', '{"quality":100,"accepted":true}']) {
    assert.equal(decodeCompileResult(raw, item.workflow), null);
  }
  assert.equal(decodeCompileResult(item.originals.beforeResult, "../test.md"), null);
  assert.equal(decodeCompileResult(item.originals.beforeResult, "wrong.md"), null);
  const rows = JSON.parse(item.originals.beforeResult);
  rows[0].warnings.push({ type: "shared_workflow", message: "Skipped" });
  assert.equal(decodeCompileResult(JSON.stringify(rows), item.workflow), null);
  rows[0].warnings = [];
  rows[0].errors = [{ type: "parse_error", message: "failed" }];
  assert.equal(decodeCompileResult(JSON.stringify(rows), item.workflow), null);
});

test("decode original Go build-info bytes instead of trusting a compilerRevision flag", () => {
  const item = nativeCase();
  assert.deepEqual(decodeBuildInfo(item.originals.compilerBuildInfo), { revision });
  for (const replacement of ["vcs.modified=true", "vcs.revision=0000000000000000000000000000000000000000"]) {
    const copy = clone(item);
    copy.originals.compilerBuildInfo = copy.originals.compilerBuildInfo.replace(
      replacement.startsWith("vcs.modified") ? "vcs.modified=false" : `vcs.revision=${revision}`, replacement,
    );
    copy.compilerRevision = revision;
    copy.trusted = true;
    assert.equal(assessCase(copy), null);
  }
  assert.equal(decodeBuildInfo(`${item.originals.compilerBuildInfo}\tbuild\tvcs.modified=false\n`), null);
  delete item.originals.compilerBuildInfo;
  item.compilerRevision = revision;
  assert.equal(assessCase(item), null);
});

test("mutation oracle verifies an entire native-accepted original and exactly one invalid field change", () => {
  const item = nativeCase();
  assert.equal(decodeMutation(item.originals.beforeInput, item.originals.afterInput).line, 3);
  for (const [before, after] of [
    ["engine: copilot", "engine: 123"],
    [item.originals.beforeInput, item.originals.beforeInput],
    [item.originals.beforeInput, item.originals.afterInput.replace("Check syntax.", "Changed prompt.")],
    [item.originals.beforeInput.replace("on:", "not-on:"), item.originals.afterInput.replace("on:", "not-on:")],
    [item.originals.beforeInput.replace("engine: copilot", "engine: 'copilot'"), item.originals.afterInput],
    [item.originals.beforeInput.replace("---\n", "---\nengine: claude\n"),
      item.originals.afterInput.replace("---\n", "---\nengine: claude\n")],
    [item.originals.beforeInput.replace("on:", "on: &alias\nx:"), item.originals.afterInput.replace("on:", "on: &alias\nx:")],
  ]) assert.equal(decodeMutation(before, after), null);
  item.originals.beforeResult = item.originals.afterResult;
  assert.equal(assessCase(item), null);
});

test("native diagnostic decoder matches exact file, line and key column, not format presence", () => {
  assert.deepEqual(decodeDiagnostic("test.md:3:1: error: wrong type\n").line, 3);
  assert.equal(decodeDiagnostic("test.md:0:1: error: wrong"), null);
  assert.equal(decodeDiagnostic("test.md:3:0: error: wrong"), null);
  assert.equal(decodeDiagnostic("summary test.md:3:1: error: wrong").file, "summary test.md");
  for (const location of ["wrong.md:3:1", "test.md:1:1", "test.md:3:8", "test.md:3:12"]) {
    const item = changeResult(nativeCase(), row => {
      row.errors[0].message = `${location}: error: wrong type\nExample:\nengine: copilot\n`;
    });
    assert.equal(assessCase(item).correctLocation, 0);
    assert.equal(assessCase(item).verifiedRepair, 0);
  }
  const item = changeResult(nativeCase(), row => {
    row.errors[0].message = "\x1b[31mtest.md:3:1:\x1b[0m error: wrong type\n";
  });
  assert.equal(assessCase(item).correctLocation, 1);
  assert.equal(assessCase(item).verifiedRepair, 0);
  for (const column of [1, 6, 9, 11]) {
    const atToken = changeResult(nativeCase(), row => {
      row.errors[0].message = `./test.md:3:${column}: error: wrong type\n`;
    });
    assert.equal(assessCase(atToken).correctLocation, 1);
  }
});

test("a repair must restore the exact native-accepted original; words like hint or Example are insufficient", () => {
  for (const [suffix, expected] of [
    ["Example:\nengine: copilot\n", 1],
    ["Did you mean 'copilot'?\n", 1],
    ["Example:\nengine: claude\n", 0],
    ["hint: try changing engine\n", 0],
    ["Example: engine: copilot\n", 0],
    ["Example:\nengine: copilot\nExample:\nengine: claude\n", 0],
    ["Did you mean 'copilot'?\nExample:\nengine: copilot\n", 0],
  ]) {
    const item = changeResult(nativeCase(), row => {
      row.errors[0].message = `test.md:3:1: error: wrong type\n${suffix}`;
    });
    assert.equal(assessCase(item).correctLocation, 1);
    assert.equal(assessCase(item).verifiedRepair, expected);
  }
});

test("missing native originals are not a measured zero; a complete wrong location is zero", () => {
  for (const field of Object.keys(nativeCase().originals)) {
    const item = nativeCase();
    delete item.originals[field];
    assert.equal(assessCase(item), null);
  }
  const item = changeResult(nativeCase(), row => { row.errors[0].message = "Unlocated native parse failure"; });
  assert.equal(assessCase(item).correctLocation, 0);
  const wrong = evidence();
  wrong.nativeCases[0] = item;
  assert.equal(scoreMetric(metrics[0], wrong), 0);
  const incomplete = evidence();
  delete incomplete.nativeCases[0].originals.afterResult;
  assert.equal(scoreMetric(metrics[0], incomplete), null);
});

test("scoring reconstructs native counts and ignores all caller-supplied acceptance and score flags", () => {
  const forged = { ...evidence(), accepted: true, trusted: true, eligibleCount: 1000,
    correctLocations: 0, verifiedRepairs: 0, nativeFacetStatus: "missing", value: 9001 };
  assert.equal(scoreMetric(metrics[0], forged), 100);
  delete forged.nativeCases;
  assert.equal(scoreMetric(metrics[0], forged), null);
  const malformed = evidence();
  malformed.nativeCases.push(clone(malformed.nativeCases[0]));
  assert.equal(scoreMetric(metrics[0], malformed), null);
  assert.equal(scoreMetric("unknown", evidence()), null);
});

test("equal native units can disagree; location coverage never establishes a useful repair", () => {
  const item = evidence();
  item.nativeCases[0] = changeResult(item.nativeCases[0], row => {
    row.errors[0].message = "test.md:3:1: error: wrong type\n";
  });
  assert.equal(scoreMetric(metrics[0], item), 100);
  assert.equal(scoreMetric(metrics[1], item), 0);
});

test("inclusive/exclusive disjoint periods, source-era bounds and duplicate handling", () => {
  const item = nativeCase();
  const left = summarizeCases([item], profileStart, item.completedAt, cutoff);
  const right = summarizeCases([item], item.completedAt, cutoff, cutoff);
  assert.equal(left.eligibleCount, 0);
  assert.equal(right.eligibleCount, 1);
  assert.throws(() => summarizeCases([item, item], profileStart, cutoff, cutoff), /Repeated/);
  const older = nativeCase();
  older.completedAt = "2026-10-17T10:00:00Z";
  assert.equal(assessCase(older), null);
  const future = nativeCase();
  future.completedAt = "2026-10-19T10:00:00Z";
  assert.equal(assessCase(future), null);
  for (const patch of [
    { windowStart: "2026-10-17T00:00:00Z" }, { windowEnd: "2026-10-19T00:00:00Z" },
    { observedAt: profileStart }, { windowEnd: profileStart },
  ]) assert.equal(scoreMetric(metrics[0], { ...evidence(), ...patch }), null);
});

test("batch collector reads actual empty production evidence, preserving null and readiness", async () => {
  const requests = [
    { windowStart: profileStart, windowEnd: cutoff, observedAt: cutoff },
    { windowStart: "2026-10-17T00:00:00Z", windowEnd: profileStart, observedAt: cutoff },
  ];
  const result = await collectBatch(requests);
  assert.equal(result.length, 2);
  for (const [index, collection] of result.entries()) {
    assert.equal(collection.evidence.windowStart, requests[index].windowStart);
    assert.equal(collection.evidence.coverageStatus, "missing");
    assert.equal(collection.evidence.fullUsability.value, null);
    assert.equal(collection.evidence.deliveredImprovement.value, null);
    assert.equal(collection.evidence.nativeCases.length, 0);
    assert.ok(collection.evidence.missingReason);
    assert.ok(collection.provenance.length);
    for (const id of metrics) assert.equal(scoreMetric(id, collection.evidence), null);
  }
  await assert.rejects(collectBatch([{ ...requests[0], repository: "unrelated/repo" }]), /Unsupported/);
  await assert.rejects(collectBatch([{ ...requests[0], windowEnd: "bad" }]), /Invalid/);
});

test("all original source bytes and Git blob identities replay intact, never expected outputs as observations", () => {
  const manifest = readJsonArchive(`${root}/sources.json`);
  assert.equal(manifest.files.length, 32);
  assert.ok(manifest.missing.some(item => item.path.endsWith(".lock.yml")));
  for (const item of manifest.files) {
    const source = readJsonArchive(path.join(root, item.file));
    const bytes = Buffer.from(source.content);
    assert.equal(bytes.length, source.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), item.sha256);
    assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), item.gitBlob);
    if (item.path.endsWith("main_workflow_schema.json")) validateNativeSchema(source.content);
  }
  assert.equal(readJsonArchive(`${root}/native-observations.json`).cases.length, 0);
  const discovery = readJsonArchive(`${root}/discovery.json.gz`);
  assert.deepEqual(discovery.fullInputVerified, { partitions: 346, entities: 58048 });
  assert.equal(discovery.candidates.length, 69);
  assert.equal(discovery.repositoryId, 1036865607);
});

test("archive members remain bounded and executable modules remain under 3000 lines", () => {
  const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
  for (const file of walk(root)) {
    assert.ok(statSync(file).size <= 256 * 1024, `${file} exceeds member bound`);
    if (file.endsWith(".mjs")) assert.ok(readFileSync(file, "utf8").split("\n").length <= 3000);
  }
});
