import assert from "node:assert/strict";
import test from "node:test";
import {
  definitionFromOperationalValueReport,
  mergeOperationalValueRecords,
  operationalValueRecordIdentity,
  operationalValueRunIdentity,
  recordsFromOperationalValueReport,
} from "../../dashboard/report/operational-value-history.mjs";

const report = {
  schemaVersion: 1,
  repository: "github/gh-aw",
  workflowId: "daily-file-diet",
  sourcePath: ".github/workflows/daily-file-diet.md",
  operationalValue: "Reduce oversized files.",
  evaluator: { sha256: "digest" },
  baseline: { mode: "attainment-only" },
  diagnostics: [{ metric: { id: "repository-health", name: "Repository health", direction: "higher_is_better" } }],
  observations: [{
    id: "github/gh-aw:daily-file-diet:42:2:digest",
    run: { id: "42", attempt: 2, url: "https://github.com/github/gh-aw/actions/runs/42", createdAt: "2026-08-30T10:00:00Z" },
    status: "pass",
    value: 0.8,
    opportunityKey: "github/gh-aw#42",
    evidenceAt: "2026-09-01T10:00:00Z",
    evidenceCutoff: "2026-09-01T09:00:00Z",
    maturesAt: "2026-09-01T10:00:00Z",
    mature: true,
    case: { targetRepo: "github/gh-aw" },
    provenance: [{ repository: "github/gh-aw", sha: "abc123" }],
    diagnostics: { "repository-health": 0.65 },
    evaluatorDigest: "digest",
  }],
};

test("normalizes a gh-aw report into append-only CAO observation records", () => {
  const records = recordsFromOperationalValueReport(report);
  assert.equal(records.length, 1);
  assert.equal(operationalValueRecordIdentity(records[0]), "github/gh-aw:daily-file-diet:42:2:digest");
  assert.equal(records[0].observation.subject.createdAt, "2026-08-30T10:00:00Z");
  assert.deepEqual(records[0].observation.provenance, [{ repository: "github/gh-aw", sha: "abc123" }]);
  assert.deepEqual(records[0].diagnostics, { "repository-health": 0.65 });
  assert.equal(records[0].observationSource, "report");
  assert.deepEqual(definitionFromOperationalValueReport(report).diagnosticMetrics, [
    { id: "repository-health", name: "Repository health", direction: "higher_is_better" },
  ]);
});

test("keeps retries and evaluator generations while preferring report observations", () => {
  const normalized = recordsFromOperationalValueReport(report)[0];
  const artifact = { ...normalized, observationSource: "run", value: 0.1 };
  const retry = { ...normalized, observationId: undefined, runAttempt: 3 };
  const previousEvaluator = { ...normalized, observationId: undefined, evaluatorDigest: "old-digest" };
  const records = mergeOperationalValueRecords(artifact, normalized, retry, previousEvaluator);

  assert.equal(records.length, 3);
  assert.equal(records.find((record) => record.observationId === normalized.observationId)?.value, 0.8);
  assert.ok(records.some((record) => record.observationId.endsWith(":3:digest")));
  assert.ok(records.some((record) => record.observationId.endsWith(":2:old-digest")));
});

test("drops stale unavailable placeholders once an observed record exists for the same run", () => {
  const placeholder = {
    schemaVersion: 1,
    repository: "github/gh-aw",
    workflowId: "daily-file-diet",
    workflowPath: ".github/workflows/daily-file-diet.md",
    runId: 42,
    runAttempt: 2,
    status: "unavailable",
    value: null,
    observationSource: "logs-json",
    observation: null,
    reason: "operational-value result not found",
  };
  const observed = {
    ...placeholder,
    status: "pass",
    value: 0.8,
    evaluatorDigest: "digest",
    reason: undefined,
  };

  const records = mergeOperationalValueRecords([placeholder], [observed]);

  assert.equal(records.length, 1);
  assert.equal(records[0].status, "pass");
  assert.equal(records[0].value, 0.8);
});

test("run identities cover cached results even without nested observation payloads", () => {
  const cached = {
    schemaVersion: 1,
    repository: "github/gh-aw",
    workflowId: "daily-file-diet",
    workflowPath: ".github/workflows/daily-file-diet.md",
    runId: 42,
    runAttempt: 2,
    status: "pass",
    value: 0.7,
    observationSource: "run",
    observation: null,
  };
  const selected = {
    repository: "github/gh-aw",
    workflowId: "daily-file-diet",
    workflowPath: ".github/workflows/daily-file-diet.md",
    runId: 42,
    run: { attempt: 2 },
  };

  assert.equal(operationalValueRecordIdentity(cached), "github/gh-aw:daily-file-diet:42:2:unknown-evaluator");
  assert.equal(operationalValueRunIdentity(cached), operationalValueRunIdentity(selected));
});