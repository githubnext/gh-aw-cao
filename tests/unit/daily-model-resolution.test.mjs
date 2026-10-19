import assert from "node:assert/strict";
import test from "node:test";
import {
  assessDispatches, classifyExpected, collectBatch, definition, scoreMetric,
} from "../../docs/operational-value/proof/functions/daily-model-resolution.mjs";
import { observationWindows } from "../../.github/skills/add-operational-value/scripts/common.mjs";

const fixture = () => {
  const identity = { runId: "1", attempt: "1", sessionId: "s", agentId: "child", toolCallId: "call" };
  const sourceBlob = "c".repeat(40);
  return {
    dispatch: { ...identity, at: "2026-10-18T08:00:00Z", parentAgentId: "parent",
      sourceBlob, agentName: "worker", receiptSha256: "a".repeat(64) },
    declaration: { sourceBlob, agentName: "worker", model: "small", receiptSha256: "b".repeat(64) },
    proxyRequests: [{ ...identity, requestId: "req", model: "gpt-5-mini", receiptSha256: "d".repeat(64) }],
    requestSetComplete: true, completenessReceiptSha256: "e".repeat(64),
  };
};
const scored = (counts, coverageStatus = "complete") => ({
  ...counts, sourceProfile: definition.sourceProfile.sha256,
  nativeRecordsPresent: true, classificationScope: "explicit-model-size", coverageStatus,
});

test("source classification includes explicit aliases and case-insensitive small model names", () => {
  for (const model of ["small", "mini", "haiku", "gpt-5-NANO", "claude-HAIKU", "gemini-FLASH", "gpt-5-mini"]) {
    assert.equal(classifyExpected(model), "small");
  }
  for (const model of ["large", "sonnet", "opus", "gpt-5.4", "claude-sonnet"]) {
    assert.equal(classifyExpected(model), "large");
  }
  for (const model of ["inherited", "unknown", "", null]) assert.equal(classifyExpected(model), null);
});

test("bound correct and wrong native child requests have exact native values", () => {
  const row = fixture();
  const correct = scored(assessDispatches([row]));
  assert.equal(scoreMetric("correct-resolution-share", correct), 100);
  assert.equal(scoreMetric("verified-correct", correct), 1);
  row.proxyRequests[0].model = "claude-sonnet";
  const wrong = scored(assessDispatches([row]));
  assert.equal(wrong.mismatchCount, 1);
  assert.equal(scoreMetric("correct-resolution-share", wrong), 0);
});

test("one wrong request establishes mismatch while a correct prefix cannot establish correctness", () => {
  const row = fixture();
  row.requestSetComplete = false;
  assert.equal(assessDispatches([row]).unknownCount, 1);
  row.proxyRequests.push({ ...row.proxyRequests[0], requestId: "req2", model: "claude-opus" });
  assert.equal(assessDispatches([row]).mismatchCount, 1);
});

test("unresolved inherited dispatch does not erase independently verified partial native work", () => {
  const row = fixture();
  const inherited = fixture();
  inherited.dispatch.toolCallId = "call2";
  inherited.proxyRequests[0].toolCallId = "call2";
  inherited.declaration.model = "inherited";
  const evidence = scored(assessDispatches([row, inherited]));
  assert.equal(scoreMetric("correct-resolution-share", evidence), null);
  assert.equal(scoreMetric("verified-correct", evidence), 1);
  assert.equal(evidence.unknownCount, 1);
  const partial = scored(assessDispatches([row]), "partial");
  assert.equal(scoreMetric("correct-resolution-share", partial), null);
  assert.equal(scoreMetric("verified-correct", partial), 1);
});

test("parent substitution, source disagreement and duplicate identities fail closed", () => {
  const parent = fixture();
  parent.proxyRequests[0].agentId = "parent";
  assert.throws(() => assessDispatches([parent]), /unbound/);
  const source = fixture();
  source.declaration.sourceBlob = "f".repeat(40);
  assert.throws(() => assessDispatches([source]), /source identity/);
  const row = fixture();
  assert.throws(() => assessDispatches([row, row]), /Duplicate/);
  const duplicateRequest = fixture();
  duplicateRequest.proxyRequests.push(duplicateRequest.proxyRequests[0]);
  assert.throws(() => assessDispatches([duplicateRequest]), /duplicate/);
  const alias = fixture();
  alias.proxyRequests[0].model = "small";
  assert.throws(() => assessDispatches([alias]), /unbound/);
});

test("missing and empty populations remain distinct, with no invented shares", () => {
  assert.equal(scoreMetric("correct-resolution-share", {}), null);
  const empty = scored(assessDispatches([]));
  assert.equal(scoreMetric("correct-resolution-share", empty), null);
  assert.equal(scoreMetric("verified-correct", empty), 0);
  assert.equal(scoreMetric("verified-correct", { ...empty, nativeRecordsPresent: false }), null);
  assert.equal(scoreMetric("correct-resolution-share", { ...empty, eligibleCount: -1 }), null);
});

test("actual collector preserves missing native history and unverified historical eras", async () => {
  const windows = [
    { windowStart: "2026-10-16T00:00:00Z", windowEnd: "2026-10-18T00:00:00Z", observedAt: "2026-10-18T00:00:00Z" },
    { windowStart: "2026-10-19T00:00:00Z", windowEnd: "2026-10-21T00:00:00Z", observedAt: "2026-10-21T00:00:00Z" },
  ];
  const collected = await collectBatch(windows);
  assert.equal(collected.length, 2);
  assert.match(collected[0].evidence.missingReason, /not backdated/);
  assert.match(collected[1].evidence.missingReason, /unimplemented/);
  for (const result of collected) {
    assert.equal(result.evidence.coverageStatus, "missing");
    for (const metric of definition.metrics) assert.equal(scoreMetric(metric.id, result.evidence), null);
    assert.equal(result.evidence.eligibleCount, null);
    assert.ok(result.provenance.length > 0);
  }
  await assert.rejects(collectBatch([{ ...windows[0], repository: "different/repo" }]), /Invalid/);
});

test("production observation windows partition delivery rather than overlapping the two-day cohort", () => {
  const windows = observationWindows(definition, definition.adoption.adoptedAt, "2026-10-18T15:00:12Z");
  for (let i = 1; i < windows.length; i++) assert.equal(windows[i - 1].windowEnd, windows[i].windowStart);
  assert.equal(windows[0].windowStart, definition.adoption.adoptedAt);
  assert.equal(windows.at(-1).windowEnd, "2026-10-18T15:00:12Z");
});
