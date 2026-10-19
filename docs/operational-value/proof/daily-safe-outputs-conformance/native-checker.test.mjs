import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readJson } from "../../../../.github/skills/add-operational-value/scripts/common.mjs";
import { readJsonArchive } from "../../../../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { renderPulse } from "../../../../.github/skills/add-operational-value/scripts/render-pulse.mjs";
import { definition, collectBatch, scoreMetric } from "../functions/daily-safe-outputs-conformance.mjs";
import { assess, compare, hash, nativeMatch } from "./native-checker.mjs";
import { verifyBlob } from "./collect.mjs";
import { compareSurviving } from "./compare-v2.mjs";

const home = path.dirname(fileURLToPath(import.meta.url));
const file = "actions/setup/js/native_fixture.cjs";
const source = content => ({ [file]: { content } });

test("native patterns retain exact boundaries, case, and long-file behavior", () => {
  assert.equal(nativeMatch("targetRepository", "\\btargetRepo\\b"), false);
  assert.equal(nativeMatch("targetRepo", "\\btargetRepo\\b"), true);
  assert.equal(nativeMatch("50 LINKS", "50 link", "Ei"), true);
  assert.equal(nativeMatch(`needle\n${"padding\n".repeat(100000)}`, "needle"), true);
});

test("native API-validation ordering is not replaced by presence alone", () => {
  const missing = assess(source("octokit.get();\n"), []).rows.find(row => row.rule === "SEC-002");
  const validated = assess(source("validate();\noctokit.get();\n"), []).rows.find(row => row.rule === "SEC-002");
  assert.equal(missing.status, "fail");
  assert.equal(validated.status, "pass");
});

test("same native finding clears once; waiver, deletion and eligibility escapes do not", () => {
  const before = assess(source("const targetRepo = target;\n"), []);
  const repaired = assess(source("validateTargetRepo(targetRepo);\n"), []);
  assert.equal(compare(before, repaired).remediated.filter(row => row.rule === "SEC-005").length, 1);
  const waived = assess(source("// @safe-outputs-exempt SEC-005\nconst targetRepo = target;\n"), []);
  assert.equal(compare(before, waived).remediated.length, 0);
  assert.equal(waived.rows.find(row => row.rule === "SEC-005").suppressed, true);
  assert.equal(compare(before, assess({}, [])).remediated.length, 0);
  assert.equal(compare(before, assess(source("const unrelated = 1;\n"), [])).remediated.length, 0);
  assert.equal(compare(before, assess({ [file]: {} }, [])).remediated.length, 0);
});

test("v2 rejects required-file creation and missing bytes as surviving-file clearance", () => {
  const id = "IMP-001|required.cjs|exists";
  const row = { id, rule: "IMP-001", file: "required.cjs", severity: "HIGH" };
  const before = { paths: {}, assessment: { rows: [{ ...row, status: "fail" }] } };
  const after = { paths: { "required.cjs": { id: "a".repeat(40) } }, assessment: { rows: [{ ...row, status: "pass" }] } };
  assert.equal(compare(before.assessment, after.assessment).remediated.length, 1);
  assert.equal(compareSurviving(before, after, new Set()).remediated.length, 0);
  assert.deepEqual(compareSurviving(before, after, new Set()).excludedNonSurviving, [id]);
  before.paths["required.cjs"] = { id: "b".repeat(40) };
  assert.equal(compareSurviving(before, after, new Set()).remediated.length, 1);
  assert.equal(compareSurviving(before, after, new Set(["b".repeat(40)])).remediated.length, 0);
});

test("complete source-only review reconciles all 55 families without claiming full measurement", () => {
  const review = readJson(path.join(home, "source-review.json"));
  const retained = readJsonArchive(path.join(home, "native-evidence-v2.json.gz"));
  const rules = review.instrumentReconciliation.rules;
  assert.equal(hash(readFileSync(path.join(home, "source-review.json"))), definition.sourceAuthority.sourceReviewSha256);
  assert.equal(hash(readFileSync(path.join(home, "compare-v2.mjs"))), definition.sourceAuthority.comparatorSha256);
  assert.deepEqual(rules.map(row => row.rule).sort(), retained.inventory.map(row => row.id).sort());
  assert.equal(rules.filter(row => row.replayStatus === "partial").length, 20);
  assert.equal(rules.filter(row => row.replayStatus === "unimplemented").length, 35);
  for (const source of review.sources.filter(row => ["currentSpec", "adoptionSpec"].includes(row.source))) {
    assert.equal(source.complete, true);
    let next = 1;
    for (const [start, end] of source.readLineRanges) {
      assert.equal(start, next);
      next = end + 1;
    }
    assert.equal(next, source.physicalLines + 1);
  }
  assert.equal(review.finalDisposition.completeMeasurementClaim, false);
  assert.equal(review.finalDisposition.baselineLabelEndorsed, false);
});

test("scorer distinguishes empty partial evidence, known positive subtotals, and missing", () => {
  const base = definition.validationExamples.targetAttained;
  assert.equal(scoreMetric("cleared-findings", { ...base, coverageStatus: "partial" }), 1);
  assert.equal(scoreMetric("cleared-findings", { ...base, coverageStatus: "partial", cleared: [] }), null);
  assert.equal(scoreMetric("remaining-findings", { ...base, coverageStatus: "partial", remaining: 3 }), 3);
  assert.equal(scoreMetric("linked-remediations", { ...base, linked: null }), null);
  assert.equal(scoreMetric("cleared-findings", definition.validationExamples.malformed), null);
  assert.equal(scoreMetric("cleared-findings", definition.validationExamples.missing), null);
});

test("real source archive and replay preserve every collected native row", () => {
  const retained = readJsonArchive(path.join(home, "native-evidence-v2.json.gz"));
  assert.equal(retained.inventory.length, 55);
  assert.equal(retained.toolchain.instrumentSha256, definition.sourceAuthority.instrumentSha256);
  assert.equal(hash(readFileSync(new URL("./native-checker.mjs", import.meta.url))), retained.toolchain.instrumentSha256);
  for (const snapshot of retained.snapshots) {
    const files = Object.fromEntries(Object.entries(snapshot.paths).map(([name, entry]) => {
      const archived = path.join(home, "blobs", `${entry.id}.json.gz`);
      if (retained.missing.some(row => row.id === entry.id)) return [name, entry];
      const blob = readJsonArchive(archived);
      const bytes = Buffer.from(blob.contentBase64, "base64");
      verifyBlob(bytes, entry.id);
      assert.equal(hash(bytes), blob.sha256);
      assert.equal(bytes.length, blob.bytes);
      return [name, { ...entry, content: bytes.toString("utf8") }];
    }));
    assert.deepEqual(assess(files, retained.inventory), snapshot.assessment);
  }
  assert.equal(retained.snapshots.at(-1).assessment.rows.filter(row => row.status === "fail" && !row.suppressed).length, 3);
});

test("actual collector yields retained native facts and refuses arbitrary window synthesis", async () => {
  const retained = readJsonArchive(path.join(home, "native-evidence.json.gz"));
  const interval = retained.intervals.at(-1);
  const request = { windowStart: interval.windowStart, windowEnd: interval.windowEnd, observedAt: interval.windowEnd };
  const [found, absent] = await collectBatch([request, { ...request, windowStart: "2026-01-01T00:00:00Z" }]);
  assert.equal(scoreMetric("remaining-findings", found.evidence), 3);
  assert.equal(scoreMetric("cleared-findings", found.evidence), null);
  assert.equal(scoreMetric("linked-remediations", found.evidence), null);
  assert.equal(found.evidence.fullGoalCompletion, null);
  assert.equal(absent.evidence.coverageStatus, "missing");
  assert.equal(scoreMetric("remaining-findings", absent.evidence), null);
  await assert.rejects(collectBatch([{ ...request, windowEnd: request.windowStart }]));
});

test("all owned proof evidence stays within the existing 256 KiB artifact bound", () => {
  const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const name = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(name) : [name];
  });
  for (const name of walk(home)) assert.ok(readFileSync(name).length <= 256 * 1024, name);
});

test("all retained source bytes and owned provider responses preserve immutable identities", () => {
  for (const name of readdirSync(path.join(home, "blobs")).filter(name => /^[0-9a-f]{40}\.json\.gz$/.test(name))) {
    const blob = readJsonArchive(path.join(home, "blobs", name));
    const bytes = Buffer.from(blob.contentBase64, "base64");
    verifyBlob(bytes, blob.id);
    assert.equal(hash(bytes), blob.sha256);
    assert.equal(bytes.length, blob.bytes);
  }
  const adoption = readJsonArchive(path.join(home, "adoption-sources.json.gz"));
  assert.equal(adoption.sources.length, 5);
  assert.equal(adoption.providerManifests.flatMap(row => row.receipts).length, 4);
  for (const source of adoption.sources.filter(row => row.providerResponseBase64)) {
    const response = Buffer.from(source.providerResponseBase64, "base64");
    assert.equal(hash(response), source.providerResponseSha256);
    const provider = JSON.parse(response.toString("utf8"));
    assert.equal(provider.sha, source.id);
    assert.equal(hash(Buffer.from(provider.content, "base64")), source.sha256);
  }
});

test("standard evaluation and native plot bind the actual frozen function without an invented success", () => {
  const prefix = path.join(home, "reports/github-gh-aw/daily-safe-outputs-conformance-");
  const timeline = readJson(`${prefix}timeline.json`), pulse = readJson(`${prefix}pulse.json`);
  const digest = hash(readFileSync(new URL("../functions/daily-safe-outputs-conformance.mjs", import.meta.url)));
  assert.equal(timeline.valueFunction.sha256, digest);
  assert.equal(pulse.valueFunctionSha256, digest);
  assert.equal(timeline.snapshots.at(-1).window.endAt, "2026-10-18T15:00:12Z");
  assert.equal(timeline.snapshots.at(-1).window.startAt, "2026-10-11T15:00:12Z");
  assert.equal(pulse.metrics.find(row => row.id === "remaining-findings").series.at(-1).value, 3);
  assert.equal(pulse.metrics.find(row => row.id === "cleared-findings").series.at(-1).value, null);
  assert.equal(pulse.metrics.find(row => row.id === "linked-remediations").series.at(-1).value, null);
  assert.equal(pulse.signal.status, "insufficient-evidence");
  assert.equal(pulse.decision.status, "not-rated");
  assert.equal(pulse.cost.status, "not-measured");
  assert.ok(pulse.metrics.every(row => row.presentation.transform === "identity"));
  assert.equal(readFileSync(`${prefix}pulse.html`, "utf8"), renderPulse(pulse));
});
