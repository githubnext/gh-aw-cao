import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAMPAIGN_INTELLIGENCE_CONTRACT,
  DECISION_FEEDBACK_CONTRACT,
  compileCampaignIntelligenceContracts,
  normalizeDecisionFeedback,
  normalizeEvidenceQuality
} from '../../activity/computations/intelligence-contracts.mjs';
import { computeIntelligencePortfolio } from '../../activity/computations/intelligence.mjs';

function runtimeHealth() {
  return {
    measureId: 'runtime-health',
    measureVersion: '1.0.0',
    campaignResults: [{ campaignId: 'campaign:maintenance' }],
    partitionResults: [{
      campaignId: 'campaign:maintenance',
      workflowId: 'workflow:maintenance',
      workflowRole: 'worker',
      targetRepositoryId: 'repository:target',
      targetScopeMembership: 'expected',
      recoveryMayBeInProgress: false
    }],
    errorGroups: [{
      campaignId: 'campaign:maintenance',
      workflowId: 'workflow:maintenance',
      workflowRole: 'worker',
      targetRepositoryId: 'repository:target',
      targetScopeMembership: 'expected',
      errorKey: 'driver-exit',
      count: 3,
      distinctRunAttemptCount: 3,
      latestObservedAt: '2026-10-01T10:00:00Z',
      runReferences: [{ runId: 'github:run:101:attempt:1' }]
    }]
  };
}

function campaign(overrides = {}) {
  return {
    id: 'campaign:maintenance',
    slug: 'maintenance',
    mode: 'review',
    enabled: true,
    maxRepositories: 10,
    rolloutPercent: 25,
    monthlyAiCreditBudget: 0,
    aiCreditAllowance: null,
    targets: [{ repository: 'octo/target' }],
    observedAt: '2026-10-01T09:00:00Z',
    provenance: {
      source: 'inventory',
      sourceId: 'campaign:maintenance',
      observedAt: '2026-10-01T09:00:00Z'
    },
    ...overrides
  };
}

function workflow() {
  return {
    id: 'workflow:maintenance',
    campaignId: 'campaign:maintenance',
    role: 'worker',
    state: 'active',
    rolloutMode: 'review',
    maxAiCredits: 200,
    observedAt: '2026-10-01T09:30:00Z',
    provenance: {
      source: 'inventory',
      sourceId: 'workflow:maintenance',
      observedAt: '2026-10-01T09:30:00Z'
    }
  };
}

function feedback(decision, overrides = {}) {
  return {
    contractVersion: DECISION_FEEDBACK_CONTRACT.version,
    records: [{
      decisionId: decision.decisionId,
      inputFingerprint: decision.inputFingerprint,
      disposition: 'accepted',
      observedAt: '2026-10-01T11:00:00Z',
      actor: 'operator:octocat',
      authority: 'control-repository-review',
      ...overrides
    }]
  };
}

test('campaign intelligence compilation preserves unknowns and numeric evidence states', () => {
  const [contract] = compileCampaignIntelligenceContracts([campaign()], [workflow()]);

  assert.equal(contract.contractVersion, CAMPAIGN_INTELLIGENCE_CONTRACT.version);
  assert.equal(contract.repositoryNativeProblem, null);
  assert.equal(contract.intendedOutcome, null);
  assert.deepEqual(contract.targetPopulation, [{ repository: 'octo/target' }]);
  assert.deepEqual(contract.resourceEnvelope.monthlyAiCreditBudget, {
    state: 'zero',
    value: 0
  });
  assert.deepEqual(contract.resourceEnvelope.aiCreditAllowance, {
    state: 'missing',
    value: null
  });
  assert.equal(contract.quality.completeness, 'partial');
  assert.deepEqual(contract.quality.coverage, {
    state: 'partial',
    numerator: 2,
    denominator: 17
  });
  assert.deepEqual(contract.quality.provenance, {
    state: 'available',
    sources: ['inventory']
  });
  assert.match(contract.inputFingerprint, /^sha256:[a-f0-9]{64}$/);
});

test('campaign intelligence contracts are deterministic and honor declared semantics', () => {
  const declared = Object.fromEntries([
    'repositoryNativeProblem',
    'eligibleOpportunity',
    'intendedOutcome',
    'outcomeAttainmentEvidence',
    'targetPopulation',
    'interventionClass',
    'triggerAndSchedule',
    'scheduleRationale',
    'maxDetectionDelay',
    'resourceEnvelope',
    'overlapIdentity',
    'outputApprovalPolicy',
    'maturationPeriod',
    'deduplication',
    'backoff',
    'stopConditions',
    'operationalValueDefinition'
  ].map((field) => [field, { declared: field }]));
  const input = campaign({ intelligenceContract: declared });
  const first = compileCampaignIntelligenceContracts([input], [workflow()]);
  const second = compileCampaignIntelligenceContracts([structuredClone(input)], [workflow()]);

  assert.deepEqual(second, first);
  assert.equal(first[0].quality.completeness, 'complete');
  assert.deepEqual(first[0].repositoryNativeProblem, {
    declared: 'repositoryNativeProblem'
  });
});

test('evidence quality normalizes partial counts and fails malformed dimensions closed', () => {
  assert.deepEqual(normalizeEvidenceQuality({
    availability: 'available',
    completeness: 'partial',
    freshness: { state: 'fresh', observedAt: '2026-10-01T10:00:00Z' },
    coverage: { state: 'partial', numerator: 2, denominator: 5 },
    maturity: 'immature',
    provenance: { state: 'available', sources: ['runtime-health', 'runtime-health'] },
    attributionCoverage: { state: 'partial', numerator: 3, denominator: 2 },
    contradictionState: 'not-observed'
  }), {
    contractId: 'evidence-quality',
    contractVersion: '1.0.0',
    availability: 'available',
    completeness: 'partial',
    freshness: { state: 'fresh', observedAt: '2026-10-01T10:00:00.000Z' },
    coverage: { state: 'partial', numerator: 2, denominator: 5 },
    maturity: 'immature',
    provenance: { state: 'available', sources: ['runtime-health'] },
    attributionCoverage: { state: 'malformed', numerator: null, denominator: null },
    contradictionState: 'not-observed'
  });
  assert.equal(normalizeEvidenceQuality('invalid').availability, 'malformed');
  assert.equal(normalizeEvidenceQuality({
    freshness: { state: 'fresh' }
  }).freshness.state, 'malformed');
});

test('decision feedback is versioned, sorted, bounded, and rejects invalid dispositions', () => {
  const portfolio = computeIntelligencePortfolio(runtimeHealth());
  const decision = portfolio.decisions[0];
  const normalized = normalizeDecisionFeedback({
    contractVersion: DECISION_FEEDBACK_CONTRACT.version,
    records: [
      feedback(decision, {
        disposition: 'recovered',
        observedAt: '2026-10-01T12:00:00Z'
      }).records[0],
      feedback(decision, {
        disposition: 'deferred',
        observedAt: '2026-10-01T11:00:00Z'
      }).records[0]
    ]
  });

  assert.deepEqual(normalized.records.map((record) => record.disposition), [
    'deferred',
    'recovered'
  ]);
  assert.throws(() => normalizeDecisionFeedback({
    contractVersion: DECISION_FEEDBACK_CONTRACT.version,
    records: [feedback(decision, { disposition: 'successful' }).records[0]]
  }), /disposition is invalid/);
  assert.throws(() => normalizeDecisionFeedback({
    contractVersion: DECISION_FEEDBACK_CONTRACT.version,
    records: [feedback(decision, { observedAt: 'not-a-timestamp' }).records[0]]
  }), /must be an ISO 8601 timestamp/);
  assert.throws(() => normalizeDecisionFeedback({
    contractVersion: DECISION_FEEDBACK_CONTRACT.version,
    records: [
      feedback(decision).records[0],
      feedback(decision).records[0]
    ]
  }), /duplicate decision, fingerprint, and timestamp/);
});

test('matched terminal feedback suppresses unchanged evidence while stale feedback is inspectable', () => {
  const initial = computeIntelligencePortfolio(runtimeHealth());
  const decision = initial.decisions[0];
  const suppressed = computeIntelligencePortfolio(runtimeHealth(), {
    previousResult: initial,
    feedback: feedback(decision)
  });
  assert.equal(suppressed.decisionCount, 0);
  assert.equal(suppressed.feedback.appliedCount, 1);
  assert.equal(suppressed.suppressionCount, 1);

  const changed = runtimeHealth();
  changed.errorGroups[0].count = 4;
  changed.errorGroups[0].distinctRunAttemptCount = 4;
  const retained = computeIntelligencePortfolio(changed, {
    previousResult: initial,
    feedback: feedback(decision)
  });
  assert.equal(retained.decisionCount, 1);
  assert.equal(retained.feedback.appliedCount, 0);
  assert.equal(retained.feedback.staleCount, 1);
  assert.equal(retained.decisions[0].feedback, null);
});

test('feedback for an absent Decision remains inspectable and unmatched', () => {
  const initial = computeIntelligencePortfolio(runtimeHealth());
  const result = computeIntelligencePortfolio(runtimeHealth(), {
    feedback: feedback(initial.decisions[0], {
      decisionId: 'runtime-health-decision:absent'
    })
  });

  assert.equal(result.feedback.recordCount, 1);
  assert.equal(result.feedback.appliedCount, 0);
  assert.equal(result.feedback.staleCount, 0);
  assert.equal(result.feedback.unmatchedCount, 1);
  assert.equal(result.decisions[0].feedback, null);
});
