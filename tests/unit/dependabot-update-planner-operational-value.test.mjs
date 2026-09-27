import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEvidence,
  definition,
  isOpenAt,
  scoreMetric,
} from "../../dependabot/operational-value/dependabot-update-planner.mjs";

const request = {
  repository: "github/gh-aw",
  windowStart: "2026-09-10T00:00:00Z",
  windowEnd: "2026-09-17T00:00:00Z",
  observedAt: "2026-09-17T00:00:00Z",
};

test("Dependabot operational value measures repository state rather than plan engagement", () => {
  assert.equal(definition.evaluation.mode, "baseline-comparable");
  assert.equal(definition.evidence.repositories[0], "github/gh-aw");
  assert.match(definition.model.architecture, /independent of gh-aw outputs/);
  assert.doesNotMatch(
    definition.metrics.map(({ id }) => id).join(" "),
    /plan|assignment|comment|workflow-run/,
  );
});

test("Dependabot evidence scores dependency currency and unresolved risk", () => {
  const evidence = buildEvidence({
    repository: "github/gh-aw",
    request,
    alerts: [
      { created_at: "2026-09-01T00:00:00Z", severity: "high" },
      {
        created_at: "2026-09-01T00:00:00Z",
        fixed_at: "2026-09-16T00:00:00Z",
        severity: "medium",
      },
      { created_at: "2026-09-02T00:00:00Z", severity: "low" },
    ],
    pullRequests: [
      { created_at: "2026-09-03T00:00:00Z" },
      {
        created_at: "2026-09-03T00:00:00Z",
        closed_at: "2026-09-16T00:00:00Z",
      },
    ],
  });

  assert.equal(scoreMetric("open-high-critical-alert-count", evidence), 1);
  assert.equal(scoreMetric("open-security-alert-count", evidence), 2);
  assert.equal(scoreMetric("open-dependabot-pr-count", evidence), 1);
});

test("Dependabot lifecycle evidence reconstructs state at the cutoff", () => {
  assert.equal(isOpenAt({
    created_at: "2026-09-01T00:00:00Z",
    closed_at: "2026-09-18T00:00:00Z",
  }, request.windowEnd), true);
  assert.equal(isOpenAt({
    created_at: "2026-09-01T00:00:00Z",
    closed_at: "2026-09-16T00:00:00Z",
  }, request.windowEnd), false);
  assert.equal(isOpenAt({
    created_at: "2026-09-18T00:00:00Z",
  }, request.windowEnd), false);
});

test("Dependabot metrics fail closed on missing or malformed evidence", () => {
  for (const metric of definition.metrics) {
    assert.equal(scoreMetric(metric.id, definition.validationExamples.missing), null);
    assert.equal(scoreMetric(metric.id, definition.validationExamples.malformed), null);
  }
});

test("Dependabot validation examples preserve metric direction", () => {
  for (const metric of definition.metrics) {
    const attained = scoreMetric(metric.id, definition.validationExamples.targetAttained);
    const missed = scoreMetric(metric.id, definition.validationExamples.targetMissed);
    if (metric.direction === "increase") assert.ok(attained > missed);
    else assert.ok(attained < missed);
  }
});
