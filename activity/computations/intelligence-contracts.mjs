import { createHash } from 'node:crypto';
import {
  CAMPAIGN_INTELLIGENCE_FIELDS,
  canonicalIntelligenceValue,
  normalizeCampaignIntelligenceDeclaration
} from '../campaign-intelligence.mjs';

export { canonicalIntelligenceValue } from '../campaign-intelligence.mjs';

export const CAMPAIGN_INTELLIGENCE_CONTRACT = Object.freeze({
  id: 'campaign-intelligence-contract',
  version: '1.1.0'
});

export const DECISION_FEEDBACK_CONTRACT = Object.freeze({
  id: 'decision-feedback',
  version: '1.0.0'
});

export const EVIDENCE_QUALITY_CONTRACT = Object.freeze({
  id: 'evidence-quality',
  version: '1.0.0'
});

export const DECISION_FEEDBACK_DISPOSITIONS = Object.freeze([
  'accepted',
  'rejected',
  'deferred',
  'superseded',
  'recovered',
  'expired',
  'unresolved'
]);

const FEEDBACK_DISPOSITIONS = new Set(DECISION_FEEDBACK_DISPOSITIONS);
const MAX_FEEDBACK_RECORDS = 1_000;
const MAX_TEXT_LENGTH = 4_000;
function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function intelligenceFingerprint(value) {
  const canonical = JSON.stringify(canonicalIntelligenceValue(value));
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export function stableIntelligenceId(prefix, value) {
  return `${prefix}:${intelligenceFingerprint(value).slice('sha256:'.length, 'sha256:'.length + 24)}`;
}

function nullableString(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string or null`);
  return value.trim() || null;
}

function requiredString(value, field) {
  const normalized = nullableString(value, field);
  if (normalized === null) throw new TypeError(`${field} is required`);
  return normalized;
}

function boundedString(value, field) {
  const normalized = nullableString(value, field);
  if (normalized !== null && normalized.length > MAX_TEXT_LENGTH) {
    throw new TypeError(`${field} must not exceed ${MAX_TEXT_LENGTH} characters`);
  }
  return normalized;
}

function canonicalTimestamp(value, field) {
  const normalized = requiredString(value, field);
  if (!Number.isFinite(Date.parse(normalized))) throw new TypeError(`${field} must be an ISO 8601 timestamp`);
  return new Date(normalized).toISOString();
}

function numericEvidence(value) {
  if (value === undefined || value === null || value === '') return { state: 'missing', value: null };
  if (typeof value !== 'number' || !Number.isFinite(value)) return { state: 'malformed', value: null };
  return { state: value === 0 ? 'zero' : 'available', value };
}

function dimension(value, allowed, fallback = 'unknown') {
  const state = typeof value === 'string'
    ? value
    : isPlainObject(value) && typeof value.state === 'string'
      ? value.state
      : fallback;
  return allowed.has(state) ? state : 'malformed';
}

function coverageDimension(value) {
  const allowed = new Set([
    'complete', 'partial', 'zero', 'missing', 'unavailable', 'conflicting', 'malformed', 'unknown'
  ]);
  if (!isPlainObject(value)) {
    return { state: value === undefined ? 'unknown' : 'malformed', numerator: null, denominator: null };
  }
  const state = dimension(value, allowed);
  const numerator = value.numerator === undefined || value.numerator === null
    ? null
    : Number(value.numerator);
  const denominator = value.denominator === undefined || value.denominator === null
    ? null
    : Number(value.denominator);
  const validCounts = (numerator === null || (Number.isFinite(numerator) && numerator >= 0))
    && (denominator === null || (Number.isFinite(denominator) && denominator >= 0))
    && (numerator === null || denominator === null || numerator <= denominator);
  return {
    state: validCounts ? state : 'malformed',
    numerator: validCounts ? numerator : null,
    denominator: validCounts ? denominator : null
  };
}

export function normalizeEvidenceQuality(value = {}) {
  if (!isPlainObject(value)) {
    return {
      contractId: EVIDENCE_QUALITY_CONTRACT.id,
      contractVersion: EVIDENCE_QUALITY_CONTRACT.version,
      availability: 'malformed',
      completeness: 'malformed',
      freshness: { state: 'malformed', observedAt: null },
      coverage: { state: 'malformed', numerator: null, denominator: null },
      maturity: 'malformed',
      provenance: { state: 'malformed', sources: [] },
      attributionCoverage: { state: 'malformed', numerator: null, denominator: null },
      contradictionState: 'malformed'
    };
  }
  const availability = dimension(value.availability, new Set([
    'available', 'missing', 'unavailable', 'malformed', 'unknown'
  ]));
  const completeness = dimension(value.completeness, new Set([
    'complete', 'partial', 'missing', 'unavailable', 'conflicting', 'malformed', 'unknown'
  ]));
  const freshnessValue = isPlainObject(value.freshness)
    ? value.freshness
    : { state: value.freshness };
  const freshnessState = dimension(freshnessValue, new Set([
    'fresh', 'stale', 'missing', 'unavailable', 'malformed', 'unknown'
  ]));
  const observedAt = typeof freshnessValue.observedAt === 'string'
    && Number.isFinite(Date.parse(freshnessValue.observedAt))
    ? new Date(freshnessValue.observedAt).toISOString()
    : null;
  const normalizedFreshnessState = (
    freshnessValue.observedAt !== undefined && freshnessValue.observedAt !== null
    && observedAt === null
  ) || (['fresh', 'stale'].includes(freshnessState) && observedAt === null)
    ? 'malformed'
    : freshnessState;
  const maturity = dimension(value.maturity, new Set([
    'mature', 'immature', 'missing', 'unavailable', 'malformed', 'unknown'
  ]));
  const provenanceValue = isPlainObject(value.provenance)
    ? value.provenance
    : { state: value.provenance };
  const provenanceState = dimension(provenanceValue, new Set([
    'available', 'partial', 'missing', 'unavailable', 'conflicting', 'malformed', 'unknown'
  ]));
  const sources = Array.isArray(provenanceValue.sources)
    ? [...new Set(provenanceValue.sources.map((source) => String(source).trim()).filter(Boolean))].sort()
    : [];
  const contradictionState = dimension(value.contradictionState, new Set([
    'not-observed', 'conflicting', 'malformed', 'unknown'
  ]));
  return {
    contractId: EVIDENCE_QUALITY_CONTRACT.id,
    contractVersion: EVIDENCE_QUALITY_CONTRACT.version,
    availability,
    completeness,
    freshness: { state: normalizedFreshnessState, observedAt },
    coverage: coverageDimension(value.coverage),
    maturity,
    provenance: { state: provenanceState, sources },
    attributionCoverage: coverageDimension(value.attributionCoverage),
    contradictionState
  };
}

function declaredValue(contract, field) {
  if (!Object.hasOwn(contract, field) || contract[field] === undefined) return null;
  return canonicalIntelligenceValue(contract[field]);
}

function latestObservedAt(records) {
  return records
    .map((record) => record?.observedAt)
    .filter((value) => typeof value === 'string' && Number.isFinite(Date.parse(value)))
    .map((value) => new Date(value).toISOString())
    .sort()
    .at(-1) ?? null;
}

function campaignWorkflows(workflows, campaignId) {
  return workflows
    .filter((workflow) => String(workflow.campaignId ?? '') === campaignId)
    .map((workflow) => ({
      workflowId: requiredString(workflow.id, 'workflow.id'),
      role: nullableString(workflow.role, 'workflow.role'),
      state: nullableString(workflow.state, 'workflow.state'),
      rolloutMode: nullableString(workflow.rolloutMode, 'workflow.rolloutMode'),
      maxAiCredits: numericEvidence(workflow.maxAiCredits)
    }))
    .sort((left, right) => left.workflowId.localeCompare(right.workflowId));
}

export function compileCampaignIntelligenceContracts(campaigns, workflows) {
  if (!Array.isArray(campaigns) || !Array.isArray(workflows)) {
    throw new TypeError('Campaign intelligence compilation requires campaign and workflow arrays');
  }
  return campaigns.map((campaign) => {
    if (!isPlainObject(campaign)) throw new TypeError('Campaign intelligence inputs must be objects');
    const campaignId = requiredString(campaign.id, 'campaign.id');
    const declaration = campaign.intelligenceDeclaration === undefined
      || campaign.intelligenceDeclaration === null
      ? null
      : normalizeCampaignIntelligenceDeclaration(campaign.intelligenceDeclaration, {
          expectedCampaign: requiredString(campaign.slug, 'campaign.slug'),
          label: `Campaign ${campaignId} intelligence declaration`
        });
    const declared = declaration?.fields ?? (
      isPlainObject(campaign.intelligenceContract) ? campaign.intelligenceContract : {}
    );
    const relevantWorkflows = workflows.filter((workflow) => (
      String(workflow.campaignId ?? '') === campaignId
    ));
    const workflowContracts = campaignWorkflows(relevantWorkflows, campaignId);
    const explicitTargets = Array.isArray(campaign.targets) && campaign.targets.length > 0
      ? canonicalIntelligenceValue(campaign.targets)
      : null;
    const resourceEnvelope = declaredValue(declared, 'resourceEnvelope') ?? {
      monthlyAiCreditBudget: numericEvidence(campaign.monthlyAiCreditBudget),
      aiCreditAllowance: numericEvidence(campaign.aiCreditAllowance),
      humanAttention: { state: 'missing', value: null },
      workflows: workflowContracts.map((workflow) => ({
        workflowId: workflow.workflowId,
        maxAiCredits: workflow.maxAiCredits
      }))
    };
    const semantic = {
      repositoryNativeProblem: declaredValue(declared, 'repositoryNativeProblem'),
      eligibleOpportunity: declaredValue(declared, 'eligibleOpportunity'),
      intendedOutcome: declaredValue(declared, 'intendedOutcome'),
      outcomeAttainmentEvidence: declaredValue(declared, 'outcomeAttainmentEvidence'),
      targetPopulation: declaredValue(declared, 'targetPopulation') ?? explicitTargets,
      interventionClass: declaredValue(declared, 'interventionClass'),
      triggerAndSchedule: declaredValue(declared, 'triggerAndSchedule'),
      scheduleRationale: declaredValue(declared, 'scheduleRationale'),
      maxDetectionDelay: declaredValue(declared, 'maxDetectionDelay'),
      resourceEnvelope,
      overlapIdentity: declaredValue(declared, 'overlapIdentity'),
      outputApprovalPolicy: declaredValue(declared, 'outputApprovalPolicy'),
      maturationPeriod: declaredValue(declared, 'maturationPeriod'),
      deduplication: declaredValue(declared, 'deduplication'),
      backoff: declaredValue(declared, 'backoff'),
      stopConditions: declaredValue(declared, 'stopConditions'),
      operationalValueDefinition: declaredValue(declared, 'operationalValueDefinition')
    };
    const declaredFieldCount = CAMPAIGN_INTELLIGENCE_FIELDS
      .filter((field) => semantic[field] !== null).length;
    const provenanceSources = [campaign, ...relevantWorkflows]
      .map((record) => record?.provenance?.source)
      .filter(Boolean);
    if (declaration) provenanceSources.push('campaign-intelligence-declaration');
    const quality = normalizeEvidenceQuality({
      availability: 'available',
      completeness: declaredFieldCount === CAMPAIGN_INTELLIGENCE_FIELDS.length
        ? 'complete'
        : 'partial',
      freshness: {
        state: 'unknown',
        observedAt: latestObservedAt([campaign, ...relevantWorkflows])
      },
      coverage: {
        state: declaredFieldCount === CAMPAIGN_INTELLIGENCE_FIELDS.length ? 'complete' : 'partial',
        numerator: declaredFieldCount,
        denominator: CAMPAIGN_INTELLIGENCE_FIELDS.length
      },
      maturity: 'unknown',
      provenance: {
        state: provenanceSources.length > 0 ? 'available' : 'missing',
        sources: provenanceSources
      },
      attributionCoverage: { state: 'unknown', numerator: null, denominator: null },
      contradictionState: 'unknown'
    });
    const contract = {
      contractId: stableIntelligenceId('campaign-intelligence-contract', { campaignId }),
      contractVersion: CAMPAIGN_INTELLIGENCE_CONTRACT.version,
      campaignId,
      campaignSlug: nullableString(campaign.slug, 'campaign.slug'),
      declaration: declaration ? {
        contractVersion: declaration.contractVersion,
        campaign: declaration.campaign
      } : null,
      ...semantic,
      authorityContext: {
        mode: nullableString(campaign.mode, 'campaign.mode'),
        enabled: typeof campaign.enabled === 'boolean' ? campaign.enabled : null,
        maxRepositories: numericEvidence(campaign.maxRepositories),
        rolloutPercent: numericEvidence(campaign.rolloutPercent),
        targets: explicitTargets
      },
      workflows: workflowContracts,
      quality
    };
    return {
      ...contract,
      inputFingerprint: intelligenceFingerprint(contract)
    };
  }).sort((left, right) => left.campaignId.localeCompare(right.campaignId));
}

function feedbackRecord(value, index) {
  if (!isPlainObject(value)) throw new TypeError(`feedback.records[${index}] must be an object`);
  const decisionId = requiredString(value.decisionId, `feedback.records[${index}].decisionId`);
  const inputFingerprint = requiredString(
    value.inputFingerprint,
    `feedback.records[${index}].inputFingerprint`
  );
  if (!/^sha256:[a-f0-9]{64}$/.test(inputFingerprint)) {
    throw new TypeError(`feedback.records[${index}].inputFingerprint is invalid`);
  }
  const disposition = requiredString(value.disposition, `feedback.records[${index}].disposition`);
  if (!FEEDBACK_DISPOSITIONS.has(disposition)) {
    throw new TypeError(`feedback.records[${index}].disposition is invalid`);
  }
  const observedAt = canonicalTimestamp(value.observedAt, `feedback.records[${index}].observedAt`);
  const record = {
    decisionId,
    inputFingerprint,
    disposition,
    observedAt,
    actor: boundedString(value.actor, `feedback.records[${index}].actor`),
    authority: boundedString(value.authority, `feedback.records[${index}].authority`),
    selectedAlternativeId: boundedString(
      value.selectedAlternativeId,
      `feedback.records[${index}].selectedAlternativeId`
    ),
    rationale: boundedString(value.rationale, `feedback.records[${index}].rationale`),
    actualCost: value.actualCost === undefined ? null : canonicalIntelligenceValue(value.actualCost),
    outcomeDisposition: boundedString(
      value.outcomeDisposition,
      `feedback.records[${index}].outcomeDisposition`
    ),
    operationalValueMovement: value.operationalValueMovement === undefined
      ? null
      : canonicalIntelligenceValue(value.operationalValueMovement),
    unexpectedEffects: value.unexpectedEffects === undefined
      ? null
      : canonicalIntelligenceValue(value.unexpectedEffects),
    forecastAccuracy: value.forecastAccuracy === undefined
      ? null
      : canonicalIntelligenceValue(value.forecastAccuracy)
  };
  return {
    feedbackId: stableIntelligenceId('decision-feedback', record),
    ...record
  };
}

export function normalizeDecisionFeedback(value) {
  if (value === undefined || value === null) {
    return {
      contractId: DECISION_FEEDBACK_CONTRACT.id,
      contractVersion: DECISION_FEEDBACK_CONTRACT.version,
      records: []
    };
  }
  if (!isPlainObject(value)
      || value.contractVersion !== DECISION_FEEDBACK_CONTRACT.version
      || !Array.isArray(value.records)) {
    throw new TypeError('Decision feedback must contain a supported contractVersion and records array');
  }
  if (value.records.length > MAX_FEEDBACK_RECORDS) {
    throw new TypeError(`Decision feedback must not exceed ${MAX_FEEDBACK_RECORDS} records`);
  }
  const records = value.records.map(feedbackRecord).sort((left, right) => (
    left.observedAt.localeCompare(right.observedAt)
    || left.feedbackId.localeCompare(right.feedbackId)
  ));
  const identities = new Set();
  for (const record of records) {
    const identity = `${record.decisionId}\0${record.inputFingerprint}\0${record.observedAt}`;
    if (identities.has(identity)) {
      throw new TypeError('Decision feedback contains duplicate decision, fingerprint, and timestamp records');
    }
    identities.add(identity);
  }
  return {
    contractId: DECISION_FEEDBACK_CONTRACT.id,
    contractVersion: DECISION_FEEDBACK_CONTRACT.version,
    records
  };
}
