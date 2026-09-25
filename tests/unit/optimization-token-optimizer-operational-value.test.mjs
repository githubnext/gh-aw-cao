import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEvidence,
  definition,
  efficiencyQuery,
  scoreMetric,
} from "../../optimization/operational-value/optimization-token-optimizer.mjs";

const request = {
  repository: "github/gh-aw",
  windowStart: "2026-09-08T00:00:00Z",
  windowEnd: "2026-09-15T00:00:00Z",
  observedAt: "2026-09-15T00:00:00Z",
};

function row(overrides = {}) {
  return {
    owner: "github",
    repository: "gh-aw",
    declaredWorkflowPath: ".github/workflows/daily-file-diet.md",
    concludedRuns: 10,
    successfulRuns: 8,
    successfulRunsWithAic: 8,
    aicPerSuccessfulRun: 10,
    failedRuns: 1,
    cancelledRuns: 1,
    ...overrides,
  };
}

test("token optimizer measures native repository efficiency and reliability", () => {
  const evidence = buildEvidence([
    row({ aicPerSuccessfulRun: 8 }),
    row({
      declaredWorkflowPath: ".github/workflows/ci-doctor.md",
      concludedRuns: 5,
      successfulRuns: 2,
      successfulRunsWithAic: 2,
      aicPerSuccessfulRun: 20,
      failedRuns: 2,
      cancelledRuns: 1,
    }),
  ], request);

  assert.deepEqual(evidence, {
    maturityStatus: "matured",
    dubious: false,
    eligibleWorkflowCount: 2,
    successfulRunCount: 10,
    successfulRunAicTotal: 104,
    concludedRunCount: 15,
    failedRunCount: 3,
    cancelledRunCount: 2,
    failedRunPercentagePointTotal: 300,
    cancelledRunPercentagePointTotal: 200,
  });
  assert.equal(scoreMetric("aic-per-successful-run", evidence), 10.4);
  assert.equal(scoreMetric("failure-rate-percent", evidence), 20);
  assert.equal(scoreMetric("cancellation-rate-percent", evidence), 13.333333333);
});

test("token optimizer declares pre-existing native measures as baseline comparable", () => {
  assert.equal(definition.evaluation.mode, "baseline-comparable");
  assert.equal(definition.adoption.baselineCommit, "ad7be08097b5b69cc15a8bf17dbc5e0ad12865ab");
  assert.equal(definition.adoption.baselineAt, "2026-09-15T23:02:17Z");

  const baselineEvidence = buildEvidence([row({ aicPerSuccessfulRun: 43.530901429 })], request);
  assert.equal(scoreMetric("aic-per-successful-run", baselineEvidence), 43.530901429);
  assert.equal(scoreMetric("failure-rate-percent", baselineEvidence), 10);
  assert.equal(scoreMetric("cancellation-rate-percent", baselineEvidence), 10);
});

test("token optimizer keeps insufficient or incomplete target evidence missing", () => {
  const evidence = buildEvidence([
    row({ concludedRuns: 2 }),
    row({
      declaredWorkflowPath: ".github/workflows/incomplete-aic.md",
      successfulRunsWithAic: 7,
    }),
  ], request);

  assert.equal(evidence.eligibleWorkflowCount, 0);
  for (const metric of definition.metrics) assert.equal(scoreMetric(metric.id, evidence), null);
});

test("token optimizer excludes its own campaign and other repositories", () => {
  const evidence = buildEvidence([
    row({ declaredWorkflowPath: ".github/workflows/optimization-token-auditor.md" }),
    row({ repository: "gh-aw-mcpg" }),
  ], request);

  assert.equal(evidence.eligibleWorkflowCount, 0);
});

test("token optimizer marks a bounded partial window interim", () => {
  const evidence = buildEvidence([row({ aicPerSuccessfulRun: 8 })], {
    ...request,
    windowStart: "2026-09-04T00:00:00Z",
    windowEnd: "2026-09-08T00:00:00Z",
    observedAt: "2026-09-08T00:00:00Z",
  });

  assert.equal(evidence.maturityStatus, "interim");
  assert.equal(evidence.dubious, true);
  assert.equal(scoreMetric("aic-per-successful-run", evidence), 8);
});

test("token optimizer declares additive native rollup evidence", () => {
  assert.deepEqual(
    definition.metrics.map(({ id, unit, direction, rollup }) => ({
      id, unit, direction, rollup,
    })),
    [{
      id: "aic-per-successful-run",
      unit: "aic-per-run",
      direction: "decrease",
      rollup: {
        numeratorField: "successfulRunAicTotal",
        denominatorField: "successfulRunCount",
      },
    }, {
      id: "failure-rate-percent",
      unit: "percent",
      direction: "decrease",
      rollup: {
        numeratorField: "failedRunPercentagePointTotal",
        denominatorField: "concludedRunCount",
      },
    }, {
      id: "cancellation-rate-percent",
      unit: "percent",
      direction: "decrease",
      rollup: {
        numeratorField: "cancelledRunPercentagePointTotal",
        denominatorField: "concludedRunCount",
      },
    }],
  );
});

test("token optimizer bounds canonical queries to each rolling observation window", () => {
  const query = efficiencyQuery(request.windowStart, request.windowEnd);
  assert.deepEqual(query.filter.predicates.slice(0, 2), [
    { field: "startedAt", gte: request.windowStart },
    { field: "startedAt", lt: request.windowEnd },
  ]);
  assert.equal(Object.hasOwn(query, "time"), false);
});

test("token optimizer validation examples preserve decrease-goal ordering", () => {
  for (const metric of definition.metrics) {
    assert.ok(
      scoreMetric(metric.id, definition.validationExamples.targetAttained)
      < scoreMetric(metric.id, definition.validationExamples.targetMissed),
    );
    assert.equal(scoreMetric(metric.id, definition.validationExamples.missing), null);
    assert.equal(scoreMetric(metric.id, definition.validationExamples.malformed), null);
  }
});
