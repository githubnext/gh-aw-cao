import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEvidence,
  definition,
  scoreMetric,
} from "../../optimization/operational-value/optimization-token-optimizer.mjs";

const request = {
  repository: "github/gh-aw",
  windowStart: "2026-09-01T00:00:00Z",
  windowEnd: "2026-09-15T00:00:00Z",
  observedAt: "2026-10-20T00:00:00Z",
};

test("token optimizer value scores only verified guarded gains", () => {
  const records = [
    {
      type: "token_efficiency.opportunity",
      timestamp: "2026-09-05T00:00:00Z",
      targetRepo: "github/gh-aw",
      opportunityId: "opportunity-1",
      evidenceState: "complete",
    },
    {
      type: "token_efficiency.intervention",
      timestamp: "2026-09-20T00:00:00Z",
      targetRepo: "github/gh-aw",
      opportunityId: "opportunity-1",
      interventionId: "intervention-1",
      interventionState: "verified",
      recommendationDisposition: "applied",
    },
    {
      type: "optimization.comparison.observed",
      timestamp: "2026-09-25T00:00:00Z",
      targetRepo: "github/gh-aw",
      opportunityId: "opportunity-1",
      interventionId: "intervention-1",
      evidenceState: "complete",
      verifiedNetGain: 0.25,
      baselineFailureRate: 0.1,
      optimizedFailureRate: 0.05,
      outcomeQualityPreserved: true,
    },
  ];
  const evidence = buildEvidence(records, request);
  assert.deepEqual(evidence, {
    maturityStatus: "matured",
    dubious: false,
    eligibleOpportunityCount: 1,
    verifiedOpportunityCount: 1,
    acceptedRecommendationCount: 1,
    outcomeUnknownCount: 0,
    dispositionUnknownCount: 0,
    guardedNetGainRatioSum: 0.25,
  });
  assert.equal(scoreMetric("verified-opportunity-share", evidence), 1);
  assert.equal(scoreMetric("recommendation-acceptance-share", evidence), 1);
  assert.equal(scoreMetric("guarded-net-gain-magnitude", evidence), 0.25);
});

test("token optimizer value keeps inaccessible outcomes missing", () => {
  const evidence = buildEvidence([
    {
      type: "token_efficiency.opportunity",
      timestamp: "2026-09-05T00:00:00Z",
      targetRepo: "github/gh-aw",
      opportunityId: "opportunity-1",
      evidenceState: "complete",
    },
    {
      type: "token_efficiency.intervention",
      timestamp: "2026-09-20T00:00:00Z",
      targetRepo: "github/gh-aw",
      opportunityId: "opportunity-1",
      interventionId: "intervention-1",
      interventionState: "running",
      recommendationDisposition: "applied",
    },
  ], request);
  assert.equal(evidence.outcomeUnknownCount, 1);
  assert.equal(evidence.maturityStatus, "interim");
  assert.equal(evidence.dubious, true);
  assert.equal(scoreMetric("verified-opportunity-share", evidence), 0);
  assert.equal(scoreMetric("guarded-net-gain-magnitude", evidence), 0);
  assert.equal(scoreMetric("recommendation-acceptance-share", evidence), 1);
});

test("token optimizer value excludes future and unauthorized evidence", () => {
  const records = [
    {
      type: "token_efficiency.opportunity",
      timestamp: "2026-09-05T00:00:00Z",
      targetRepo: "github/gh-aw",
      opportunityId: "allowed",
      evidenceState: "complete",
    },
    {
      type: "token_efficiency.intervention",
      timestamp: "2026-11-01T00:00:00Z",
      targetRepo: "github/gh-aw",
      opportunityId: "allowed",
      interventionId: "future",
      interventionState: "verified",
      recommendationDisposition: "applied",
    },
    {
      type: "token_efficiency.opportunity",
      timestamp: "2026-09-05T00:00:00Z",
      targetRepo: "unapproved/repository",
      opportunityId: "unauthorized",
      evidenceState: "complete",
    },
  ];
  const evidence = buildEvidence(records, { ...request, repository: undefined });
  assert.equal(evidence.eligibleOpportunityCount, 1);
  assert.equal(evidence.verifiedOpportunityCount, 0);
  assert.equal(evidence.outcomeUnknownCount, 1);
  assert.equal(evidence.maturityStatus, "interim");
});

test("token optimizer publishes a dubious zero before the first cohort matures", () => {
  const evidence = buildEvidence([], {
    ...request,
    observedAt: "2026-09-24T20:56:21Z",
  });
  assert.deepEqual(evidence, {
    maturityStatus: "interim",
    dubious: true,
    eligibleOpportunityCount: 0,
    verifiedOpportunityCount: 0,
    acceptedRecommendationCount: 0,
    outcomeUnknownCount: 0,
    dispositionUnknownCount: 0,
    guardedNetGainRatioSum: 0,
  });
  for (const metric of definition.metrics) assert.equal(scoreMetric(metric.id, evidence), 0);
});

test("token optimizer publishes available pre-maturity attainment as dubious", () => {
  const evidence = buildEvidence([
    {
      type: "token_efficiency.opportunity",
      timestamp: "2026-09-18T00:00:00Z",
      targetRepo: "github/gh-aw",
      opportunityId: "early-opportunity",
      evidenceState: "complete",
    },
    {
      type: "token_efficiency.intervention",
      timestamp: "2026-09-20T00:00:00Z",
      targetRepo: "github/gh-aw",
      opportunityId: "early-opportunity",
      interventionId: "early-intervention",
      interventionState: "verified",
      recommendationDisposition: "applied",
    },
    {
      type: "optimization.comparison.observed",
      timestamp: "2026-09-24T00:00:00Z",
      targetRepo: "github/gh-aw",
      opportunityId: "early-opportunity",
      interventionId: "early-intervention",
      evidenceState: "complete",
      verifiedNetGain: 0.2,
      baselineFailureRate: 0.1,
      optimizedFailureRate: 0.1,
      outcomeQualityPreserved: true,
    },
  ], {
    repository: "github/gh-aw",
    windowStart: definition.adoption.adoptedAt,
    windowEnd: "2026-09-24T20:56:21Z",
    observedAt: "2026-09-24T20:56:21Z",
  });
  assert.equal(evidence.maturityStatus, "interim");
  assert.equal(evidence.dubious, true);
  assert.equal(scoreMetric("verified-opportunity-share", evidence), 1);
  assert.equal(scoreMetric("recommendation-acceptance-share", evidence), 1);
  assert.equal(scoreMetric("guarded-net-gain-magnitude", evidence), 0.2);
});

test("token optimizer definition validation examples preserve metric ordering", () => {
  for (const metric of definition.metrics) {
    assert.ok(
      scoreMetric(metric.id, definition.validationExamples.targetAttained)
      > scoreMetric(metric.id, definition.validationExamples.targetMissed),
    );
    assert.equal(scoreMetric(metric.id, definition.validationExamples.missing), null);
    assert.equal(scoreMetric(metric.id, definition.validationExamples.malformed), null);
  }
});
