import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyRunRecord } from "../../scripts/native-durable-metrics-value.mjs";
import { collectBatch, definition, scoreMetric } from "../../docs/operational-value/proof/functions/metrics-collector.mjs";

const repositoryId = 1036865607;
const workflow = { id: 101, path: ".github/workflows/smoke-copilot.lock.yml" };
const window = { start: "2026-10-17T00:00:00Z", end: "2026-10-18T00:00:00Z" };
const row = (id, conclusion) => ({ id, conclusion, workflow_id: workflow.id, path: workflow.path,
  repository: { id: repositoryId, private: false }, created_at: "2026-10-17T10:00:00Z", updated_at: "2026-10-17T11:00:00Z" });
const fixture = () => ({
  record: { total: 4, successful: 1, failed: 1, skipped: 1, action_required: 1, executed: 2 },
  pages: [{ total_count: 4, workflow_runs: [row(1, "success"), row(2, "failure"), row(3, "skipped"), row(4, "action_required")] }],
  workflow, repositoryId, window, snapshotAt: window.end,
});

test("complete exact workflow/window populations accept one six-field record", () => {
  const result = verifyRunRecord(fixture());
  assert.equal(result.status, "accepted");
  assert.deepEqual(result.expected, fixture().record);
});

test("cancelled and timed-out runs are failures, not skipped or approval-gated work", () => {
  for (const conclusion of ["cancelled", "timed_out"]) {
    const value = fixture();
    value.pages[0].workflow_runs[1].conclusion = conclusion;
    assert.equal(verifyRunRecord(value).status, "accepted");
  }
});

test("unavailable zero stubs and declared lower bounds never earn accidental accuracy credit", () => {
  const value = fixture();
  value.record.total_is_lower_bound = true;
  assert.equal(verifyRunRecord(value).status, "unknown");
  const empty = { ...fixture(), record: { total: 0, successful: 0, failed: 0, skipped: 0, action_required: 0, executed: 0 },
    pages: [{ total_count: 0, workflow_runs: [] }] };
  assert.equal(verifyRunRecord(empty).status, "accepted");
  empty.record.data_available = false;
  assert.equal(verifyRunRecord(empty).status, "unknown");
});

test("later run updates cannot be backdated to a stored collection", () => {
  const value = fixture();
  value.pages[0].workflow_runs[0].updated_at = "2026-10-19T00:00:00Z";
  assert.equal(verifyRunRecord(value).status, "unknown");
});

test("duplicates and foreign workflow/repository identities fail explicitly", () => {
  for (const mutate of [
    value => { value.pages[0].workflow_runs[1].id = 1; },
    value => { value.pages[0].workflow_runs[0].workflow_id = 999; },
    value => { value.pages[0].workflow_runs[0].repository.id = 999; },
    value => { value.pages[0].workflow_runs[0].path = ".github/workflows/foreign.lock.yml"; },
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(() => verifyRunRecord(value));
  }
});

test("short populations remain unknown and incorrect totals/classifications are rejected", () => {
  const short = fixture();
  short.pages[0].workflow_runs.pop();
  assert.equal(verifyRunRecord(short).status, "unknown");
  const wrongTotal = fixture();
  wrongTotal.record.total--;
  assert.equal(verifyRunRecord(wrongTotal).status, "rejected");
  const wrongClass = fixture();
  wrongClass.record.executed = 4;
  assert.equal(verifyRunRecord(wrongClass).status, "rejected");
});

test("inclusive API end timestamps are excluded from half-open metric windows", () => {
  const value = fixture(), boundary = row(5, "success");
  boundary.created_at = window.end;
  boundary.updated_at = "2026-10-18T01:00:00Z";
  value.pages[0].workflow_runs.push(boundary);
  value.pages[0].total_count++;
  assert.equal(verifyRunRecord(value).status, "accepted");
});

test("all nine real selected records preserve incomplete or mismatched scope, never fixture credit", () => {
  assert.equal(definition.nativeAssessments.length, 9);
  assert.equal(definition.nativeAssessments.filter(row => row.status === "accepted").length, 0);
  assert.equal(definition.nativeAssessments.filter(row => row.status === "rejected").length, 3);
  const request = { windowStart: "2026-10-11T15:00:12Z", windowEnd: "2026-10-18T15:00:12Z",
    observedAt: "2026-10-18T15:00:12Z", repository: "github/gh-aw" };
  const result = collectBatch([request])[0];
  assert.equal(result.evidence.knownSubtotal, 0);
  assert.equal(scoreMetric("verified-run-statistic-records", result.evidence), null);
  assert.equal(result.evidence.fullAcceptance, null);
  assert.equal(result.evidence.contribution, null);
  assert.equal(result.evidence.costs, null);
});
