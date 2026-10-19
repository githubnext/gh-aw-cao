import assert from "node:assert/strict";
import { test } from "node:test";
import { definition, collectBatch, scoreMetric } from "../../docs/operational-value/proof/functions/smoke-copilot-sdk.mjs";
import { discoverClosure } from "../../scripts/collect-smoke-copilot-sdk.mjs";
import {
  inspectCandidateOriginals, inspectProtectedOriginals, interpretRawProbe, measureNativeReceipts,
  productionAssessment, readAdmittedNativeReceipts, readBundle, validateSourceArchive, verifyHistoricalAdoption,
} from "../../scripts/native-smoke-copilot-sdk.mjs";

const example = () => structuredClone(definition.validationExamples.targetAttained.raw);
const encode = value => Buffer.from(value).toString("base64");
const request = { windowStart: "2026-10-01T00:00:00Z", windowEnd: "2026-10-08T00:00:00Z", observedAt: "2026-10-08T00:00:00Z" };

test("native fixtures exercise exact source byte/operation predicates, never clock correctness", () => {
  const facts = interpretRawProbe(example());
  assert.equal(facts.fileContentFacet, true);
  assert.equal(facts.catReadback, true);
  assert.equal(facts.bashCalculation, true);
  assert.equal(facts.currentDateTimeCorrect, null);
  assert.equal(facts.fullFileWritingTask, null);
  assert.equal(facts.fullSourceConjunction, null);
});

test("file path, content, new-file transition and native type are intrinsic evidence", () => {
  for (const mutate of [
    raw => { raw.fileAfter.path += ".other"; },
    raw => { raw.fileAfter.bytesBase64 = encode("smoke test passed\n"); },
    raw => { raw.fileAfter.bytesBase64 = encode("Copilot SDK smoke test passed at \n"); },
    raw => { raw.fileAfter.bytesBase64 = encode("Copilot SDK smoke test passed at date\nextra\n"); },
    raw => { raw.fileBefore.exists = true; },
    raw => { raw.fileAfter.kind = "symlink"; },
  ]) {
    const raw = example(); mutate(raw);
    assert.notEqual(interpretRawProbe(raw).fileContentFacet, true);
  }
});

test("source does not prescribe date/time spelling or a single line-terminator convention", () => {
  for (const suffix of ["time-text", "time-text\n", "time-text\r\n"]) {
    const raw = example();
    raw.fileAfter.bytesBase64 = encode(`Copilot SDK smoke test passed at ${suffix}`);
    assert.equal(interpretRawProbe(raw).fileContentFacet, true);
    assert.equal(interpretRawProbe(raw).fullFileWritingTask, null);
  }
});

test("readback requires actual cat, exact path, phrase and exit status", () => {
  for (const mutate of [
    raw => { raw.cat.argv = ["echo", "smoke test passed"]; },
    raw => { raw.cat.argv[1] += ".other"; },
    raw => { raw.cat.stdoutBase64 = encode("wrong"); },
    raw => { raw.cat.exitCode = 1; },
  ]) {
    const raw = example(); mutate(raw);
    assert.equal(interpretRawProbe(raw).catReadback, false);
  }
});

test("arithmetic requires exact native bash expression and stdout, not any reported42", () => {
  for (const mutate of [
    raw => { raw.bash.argv[1] = "echo 42"; },
    raw => { raw.bash.argv[1] = "echo $((7 * 6))"; },
    raw => { raw.bash.stdoutBase64 = encode("42"); },
    raw => { raw.bash.stdoutBase64 = encode("42\nextra\n"); },
    raw => { raw.bash.exitCode = 1; },
    raw => { raw.bash.program = "agent"; },
  ]) {
    const raw = example(); mutate(raw);
    assert.equal(interpretRawProbe(raw).bashCalculation, false);
  }
});

test("a missing dimension cannot erase narrower independently interpreted native facts", () => {
  const raw = example();
  delete raw.fileBefore; delete raw.fileAfter; delete raw.cat;
  const facts = interpretRawProbe(raw);
  assert.equal(facts.fileContentFacet, null);
  assert.equal(facts.catReadback, null);
  assert.equal(facts.bashCalculation, true);
  assert.equal(facts.fullSourceConjunction, null);
});

test("disjoint delivery periods retain partial native quantities without replaying old state", () => {
  const raw = example();
  delete raw.fileBefore; delete raw.fileAfter; delete raw.cat;
  const records = [{ id: "test-only-native-operation", raw }];
  const before = measureNativeReceipts(records, "2026-10-12T11:13:03Z", raw.deliveredAt);
  assert.equal(before.nativeCapabilityFacets, null);
  const period = measureNativeReceipts(records, raw.deliveredAt, "2026-10-26T11:13:03Z");
  assert.equal(period.nativeCapabilityFacets, 1);
  assert.equal(period.bashCalculations, 1);
  assert.equal(period.fileEffects, null);
  assert.equal(period.fullSourceConjunction, null);
  const after = measureNativeReceipts(records, "2026-10-26T11:13:03Z", "2026-11-02T11:13:03Z");
  assert.equal(after.nativeCapabilityFacets, null);
  assert.throws(() => measureNativeReceipts([...records, ...records], raw.deliveredAt, "2026-10-26T11:13:03Z"), /repeated/);
  const repeatedChallenge = [...records, { id: "different-receipt-same-underlying-challenge",
    raw: { ...raw, deliveredAt: "2026-10-27T11:13:03Z" } }];
  assert.equal(measureNativeReceipts(repeatedChallenge, raw.deliveredAt, "2026-11-02T11:13:03Z").bashCalculations, 1);
  assert.equal(measureNativeReceipts(repeatedChallenge, "2026-10-26T11:13:03Z", "2026-11-02T11:13:03Z").bashCalculations, null);
});

test("malformed native input and noncanonical base64 fail closed", () => {
  for (const raw of [null, {}, { ...example(), runId: "1" }, { ...example(), deliveredAt: "2026-02-30T00:00:00Z" }]) {
    assert.equal(interpretRawProbe(raw), null);
  }
  const raw = example(); raw.bash.stdoutBase64 += "\n";
  assert.equal(interpretRawProbe(raw).bashCalculation, null);
});

test("complete discovery includes forward/reverse peers through absent references", () => {
  const rows = [
    { number: 1, workflowReference: { workflowId: "smoke-copilot-sdk" }, relatedCandidates: [2] },
    { number: 2, relatedCandidates: [99] },
    { number: 3, relatedCandidates: [1] },
    { number: 4, relatedCandidates: [99] },
    { number: 5, relatedCandidates: [] },
  ];
  const closure = discoverClosure(rows);
  assert.deepEqual(closure.directNumbers, [1]);
  assert.deepEqual(closure.entities.map(row => row.number), [1, 2, 3, 4]);
  assert.deepEqual(closure.absentReferences, [99]);
});

test("retained complete history and frozen workflow originals replay without external caches", () => {
  const { source, discovery } = readBundle();
  assert.equal(source.sources[0].gitBlob, definition.sourceIdentity.workflowBlob);
  assert.equal(discovery.index.partitions.length, 346);
  assert.equal(discovery.index.totalEntities, 58048);
  assert.equal(discovery.directNumbers.length, 30);
  assert.equal(discovery.entities.length, 2730);
  assert.equal(discovery.absentReferences.length, 16);
  const corrupt = structuredClone(source);
  corrupt.sources[0].contentBase64 = encode("altered");
  assert.throws(() => validateSourceArchive(corrupt), /identity mismatch/);
});

test("validation examples test quantities but clones, booleans and synthetic digests cannot admit evidence", () => {
  const examples = definition.validationExamples;
  assert.equal(scoreMetric("native-facets", examples.targetAttained), 3);
  assert.equal(scoreMetric("native-facets", examples.targetMissed), 0);
  for (const fake of [
    structuredClone(examples.targetAttained), { accepted: true, value: 3 },
    { kind: "protected-native-production", acceptedReceiptIds: ["a".repeat(64)], nativeCapabilityFacets: 3 },
    { sourceRevision: definition.sourceIdentity.revision, protected: true, raw: example() },
    examples.missing, examples.malformed,
  ]) for (const metric of definition.metrics) assert.equal(scoreMetric(metric.id, fake), null);
});

test("production collector preserves nulls, historical applicability gaps and immutable provenance", async () => {
  const results = await collectBatch([request, { ...request, windowStart: request.windowEnd, windowEnd: "2026-10-15T00:00:00Z", observedAt: "2026-10-15T00:00:00Z" }]);
  assert.equal(results.length, 2);
  for (const result of results) {
    assert.equal(result.evidence.coverageStatus, "unknown");
    assert.equal(result.evidence.eligibleCount, null);
    assert.equal(result.evidence.fullSourceConjunction, null);
    assert.equal(result.evidence.workflowContribution, null);
    assert.match(result.evidence.missingReason, /exact contemporaneous run\/source profile only/);
    assert.ok(result.provenance.length > 0);
    for (const metric of definition.metrics) assert.equal(scoreMetric(metric.id, result.evidence), null);
  }
});

test("caller evidence and invalid temporal/repository bounds fail explicitly", async () => {
  for (const context of [{ trusted: true }, { receipts: [example()] }, { raw: example() }]) {
    await assert.rejects(collectBatch([request], context), /cannot establish admission/);
  }
  for (const invalid of [
    { ...request, windowStart: request.windowEnd }, { ...request, observedAt: request.windowStart },
    { ...request, windowEnd: "2026-02-30T00:00:00Z" }, { ...request, repository: "other/repo" },
  ]) await assert.rejects(collectBatch([invalid]), /Invalid bounded/);
  assert.throws(() => scoreMetric("unknown", {}), /Unknown SDK/);
});

test("production readiness is not confused with implementation/interface readiness", () => {
  const report = productionAssessment();
  assert.equal(report.acceptedNativeReceipts, 1);
  assert.equal(report.nativeCapabilityFacets, 2);
  assert.equal(report.fullSourceConjunction, null);
  assert.equal(report.repositoryOutcome.nativeOperations, 2);
  assert.equal(report.workflowContribution.nativeOperations, 2);
  assert.equal(report.historicalAdoption.adoptedAt, "2026-02-14T17:16:36Z");
  assert.equal(report.missingSources.length, 6);
  assert.equal(report.absentSourcePaths.length, 4);
  assert.ok(report.missingSources.every(row => row.gitBlob !== null));
  assert.equal(report.costs, null);
  assert.equal(report.decision, "not-rated");
});

test("protected attempt host events, exact native job/step and run-era SDK source corroborate only two facets", () => {
  const proof = inspectProtectedOriginals();
  assert.equal(proof.admitted, true);
  assert.equal(proof.jobId, 117252704344);
  assert.equal(proof.step, 30);
  assert.deepEqual(proof.hostEventLines, [2058, 2062]);
  assert.equal(proof.sdkVersion, "1.0.16");
  assert.equal(proof.awfVersion, "v0.28.59");
  assert.equal(proof.fileEffects, null);
  assert.equal(proof.fullSourceConjunction, null);
  assert.equal(proof.catReadbacks, 1);
  assert.equal(proof.bashCalculations, 1);
});

test("real native compound execution is not relabelled as fictional standalone process argv", () => {
  const [{ raw }] = readAdmittedNativeReceipts();
  assert.equal(raw.cat, undefined);
  assert.equal(raw.bash, undefined);
  const fact = interpretRawProbe(raw);
  assert.equal(fact.catReadback, true);
  assert.equal(fact.bashCalculation, true);
  assert.equal(fact.fileContentFacet, null);
  assert.equal(fact.currentDateTimeCorrect, null);
  for (const mutate of [
    row => { row.sdkCompound.command = row.sdkCompound.command.replace("echo $((6 * 7))", "echo 42"); },
    row => { row.sdkCompound.stdoutBase64 = encode("---FILE---\nsmoke test passed\n---CALC---\n42\nextra\n"); },
    row => { row.sdkCompound.exitCode = 1; },
    row => { row.sdkCompound.toolName = "assistant"; },
    row => { row.runId++; },
  ]) {
    const altered = structuredClone(raw); mutate(altered);
    assert.notEqual(interpretRawProbe(altered).bashCalculation, true);
  }
});

test("true introduction is content/real-parent verified without applying the later goal to earlier eras", () => {
  const adoption = verifyHistoricalAdoption();
  assert.equal(adoption.commit, definition.adoption.commit);
  assert.equal(adoption.adoptedAt, definition.adoption.adoptedAt);
  assert.match(adoption.sourceEra, /NOT the later file/);
  assert.equal(adoption.baselineAt, null);
});

test("actual production collection keeps measured partial native2 and SDK contribution separate from full-goal and unknown history", async () => {
  const windows = [
    { windowStart: "2026-10-10T00:00:00Z", windowEnd: "2026-10-17T00:04:06Z", observedAt: "2026-10-18T15:00:12Z" },
    { windowStart: "2026-10-17T00:04:06Z", windowEnd: "2026-10-18T15:00:12Z", observedAt: "2026-10-18T15:00:12Z" },
    { windowStart: "2026-10-18T15:00:12Z", windowEnd: "2026-10-19T11:13:02Z", observedAt: "2026-10-19T11:13:02Z" },
  ];
  const [before, during, after] = await collectBatch(windows);
  for (const result of [before, after]) assert.equal(scoreMetric("native-facets", result.evidence), null);
  assert.equal(scoreMetric("native-facets", during.evidence), 2);
  assert.equal(scoreMetric("file-effects", during.evidence), null);
  assert.equal(scoreMetric("cat-readbacks", during.evidence), 1);
  assert.equal(scoreMetric("bash-calculations", during.evidence), 1);
  assert.equal(during.evidence.workflowContribution.nativeOperations, 2);
  assert.equal(during.evidence.repositoryOutcome.nativeOperations, 2);
  assert.equal(during.evidence.fullSourceConjunction, null);
  assert.equal(during.evidence.fullWorkflowAcceptance, null);
  assert.equal(during.evidence.reporting, null);
  assert.equal(during.evidence.coverageStatus, "partial");
  assert.equal(during.evidence.dubious, false);
  assert.equal(scoreMetric("native-facets", { ...during.evidence, nativeCapabilityFacets: 999, workflowContribution: { nativeOperations: 999 } }), 2);
  assert.equal(scoreMetric("native-facets", { ...during.evidence, acceptedReceiptIds: ["invented"] }), null);
});

test("actual original SDK event bytes are interpreted without promoting writable telemetry to host proof", () => {
  const candidate = inspectCandidateOriginals();
  assert.equal(candidate.runId, 38984382289);
  assert.equal(candidate.attempt, 1);
  assert.equal(candidate.providerZipSha256, "5f0ef590e353a92100110e24de01375dee177e74a1f06cf067d5a7c0e17d1596");
  assert.equal(candidate.nativeEvents, 30);
  assert.equal(candidate.rawNativeCommandAndResultMatch, true);
  assert.deepEqual(candidate.nativeObservedFacets, { catPhraseReadback: true, arithmeticStdout42: true });
  assert.equal(candidate.nativeFileCreation, null);
  assert.equal(candidate.fullSourceConjunction, null);
  assert.equal(candidate.admitted, false);
  assert.match(candidate.missingReason, /agent-writable/);
  assert.equal(candidate.members.length, 44);
  candidate.nativeStart.data.arguments.command = "echo forged";
  assert.equal(inspectCandidateOriginals().rawNativeCommandAndResultMatch, true);
});
