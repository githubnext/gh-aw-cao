import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { readJson } from "../../.github/skills/add-operational-value/scripts/common.mjs";
import { collectBatch, definition, scoreMetric } from "../../docs/operational-value/proof/functions/daily-credit-limit-test.mjs";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const workflowBlob = "950ad1930ee32372cb8f254b36eee121cbc94254";
const compiledBlob = "11aa7a405433b0dff64461a4b4f5b26f637c351d";
const checkerBlob = "63160a3c91d4b5a472bdcea120878dfd2c5852a4";
const window = { windowStart: "2026-10-18T15:00:12Z", windowEnd: "2026-10-19T15:00:12Z",
  observedAt: "2026-10-19T15:00:12Z" };
const envelope = payload => ({ payload, sha256: hash(payload) });
function fixture() {
  const row = { runId: 100, attempt: 1, activationAt: "2026-10-18T16:00:00Z",
    event: "schedule", workflowBlob, compiledBlob, checkerBlob };
  const receipt = (kind, data) => envelope({
    kind, repositoryId: 1036865607, runId: row.runId, attempt: row.attempt,
    authentication: "verified", origin: "independent-native-export",
    immutableRef: `sha256:${"a".repeat(64)}`, observedAt: window.observedAt, ...data,
  });
  row.activation = receipt("activation-inventory", { activationAt: row.activationAt,
    event: row.event, workflowBlob, compiledBlob, checkerBlob });
  row.ledger = receipt("independent-usage-ledger", {
    complete: true, accounting: "recorded-independent", workflowBlob,
    scanStartAt: row.activationAt,
    runs: [{ runId: 99, attempt: 2, createdAt: "2026-10-17T16:00:00Z",
      updatedAt: "2026-10-17T16:20:00Z", status: "completed", aic: 1,
      estimated: false, componentsComplete: true, producerVerified: true }],
  });
  row.terminal = receipt("terminal-disposition", { terminalAt: "2026-10-18T16:10:00Z" });
  row.decision = receipt("activation-decision", {
    guardrail: "daily-ai-credits-workflow-guardrail", status: "exceeded",
    threshold: 1, agentAdmitted: false, decidedAt: "2026-10-18T16:00:01Z",
  });
  row.inference = receipt("agent-inference-audit", {
    complete: true, startAt: row.activationAt, endAt: row.terminal.payload.terminalAt, requests: [],
  });
  row.notification = receipt("conclusion-message", {
    complete: true, published: true, publisherJob: "conclusion",
    publishedAt: "2026-10-18T16:05:00Z", text: "Daily Workflow AIC Guardrail Exceeded",
  });
  row.producer = receipt("workflow-producer", { linked: true, workflowBlob });
  const coverageReceipt = { authentication: "verified", origin: "independent-native-export",
    repositoryId: 1036865607, workflowBlob, compiledBlob, checkerBlob,
    startAt: window.windowStart, endAt: window.windowEnd, observedAt: window.observedAt };
  return { schemaVersion: 1, kind: "daily-credit-limit-test-native-v1", synthetic: true,
    producerStatus: "synthetic-fixture-not-native", repository: "github/gh-aw", repositoryId: 1036865607,
    revision: definition.adoption.commit, opportunities: [row],
    coverage: [{ startAt: window.windowStart, endAt: window.windowEnd,
      observedAt: window.observedAt, complete: true, receipt: coverageReceipt,
      receiptSha256: hash(coverageReceipt) }],
  };
}
function change(row, field, changes) {
  row[field] = envelope({ ...row[field].payload, ...changes });
}
async function evaluate(archive, request = window) {
  return (await collectBatch([request], { nativeArchive: archive }))[0].evidence;
}

test("frozen native equality and independent full acceptance; synthetic is never native", async () => {
  const evidence = await evaluate(fixture());
  assert.equal(scoreMetric("protected-share", evidence), 100);
  for (const metric of definition.metrics.filter(item => item.role === "diagnostic")) {
    assert.equal(scoreMetric(metric.id, evidence), 1);
  }
  assert.equal(evidence.synthetic, true);
  assert.equal(evidence.dubious, true);
  assert.equal(evidence.costs.status, "not-measured");
});

test("per-run failure, missing inference logs and structural errors never establish daily denial", async () => {
  const archive = fixture(), row = archive.opportunities[0];
  change(row, "decision", { guardrail: "max-ai-credits", status: "failed" });
  row.inference = null;
  const evidence = await evaluate(archive);
  assert.equal(scoreMetric("protected-share", evidence), null);
  assert.equal(scoreMetric("limit-messages", evidence), 1);
  assert.equal(scoreMetric("daily-denials", evidence), null);
  assert.equal(evidence.unassessedAcceptanceCount, 1);
});

test("known inference after denial is an accepted zero, not successful guardrail protection", async () => {
  const archive = fixture(), row = archive.opportunities[0];
  change(row, "inference", { requests: [{ id: "request-with-no-response", requestedAt: "2026-10-18T16:00:02Z" }] });
  const evidence = await evaluate(archive);
  assert.equal(scoreMetric("protected-share", evidence), 0);
  assert.equal(scoreMetric("daily-denials", evidence), 1);
  assert.equal(scoreMetric("inference-free", evidence), 0);
});

test("closed issues, message text alone and unknown publication do not establish acceptance", async () => {
  const archive = fixture();
  archive.opportunities[0].notification = null;
  const evidence = await evaluate(archive);
  assert.equal(scoreMetric("protected-share", evidence), null);
  assert.equal(scoreMetric("daily-denials", evidence), 1);
  assert.equal(scoreMetric("inference-free", evidence), 1);
  assert.equal(scoreMetric("limit-messages", evidence), null);
});

test("missing attribution does not erase accepted actor-independent work", async () => {
  const archive = fixture();
  archive.opportunities[0].producer = null;
  const evidence = await evaluate(archive);
  assert.equal(scoreMetric("protected-share", evidence), 100);
  assert.equal(scoreMetric("verified-protected", evidence), 1);
  assert.equal(scoreMetric("workflow-contribution", evidence), null);
});

test("partial population preserves independent positives but no complete share or all-clear", async () => {
  const archive = fixture();
  archive.coverage = [];
  const evidence = await evaluate(archive);
  assert.equal(scoreMetric("protected-share", evidence), null);
  assert.equal(scoreMetric("verified-protected", evidence), 1);
  assert.equal(evidence.coverageStatus, "partial");
  assert.equal(evidence.eligibleCount, null);
  assert.equal(evidence.observedEligibleCount, 1);
  assert.equal(evidence.dubious, true);
});

test("first below-cap activation is ineligible, never zero percent or accepted protection", async () => {
  const archive = fixture(), row = archive.opportunities[0];
  change(row, "ledger", { runs: [] });
  const evidence = await evaluate(archive);
  assert.equal(evidence.ineligibleCount, 1);
  assert.equal(scoreMetric("protected-share", evidence), null);
  assert.equal(scoreMetric("verified-protected", evidence), 0);
});

test("latest completed run counted once; 24-hour lower boundary included, old/current runs excluded", async () => {
  const archive = fixture(), row = archive.opportunities[0];
  const base = row.ledger.payload.runs[0];
  change(row, "ledger", { runs: [base, base, { ...base, runId: row.runId, aic: 99 },
    { ...base, runId: 97, createdAt: "2026-10-17T15:59:59Z", aic: 99 }] });
  const evidence = await evaluate(archive);
  assert.equal(evidence.opportunities[0].recordedAic, 1);
  assert.equal(scoreMetric("protected-share", evidence), 100);
});

test("estimated, incomplete, negative or conflicting ledger values fail closed", async () => {
  for (const changeRun of [{ estimated: true }, { componentsComplete: false }, { aic: -1 }]) {
    const archive = fixture(), row = archive.opportunities[0];
    change(row, "ledger", { runs: [{ ...row.ledger.payload.runs[0], ...changeRun }] });
    const evidence = await evaluate(archive);
    assert.equal(evidence.unresolvedEligibilityCount, 1);
    assert.equal(scoreMetric("protected-share", evidence), null);
  }
  const archive = fixture(), row = archive.opportunities[0], base = row.ledger.payload.runs[0];
  change(row, "ledger", { runs: [base, { ...base, attempt: 3, aic: 2 }] });
  await assert.rejects(evaluate(archive), /Conflicting/);
});

test("documented dispatch bypasses are not guardrail failures; routed non-command dispatch is assessed", async () => {
  for (const context of ["", "{broken", '{"aw_context":{"event_type":"issue_comment"}}',
    '{"aw_context":{"trigger_label":"ask"}}', '{"aw_context":{}}']) {
    const archive = fixture(), row = archive.opportunities[0];
    row.event = "workflow_dispatch";
    row.awContext = context;
    change(row, "activation", { event: row.event, awContext: row.awContext });
    const evidence = await evaluate(archive);
    assert.equal(evidence.bypassedCount, context === '{"aw_context":{}}' ? 0 : 1);
    assert.equal(scoreMetric("protected-share", evidence), context === '{"aw_context":{}}' ? 100 : null);
  }
});

test("terminal evidence and notification timing cannot be replaced by elapsed maturation", async () => {
  const archive = fixture(), row = archive.opportunities[0];
  row.terminal = null;
  let evidence = await evaluate(archive);
  assert.equal(scoreMetric("protected-share", evidence), null);
  assert.equal(scoreMetric("daily-denials", evidence), 1);
  const badTime = fixture();
  change(badTime.opportunities[0], "notification", { publishedAt: "2026-10-18T15:59:59Z" });
  evidence = await evaluate(badTime);
  assert.equal(scoreMetric("protected-share", evidence), 0);
});

test("exclusive interval end and batch order; no backdating into unverified eras", async () => {
  const archive = fixture(), row = archive.opportunities[0];
  const requests = [
    { ...window, windowEnd: row.activationAt },
    { ...window, windowStart: row.activationAt },
    { windowStart: "2026-10-17T15:00:12Z", windowEnd: "2026-10-18T15:00:12Z",
      observedAt: window.observedAt },
  ];
  const results = await collectBatch(requests, { nativeArchive: archive });
  assert.equal(results[0].evidence.eligibleCount, 0);
  assert.equal(results[1].evidence.eligibleCount, 1);
  assert.equal(scoreMetric("protected-share", results[2].evidence), null);
  assert.match(results[2].evidence.missingReason, /historical compatibility/);
});

test("tampered receipts, repeated opportunities, incompatible profiles and unsafe requests error explicitly", async () => {
  const tampered = fixture();
  tampered.opportunities[0].ledger.payload.runs[0].aic = 0;
  await assert.rejects(evaluate(tampered), /digest mismatch/);
  const duplicate = fixture();
  duplicate.opportunities.push(duplicate.opportunities[0]);
  await assert.rejects(evaluate(duplicate), /Repeated/);
  const incompatible = fixture();
  incompatible.opportunities[0].workflowBlob = "b".repeat(40);
  await assert.rejects(evaluate(incompatible), /incompatible source/);
  await assert.rejects(evaluate(fixture(), { ...window, repository: "other/repository" }), /bounded/);
  await assert.rejects(evaluate(fixture(), { ...window, observedAt: window.windowStart }), /bounded/);
});

test("retained actual archive is unavailable, not synthetic or invented zero", async () => {
  const evidence = (await collectBatch([window]))[0].evidence;
  assert.equal(evidence.synthetic, false);
  assert.equal(evidence.coverageStatus, "missing");
  assert.equal(evidence.eligibleCount, null);
  assert.ok(definition.metrics.every(metric => scoreMetric(metric.id, evidence) === null));
  assert.equal(evidence.costs.status, "not-measured");
  assert.equal(definition.evaluation.historicalReadiness, "unknown-not-exhausted");
});

test("malformed native decisions cannot manufacture a verified failure or zero", async () => {
  const archive = fixture(), row = archive.opportunities[0];
  change(row, "decision", { status: null });
  await assert.rejects(evaluate(archive), /Malformed activation decision/);
  const message = fixture();
  change(message.opportunities[0], "notification", { text: null });
  await assert.rejects(evaluate(message), /Malformed published conclusion/);
  const unauthenticated = fixture();
  unauthenticated.synthetic = false;
  await assert.rejects(evaluate(unauthenticated), /producer authenticity/);
});

test("complete empty cohort, interim native period and future receipts remain distinct", async () => {
  const empty = fixture();
  empty.opportunities = [];
  let evidence = await evaluate(empty);
  assert.equal(scoreMetric("protected-share", evidence), null);
  assert.equal(scoreMetric("verified-protected", evidence), 0);
  evidence = await evaluate(fixture(), { ...window, windowEnd: "2026-10-18T18:00:00Z" });
  assert.equal(evidence.maturityStatus, "interim");
  assert.equal(scoreMetric("protected-share", evidence), 100);
  const late = fixture();
  change(late.opportunities[0], "inference", { observedAt: "2026-10-20T15:00:12Z" });
  evidence = await evaluate(late);
  assert.equal(scoreMetric("protected-share", evidence), null);
  assert.equal(scoreMetric("daily-denials", evidence), 1);
});

test("malformed evidence cannot create scores or normalize arbitrary inputs", () => {
  assert.equal(scoreMetric("protected-share", { ...definition.validationExamples.targetAttained, eligibleCount: 0 }), null);
  assert.equal(scoreMetric("protected-share", { ...definition.validationExamples.targetAttained, acceptedCount: 2 }), null);
  assert.equal(scoreMetric("unknown", definition.validationExamples.targetAttained), null);
  assert.equal(scoreMetric("protected-share", null), null);
});

test("retained source bodies and lineage are lossless provenance, not native observations", () => {
  const sources = readJson("docs/operational-value/proof/daily-credit-limit-test/sources.json.gz");
  for (const row of sources.sources.filter(row => row.status === "retained")) {
    const bytes = Buffer.from(row.content, row.encoding);
    assert.equal(bytes.length, row.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), row.sha256);
    assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), row.blob);
  }
  assert.ok(sources.sources.some(row => row.path.endsWith("daily-credit-limit-test.lock.yml")
    && row.status === "missing-local-blob"));
  assert.equal(sources.addition.verifiedNotShallowBoundary, true);
  const lineage = readJson("docs/operational-value/proof/daily-credit-limit-test/lineage.json.gz");
  assert.equal(lineage.verifiedPartitions, 346);
  assert.equal(lineage.verifiedEntities, 58048);
  assert.equal(lineage.selected.length, 158);
  assert.ok(lineage.selected.every(row => row.workflowReference.workflowId === definition.slug));
});
