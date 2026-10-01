import {
  CAMPAIGN_INTELLIGENCE_CONTRACT,
  DECISION_FEEDBACK_CONTRACT,
  intelligenceFingerprint,
  normalizeDecisionFeedback,
  normalizeEvidenceQuality,
  stableIntelligenceId
} from './intelligence-contracts.mjs';

export { intelligenceFingerprint } from './intelligence-contracts.mjs';

export const INTELLIGENCE_MEASURE = Object.freeze({
  id: 'portfolio-decisions',
  version: '1.1.0'
});

const TERMINAL_DISPOSITIONS = new Set([
  'accepted',
  'rejected',
  'superseded',
  'recovered',
  'expired'
]);
const DEFAULT_ACT_NOW_FAILURE_COUNT = 3;
const EVIDENCE_REFERENCE_LIMIT = 50;

function stableId(prefix, value) {
  return stableIntelligenceId(prefix, value);
}

function partitionKey(value) {
  return [
    String(value.campaignId ?? ''),
    String(value.workflowId ?? ''),
    String(value.targetRepositoryId ?? '')
  ].join('\0');
}

function latestTimestamp(values) {
  const timestamps = values
    .map((value) => value?.observedAt)
    .filter((value) => typeof value === 'string' && Number.isFinite(Date.parse(value)))
    .sort();
  return timestamps.at(-1) ?? null;
}

function runtimeHealthSignals(runtimeHealth) {
  if (!runtimeHealth || runtimeHealth.measureId !== 'runtime-health'
      || typeof runtimeHealth.measureVersion !== 'string'
      || !Array.isArray(runtimeHealth.partitionResults)
      || !Array.isArray(runtimeHealth.errorGroups)) {
    throw new TypeError('Intelligence requires a runtime-health computation result');
  }
  const partitions = new Map(runtimeHealth.partitionResults.map((partition) => [
    partitionKey(partition),
    partition
  ]));
  return runtimeHealth.errorGroups.map((group) => {
    const campaignId = String(group.campaignId ?? '');
    const workflowId = String(group.workflowId ?? '');
    const errorKey = String(group.errorKey ?? '');
    if (!campaignId || !workflowId || !errorKey) {
      throw new TypeError('Runtime-health error groups require campaign, workflow, and error identities');
    }
    const targetRepositoryId = group.targetRepositoryId == null
      ? null
      : String(group.targetRepositoryId);
    const identity = {
      measureId: runtimeHealth.measureId,
      campaignId,
      workflowId,
      targetRepositoryId,
      errorKey
    };
    const evidenceReferences = [...new Set((group.runReferences ?? [])
      .map((reference) => String(reference?.runId ?? '').trim())
      .filter(Boolean))]
      .sort()
      .slice(0, EVIDENCE_REFERENCE_LIMIT);
    const partition = partitions.get(partitionKey({
      campaignId,
      workflowId,
      targetRepositoryId
    }));
    const signal = {
      signalId: stableId('runtime-health-signal', identity),
      measureId: runtimeHealth.measureId,
      measureVersion: runtimeHealth.measureVersion,
      campaignId,
      workflowId,
      workflowRole: String(group.workflowRole ?? partition?.workflowRole ?? 'unknown'),
      targetRepositoryId,
      targetScopeMembership: group.targetScopeMembership == null
        ? null
        : String(group.targetScopeMembership),
      errorKey,
      failureCount: Number(group.count ?? 0),
      distinctRunAttemptCount: Number(group.distinctRunAttemptCount ?? 0),
      observedAt: typeof group.latestObservedAt === 'string' ? group.latestObservedAt : null,
      recoveryMayBeInProgress: Boolean(partition?.recoveryMayBeInProgress),
      evidenceReferences
    };
    return {
      ...signal,
      inputFingerprint: intelligenceFingerprint(signal)
    };
  }).sort((left, right) => left.signalId.localeCompare(right.signalId));
}

function suppression(signal, rule, nextReconsideration, relatedDecisionId = null) {
  const identity = { signalId: signal.signalId, rule, relatedDecisionId };
  return {
    suppressionId: stableId('suppression', identity),
    rule,
    signalId: signal.signalId,
    inputFingerprint: signal.inputFingerprint,
    subject: {
      campaignId: signal.campaignId,
      workflowId: signal.workflowId,
      targetRepositoryId: signal.targetRepositoryId
    },
    relatedDecisionId,
    nextReconsideration
  };
}

function previousResult(value) {
  if (value == null) return null;
  const result = value?.command === 'computation' ? value.result : value;
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new TypeError('Previous intelligence result must be an object');
  }
  if (result.measureId !== INTELLIGENCE_MEASURE.id
      || result.measureVersion !== INTELLIGENCE_MEASURE.version
      || !Array.isArray(result.decisions)) {
    throw new TypeError('Previous intelligence result has an incompatible contract');
  }
  for (const decision of result.decisions) {
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)
        || typeof decision.decisionId !== 'string'
        || typeof decision.inputFingerprint !== 'string') {
      throw new TypeError('Previous intelligence result contains an invalid Decision');
    }
  }
  if (result.feedback !== undefined) normalizeDecisionFeedback(result.feedback);
  return result;
}

function selectedCampaignContracts(runtimeHealth, campaignContracts) {
  if (!Array.isArray(campaignContracts)) {
    throw new TypeError('Campaign intelligence contracts must be an array');
  }
  const evaluatedCampaignIds = new Set((runtimeHealth.campaignResults ?? [])
    .map((result) => String(result.campaignId ?? ''))
    .filter(Boolean));
  const contracts = campaignContracts
    .filter((contract) => evaluatedCampaignIds.has(String(contract?.campaignId ?? '')))
    .sort((left, right) => String(left.campaignId).localeCompare(String(right.campaignId)));
  for (const contract of contracts) {
    if (!contract || typeof contract !== 'object' || Array.isArray(contract)
        || typeof contract.campaignId !== 'string'
        || typeof contract.contractId !== 'string'
        || typeof contract.inputFingerprint !== 'string') {
      throw new TypeError('Campaign intelligence contract is invalid');
    }
  }
  return contracts;
}

function combinedFeedback(prior, suppliedFeedback) {
  const previous = normalizeDecisionFeedback(prior?.feedback);
  const supplied = normalizeDecisionFeedback(suppliedFeedback);
  const byId = new Map([...previous.records, ...supplied.records].map((record) => [
    record.feedbackId,
    record
  ]));
  return [...byId.values()].sort((left, right) => (
    left.observedAt.localeCompare(right.observedAt)
    || left.feedbackId.localeCompare(right.feedbackId)
  ));
}

function latestFeedback(records) {
  return records.at(-1) ?? null;
}

function decisionIdentity(signals) {
  const campaignId = signals[0].campaignId;
  const errorKey = signals[0].errorKey;
  return {
    decisionClass: 'protect',
    subject: { campaignId },
    operation: 'investigate-runtime-failure',
    correlationKey: `${campaignId}\0${errorKey}`
  };
}

function buildDecision(signals, inputFingerprint, actNowFailureCount, campaignContract, feedback) {
  const campaignId = signals[0].campaignId;
  const errorKey = signals[0].errorKey;
  const workflowIds = [...new Set(signals.map((signal) => signal.workflowId))].sort();
  const targetRepositoryIds = [...new Set(signals
    .map((signal) => signal.targetRepositoryId)
    .filter(Boolean))]
    .sort();
  const correlationKey = `${campaignId}\0${errorKey}`;
  const totalFailures = signals.reduce((total, signal) => total + signal.failureCount, 0);
  const totalRunAttempts = signals.reduce(
    (total, signal) => total + signal.distinctRunAttemptCount,
    0
  );
  const state = totalFailures >= actNowFailureCount ? 'act-now' : 'decide-soon';
  const evidenceReferenceCount = new Set(signals.flatMap(
    (signal) => signal.evidenceReferences
  )).size;
  const attributedSignalCount = signals.filter((signal) => signal.targetRepositoryId !== null).length;
  const quality = {
    ...normalizeEvidenceQuality({
      availability: 'available',
      completeness: campaignContract?.quality?.completeness ?? 'partial',
      freshness: {
        state: 'unknown',
        observedAt: latestTimestamp(signals)
      },
      coverage: {
        state: 'partial',
        numerator: signals.length,
        denominator: null
      },
      maturity: campaignContract?.quality?.maturity ?? 'unknown',
      provenance: {
        state: evidenceReferenceCount > 0 ? 'available' : 'missing',
        sources: [
          'runtime-health',
          ...(campaignContract ? [CAMPAIGN_INTELLIGENCE_CONTRACT.id] : [])
        ]
      },
      attributionCoverage: {
        state: attributedSignalCount === signals.length ? 'complete' : 'partial',
        numerator: attributedSignalCount,
        denominator: signals.length
      },
      contradictionState: 'unknown'
    }),
    correlationRule: 'exact-campaign-and-runtime-error-key',
    evidenceReferenceCount
  };
  return {
    measureId: INTELLIGENCE_MEASURE.id,
    measureVersion: INTELLIGENCE_MEASURE.version,
    decisionId: stableId('runtime-health-decision', decisionIdentity(signals)),
    inputFingerprint,
    decisionClass: 'protect',
    state,
    subject: {
      campaignId,
      workflowIds,
      targetRepositoryIds
    },
    recommendation: {
      operation: 'investigate-runtime-failure',
      errorKey,
      mode: 'review',
      dispatchable: false
    },
    alternatives: [
      {
        id: 'defer',
        action: 'defer',
        condition: 'Wait for another canonical runtime observation.'
      },
      {
        id: 'do-nothing',
        action: 'do-nothing',
        consequence: 'The observed failure condition remains unresolved.'
      },
      {
        id: 'obtain-additional-evidence',
        action: 'obtain-additional-evidence',
        evidence: 'Inspect the referenced workflow runs and bounded diagnostics.'
      }
    ],
    hardGates: [{
      id: 'execution-authority',
      status: 'not-evaluated',
      effect: 'dispatch-prohibited'
    }],
    consequences: {
      affectedPartitionCount: signals.length,
      observedFailureCount: totalFailures,
      distinctRunAttemptCount: totalRunAttempts
    },
    forecast: {
      method: 'observed-recurrence',
      probability: null,
      note: 'No model-generated probability is used.'
    },
    quality,
    sensitivity: [{
      parameter: 'actNowFailureCount',
      value: actNowFailureCount,
      currentState: state
    }],
    capacityRequirements: [],
    correlationGroup: {
      key: correlationKey,
      rule: 'exact-campaign-and-runtime-error-key',
      signalCount: signals.length
    },
    evidenceReferences: [...new Set(signals.flatMap(
      (signal) => signal.evidenceReferences
    ))].sort().slice(0, EVIDENCE_REFERENCE_LIMIT),
    campaignContract: campaignContract ? {
      contractId: campaignContract.contractId,
      inputFingerprint: campaignContract.inputFingerprint
    } : null,
    feedback,
    decisionTrace: {
      inputs: signals.map((signal) => ({
        signalId: signal.signalId,
        inputFingerprint: signal.inputFingerprint
      })),
      measureVersions: {
        [signals[0].measureId]: signals[0].measureVersion,
        [INTELLIGENCE_MEASURE.id]: INTELLIGENCE_MEASURE.version
      },
      rules: [
        'correlate exact campaign and runtime error key',
        'exclude observed targets outside declared scope',
        'suppress while recovery may be in progress',
        'preserve review-only advisory output'
      ],
      gates: ['execution authority is not evaluated'],
      assumptions: ['runtime-health error keys identify the same underlying condition'],
      thresholds: { actNowFailureCount },
      excludedAlternatives: [],
      capacityConstraints: [],
      tieBreakers: ['decision state priority', 'decisionId lexical order']
    },
    computedAt: latestTimestamp(signals)
  };
}

/**
 * Correlates deterministic measure signals into advisory Decisions.
 * This function does not admit Work, dispatch workers, or grant authority.
 */
export function computeIntelligencePortfolio(runtimeHealth, options = {}) {
  const actNowFailureCount = options.actNowFailureCount
    ?? DEFAULT_ACT_NOW_FAILURE_COUNT;
  if (!Number.isSafeInteger(actNowFailureCount) || actNowFailureCount < 1) {
    throw new TypeError('actNowFailureCount must be a positive safe integer');
  }
  const prior = previousResult(options.previousResult);
  const priorById = new Map((prior?.decisions ?? []).map((decision) => [
    String(decision.decisionId),
    decision
  ]));
  const campaignContracts = selectedCampaignContracts(
    runtimeHealth,
    options.campaignContracts ?? []
  );
  const contractByCampaign = new Map(campaignContracts.map((contract) => [
    contract.campaignId,
    contract
  ]));
  const feedbackRecords = combinedFeedback(prior, options.feedback);
  const feedbackByDecision = Map.groupBy(feedbackRecords, (record) => record.decisionId);
  const suppressions = [];
  const actionable = [];
  const signals = runtimeHealthSignals(runtimeHealth);
  for (const signal of signals) {
    if (signal.targetScopeMembership === 'observed-extra') {
      suppressions.push(suppression(
        signal,
        'outside-declared-target-scope',
        'Reconsider when the repository is explicitly enrolled.'
      ));
    } else if (signal.recoveryMayBeInProgress) {
      suppressions.push(suppression(
        signal,
        'recovery-in-progress',
        'Reconsider after the active run reaches a terminal state.'
      ));
    } else {
      actionable.push(signal);
    }
  }

  const groups = Map.groupBy(actionable, (signal) => (
    `${signal.campaignId}\0${signal.errorKey}`
  ));
  const decisions = [];
  const reusedDecisionIds = [];
  const currentDecisionIds = new Set();
  const appliedFeedbackIds = new Set();
  const staleFeedbackIds = new Set();
  for (const [, groupSignals] of [...groups.entries()].sort(([left], [right]) => (
    left.localeCompare(right)
  ))) {
    const campaignContract = contractByCampaign.get(groupSignals[0].campaignId) ?? null;
    const inputFingerprint = intelligenceFingerprint({
      measureId: INTELLIGENCE_MEASURE.id,
      measureVersion: INTELLIGENCE_MEASURE.version,
      actNowFailureCount,
      campaignContractFingerprint: campaignContract?.inputFingerprint ?? null,
      signals: groupSignals.map((signal) => ({
        signalId: signal.signalId,
        inputFingerprint: signal.inputFingerprint
      }))
    });
    const decisionId = stableId('runtime-health-decision', decisionIdentity(groupSignals));
    currentDecisionIds.add(decisionId);
    const decisionFeedback = feedbackByDecision.get(decisionId) ?? [];
    const matchingFeedback = decisionFeedback.filter((record) => (
      record.inputFingerprint === inputFingerprint
    ));
    for (const record of decisionFeedback) {
      if (record.inputFingerprint !== inputFingerprint) staleFeedbackIds.add(record.feedbackId);
    }
    const feedback = latestFeedback(matchingFeedback);
    if (feedback) appliedFeedbackIds.add(feedback.feedbackId);
    const candidate = buildDecision(
      groupSignals,
      inputFingerprint,
      actNowFailureCount,
      campaignContract,
      feedback
    );
    const previous = priorById.get(candidate.decisionId);
    if (feedback && TERMINAL_DISPOSITIONS.has(feedback.disposition)) {
      suppressions.push(suppression(
        groupSignals[0],
        'unchanged-terminal-result',
        'Reconsider when the input fingerprint changes.',
        candidate.decisionId
      ));
      continue;
    }
    if (previous?.inputFingerprint === inputFingerprint) {
      decisions.push(candidate);
      reusedDecisionIds.push(candidate.decisionId);
      continue;
    }
    decisions.push(candidate);
  }

  const statePriority = new Map([
    ['act-now', 0],
    ['decide-soon', 1],
    ['investigate', 2],
    ['watch', 3]
  ]);
  decisions.sort((left, right) => (
    (statePriority.get(left.state) ?? 99) - (statePriority.get(right.state) ?? 99)
    || String(left.decisionId).localeCompare(String(right.decisionId))
  ));
  suppressions.sort((left, right) => left.suppressionId.localeCompare(right.suppressionId));
  reusedDecisionIds.sort();
  const unmatchedFeedbackIds = feedbackRecords
    .filter((record) => !currentDecisionIds.has(record.decisionId))
    .map((record) => record.feedbackId)
    .sort();
  const evidenceQuality = normalizeEvidenceQuality({
    availability: 'available',
    completeness: campaignContracts.length === 0
      ? 'missing'
      : campaignContracts.every((contract) => contract.quality.completeness === 'complete')
        ? 'complete'
        : 'partial',
    freshness: { state: 'unknown', observedAt: latestTimestamp(signals) },
    coverage: {
      state: campaignContracts.length > 0 ? 'partial' : 'missing',
      numerator: campaignContracts.length,
      denominator: null
    },
    maturity: 'unknown',
    provenance: {
      state: signals.length > 0 ? 'available' : 'missing',
      sources: [
        'runtime-health',
        ...(campaignContracts.length > 0 ? [CAMPAIGN_INTELLIGENCE_CONTRACT.id] : [])
      ]
    },
    attributionCoverage: { state: 'unknown', numerator: null, denominator: null },
    contradictionState: 'unknown'
  });
  return {
    measureId: INTELLIGENCE_MEASURE.id,
    measureVersion: INTELLIGENCE_MEASURE.version,
    inputFingerprint: intelligenceFingerprint({
      runtimeHealthMeasureVersion: runtimeHealth.measureVersion,
      signalFingerprints: signals.map((signal) => signal.inputFingerprint),
      campaignContractFingerprints: campaignContracts.map((contract) => contract.inputFingerprint),
      feedbackIds: feedbackRecords.map((record) => record.feedbackId),
      actNowFailureCount
    }),
    evidenceQuality,
    evaluatedDecisionClasses: ['protect'],
    agentInvocations: 0,
    campaignContractCount: campaignContracts.length,
    campaignContracts,
    feedback: {
      contractId: DECISION_FEEDBACK_CONTRACT.id,
      contractVersion: DECISION_FEEDBACK_CONTRACT.version,
      recordCount: feedbackRecords.length,
      appliedCount: appliedFeedbackIds.size,
      staleCount: staleFeedbackIds.size,
      unmatchedCount: unmatchedFeedbackIds.length,
      staleFeedbackIds: [...staleFeedbackIds].sort(),
      unmatchedFeedbackIds,
      records: feedbackRecords
    },
    signalCount: signals.length,
    correlatedCandidateCount: groups.size,
    decisionCount: decisions.length,
    suppressionCount: suppressions.length,
    reusedDecisionIds,
    decisions,
    suppressions,
    asOf: latestTimestamp(signals)
  };
}
