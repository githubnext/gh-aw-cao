import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  acceptedMeasurement, collectBatch, definition, parseOriginalBenchmark, scoreMetric,
} from "../../docs/operational-value/proof/functions/daily-cli-performance.mjs";
import { selectLineage } from "../../scripts/collect-daily-cli-performance-proof.mjs";
import { readCensusJson, writeCensusJson } from "../../scripts/operational-value-census-io.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const proofPath = "docs/operational-value/proof/daily-cli-performance/investigation.json.gz";
const window = {
  windowStart: "2026-10-17T15:00:12Z", windowEnd: "2026-10-18T15:00:12Z",
  observedAt: "2026-10-18T15:00:12Z",
};
const raw = "goos: linux\ngoarch: amd64\npkg: github.com/github/gh-aw/pkg/workflow\ncpu: fixture CPU\nBenchmarkCompileSimpleWorkflow-4 200 123456.7 ns/op 123 B/op 2 allocs/op\n";
const original = raw.replace("-4 200 ", "-4 3 ");
const sample = () => ({
  kind: "original-protected-benchmark", repository: "github/gh-aw",
  compilerHead: "a".repeat(40), benchmarkBlob: definition.source.benchmarkBlob,
  completedAt: "2026-10-18T12:00:00Z", raw: original, rawSha256: digest(original),
  runId: 1, artifactId: 2, artifactSha256: "b".repeat(64), receiptSha256: "c".repeat(64),
  producer: { independent: true, job: "bench", workflowBlob: "9f23e662b4f4ed70f3771eae570c11fa236db9eb", head: "a".repeat(40) },
  correctness: { fixtureCompiled: true, head: "a".repeat(40), scopeDigest: "e".repeat(64), evidenceDigest: "f".repeat(64) },
  profile: {
    goos: "linux", goarch: "amd64", goVersion: "go1.26.0",
    hardwareDigest: "1".repeat(64), runnerImageDigest: "2".repeat(64), dependenciesDigest: "3".repeat(64),
    gomaxprocs: 4, correctnessScopeDigest: "e".repeat(64), command: "make bench",
    benchtime: "3x", benchmarkBlob: definition.source.benchmarkBlob,
  },
});

test("native parser preserves reported precision, iterations and allocation context, not invented totals", () => {
  const [row] = parseOriginalBenchmark(raw);
  assert.equal(row.reportedNsPerOp, 123456.7);
  assert.equal(row.iterations, 200);
  assert.equal(row.bytesPerOp, 123);
  assert.equal(row.allocationsPerOp, 2);
  assert.equal(Object.hasOwn(row, "elapsedNs"), false);
  assert.equal(parseOriginalBenchmark(raw.replace("-4", "")).at(0).gomaxprocs, 1);
  assert.equal(parseOriginalBenchmark(raw.replace("123456.7", "1.234567e5")).at(0).reportedNsPerOp, 123456.7);
  assert.deepEqual(parseOriginalBenchmark("BenchmarkCompileComplexWorkflow-4 3 100 ns/op 0 B/op 0 allocs/op\n"), []);
  for (const text of [raw.replace("200 ", "0 "), raw.replace("123456.7", "NaN"),
    raw.replace("123456.7", "-1"), raw.replace("200 ", "9007199254740993 "),
    raw.replace("123 B/op", "-1 B/op")]) assert.throws(() => parseOriginalBenchmark(text));
});

test("native acceptance fails closed on self-report, missing correctness, altered profiles or identities", () => {
  assert.equal(acceptedMeasurement(sample()).rows.length, 1);
  const mutations = [
    record => { record.kind = "fixture"; },
    record => { record.kind = "agent-report"; },
    record => { record.correctness.fixtureCompiled = false; },
    record => { record.correctness.head = "0".repeat(40); },
    record => { record.correctness.evidenceDigest = null; },
    record => { record.producer.independent = false; },
    record => { record.producer.workflowBlob = "d".repeat(40); },
    record => { record.producer.job = "agent"; },
    record => { record.raw = raw; record.rawSha256 = digest(raw); },
    record => { record.profile.benchtime = "2s"; },
    record => { record.profile.gomaxprocs = 8; },
    record => { record.profile.hardwareDigest = null; },
    record => { record.profile.goVersion = ""; },
    record => { record.rawSha256 = "0".repeat(64); },
    record => { record.artifactId = null; },
    record => { record.completedAt = "2026-10-18T15:00:12Z"; },
    record => { record.benchmarkBlob = "0".repeat(40); },
  ];
  for (const mutate of mutations) { const record = sample(); mutate(record); assert.equal(acceptedMeasurement(record), null); }
});

test("scoring is native, actor-independent and missing is never zero", () => {
  const metric = definition.metrics[0].id;
  assert.equal(scoreMetric(metric, definition.validationExamples.targetAttained), 50000000);
  assert.equal(scoreMetric(metric, definition.validationExamples.targetMissed), 120000000);
  assert.equal(scoreMetric(metric, definition.validationExamples.missing), null);
  assert.equal(scoreMetric(metric, definition.validationExamples.malformed), null);
  assert.equal(scoreMetric(metric, { ...definition.validationExamples.targetAttained,
    reportedNanosecondsPerCompile: [1, 9, 4, 6] }), 5);
  assert.equal(scoreMetric("unknown", definition.validationExamples.targetAttained), null);
});

test("candidate lineage traverses all retained edges in both directions without accepting them", () => {
  const rows = [
    { number: 1, workflowReference: { trackerId: "daily-cli-performance" }, relatedCandidates: [2] },
    { number: 2, relatedCandidates: [3] },
    { number: 4, relatedCandidates: [2] },
    { number: 5, relatedCandidates: [] },
  ];
  const result = selectLineage(rows);
  assert.deepEqual(result.direct.map(row => row.number), [1]);
  assert.deepEqual(result.closure.map(row => row.number), [1, 2, 4]);
  assert.deepEqual(result.missing, [3]);
});

test("actual collector returns explicit missing native quantities for all retained-scope cohorts", async () => {
  const [result, duplicate] = await collectBatch([window, window]);
  assert.deepEqual(result, duplicate);
  assert.equal(scoreMetric(definition.metrics[0].id, result.evidence), null);
  assert.equal(result.evidence.eligibleCount, null);
  assert.equal(result.evidence.coverageStatus, "missing");
  assert.equal(result.evidence.goalCompletion, null);
  assert.ok(result.evidence.missingReason.includes("original"));
  assert.equal(result.evidence.nativeRecords.length, 0);
  assert.ok(result.provenance.length >= 3);
  await assert.rejects(() => collectBatch([{ ...window, windowStart: window.windowEnd }]), /Invalid bounded/);
  await assert.rejects(() => collectBatch([{ ...window, repository: "other/repo" }]), /Invalid bounded/);
});

test("original protected replay retains real native quantities without manufacturing accepted value", () => {
  const replay = readCensusJson("docs/operational-value/proof/daily-cli-performance/native-replay.json.gz");
  assert.equal(replay.nativeDiagnostic.reportedNanosecondsPerAttemptedOperation, 7187936);
  assert.equal(replay.nativeDiagnostic.completedBenchmarkIterations, 3);
  assert.equal(replay.nativeDiagnostic.bytesPerOperation, 3765650);
  assert.equal(replay.nativeDiagnostic.allocationsPerOperation, 26807);
  assert.equal(replay.nativeDiagnostic.exactElapsedNanoseconds, null);
  assert.equal(replay.acceptance.latencyValue, null);
  assert.equal(replay.acceptance.workflowContribution, null);
  assert.ok(replay.protectedCorrectness.nativeFailureEvents.some(row =>
    row.Test === "TestSessionParserSourcesIncludeLocalDependencies"));
  assert.equal(replay.protectedCorrectness.unparsedNativeJsonRows, 0);
  const original = replay.originalPayloads.artifact[0];
  const bytes = Buffer.from(original.contentBase64, "base64");
  assert.equal(digest(bytes), original.sha256);
  assert.equal(parseOriginalBenchmark(bytes.toString())[0].reportedNsPerOp, 7187936);
});

test("authorized acquisition ledger retains original bodies and leaves pagination explicitly open", () => {
  const proof = readCensusJson(proofPath);
  assert.equal(proof.acquisitionLedger.completed.length, 7);
  assert.equal(proof.acquisitionLedger.historyComplete, false);
  assert.equal(proof.acquisitionLedger.pendingPages.length, 4);
  for (const archive of proof.acquisitionLedger.archives) {
    const acquired = readCensusJson(path.join(path.dirname(proofPath), archive.file));
    assert.equal(digest(JSON.stringify(acquired)), archive.sha256);
    for (const receipt of acquired.receipts) {
      assert.equal(digest(Buffer.from(receipt.originalBody, "base64")), receipt.bodySha256);
      assert.equal(receipt.status, 200);
      const need = proof.acquisitionNeeds.find(row =>
        decodeURIComponent(row.endpoint) === decodeURIComponent(receipt.endpoint));
      assert.match(need.status, /^acquired;/);
    }
  }
  assert.ok(proof.acquisitionNeeds.some(row => !row.status));
});

test("batch collector preserves incompatible native profiles without inventing a combined trend", async () => {
  const temporary = mkdtempSync(path.resolve(".daily-cli-performance-test-"));
  try {
    const proof = readCensusJson(proofPath);
    const first = sample(), second = sample();
    second.artifactId = 3;
    second.profile.hardwareDigest = "4".repeat(64);
    proof.nativeEvidence = [first, second];
    const file = path.join(temporary, "proof.json.gz");
    writeCensusJson(file, proof);
    const [mixed] = await collectBatch([window], { proofPath: file });
    assert.equal(scoreMetric(definition.metrics[0].id, mixed.evidence), null);
    assert.equal(mixed.evidence.nativeRecords.length, 2);
    assert.match(mixed.evidence.missingReason, /Incompatible/);
    proof.nativeEvidence = [first];
    writeCensusJson(file, proof);
    const [one] = await collectBatch([window], { proofPath: file });
    assert.equal(scoreMetric(definition.metrics[0].id, one.evidence), 123456.7);
    assert.equal(one.evidence.coverageStatus, "partial");
    assert.equal(one.evidence.eligibleCount, 3);
    proof.nativeEvidence = [{ ...first, kind: "fixture" }];
    writeCensusJson(file, proof);
    await assert.rejects(() => collectBatch([window], { proofPath: file }), /Unaccepted/);
    proof.nativeEvidence = [first, first];
    writeCensusJson(file, proof);
    await assert.rejects(() => collectBatch([window], { proofPath: file }), /Repeated/);
    proof.nativeEvidence = [];
    proof.scope.repositoryId = 1;
    writeCensusJson(file, proof);
    await assert.rejects(() => collectBatch([window], { proofPath: file }), /scope mismatch/);
    proof.scope.repositoryId = 1036865607;
    proof.sources.find(row => row.blob === definition.source.sourceBlob).content = Buffer.from("altered").toString("base64");
    writeCensusJson(file, proof);
    await assert.rejects(() => collectBatch([window], { proofPath: file }), /integrity mismatch/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
