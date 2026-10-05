import { createDebug } from '../../debug.js';
import { sourceId } from './ids.js';

const debugFields = createDebug('fields');

/** Raw payloads remain upstream; query-reconstructible values are not stored. */
export const PRUNED_CANONICAL_FIELDS = /** @type {Readonly<Record<string, readonly string[]>>} */ (Object.freeze({
  runs: Object.freeze([
    'aic', 'number', 'intentionalFailure', 'tokenUsage', 'ambientContext',
    'workingSet', 'behaviorFingerprint', 'taskDomain', 'comparison',
    'agenticAssessments', 'graders', 'context', 'data', 'logsPayload',
    'logsPath', 'auditPath', 'repositoryFullName'
  ]),
  repositories: Object.freeze(['fullName']),
  workflows: Object.freeze([
    'ghAwMetadata', 'ghAwManifest', 'campaign', 'campaignName', 'campaignIcon',
    'campaignReadmePath', 'campaignAiCreditAllowance', 'campaignWorkerCount',
    'campaignInventoryWarnings', 'ghAwVersionLabel'
  ]),
  tools: Object.freeze(['isSkill']),
  skills: Object.freeze(['isSkill']),
  issues: Object.freeze([
    'issueState', 'issueClosed', 'issueStateReason', 'issueClosedAt',
    'issueStatusObservedAt'
  ]),
  audits: Object.freeze(['targetRepo']),
  graderObservations: Object.freeze(['sourceGraderId', 'resultTimestamp']),
  evalObservations: Object.freeze(['sourceEvalId', 'resultTimestamp', 'answer', 'requestedModel', 'resolvedModel'])
}));

/** @param {Record<string, unknown>} record @param {string} field @param {string} copy @param {boolean} [timestamp] */
function retainFact(record, field, copy, timestamp = false) {
  if (!Object.hasOwn(record, copy) || record[copy] === undefined) return record;
  if (record[field] === undefined) return { ...record, [field]: record[copy] };
  const fact = record[field];
  const duplicate = record[copy];
  const agrees = fact === duplicate || (timestamp && typeof fact === 'string' && typeof duplicate === 'string'
    && Number.isFinite(Date.parse(fact)) && Date.parse(fact) === Date.parse(duplicate));
  if (!agrees) {
    debugFields({ event: 'retain-fact-rejected', field, copy });
    throw new TypeError(`${field} conflicts with recomputable ${copy}`);
  }
  return record;
}

/** @param {Record<string, unknown>} record @param {string} copy @param {string} owner @param {string} repository */
function retainCoordinates(record, copy, owner, repository) {
  const value = record[copy];
  if (value === undefined || value === null) return record;
  if (typeof value !== 'string') throw new TypeError(`${copy} must be an owner/repository coordinate`);
  const coordinate = value.match(/^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)$/);
  if (!coordinate) {
    debugFields({ event: 'retain-coordinates-rejected', copy, reason: 'unmatched-coordinate' });
    throw new TypeError(`${copy} must be an owner/repository coordinate`);
  }
  for (const [field, value] of [[owner, coordinate[1]], [repository, coordinate[2]]]) {
    if (record[field] !== undefined && record[field] !== value) {
      throw new TypeError(`${field} conflicts with recomputable ${copy}`);
    }
  }
  return { ...record, [owner]: coordinate[1], [repository]: coordinate[2] };
}

/**
 * Applies the same pruning to newly normalized observations and published shards.
 * Unknown evidence is retained; this is not a query-only allowlist.
 * @param {string} collection
 * @param {Record<string, unknown>} record
 * @returns {Record<string, unknown>}
 */
export function pruneCanonicalRecord(collection, record) {
  const fields = PRUNED_CANONICAL_FIELDS[collection];
  if (!fields?.some((field) => Object.hasOwn(record, field))) return record;
  if (collection === 'audits') record = retainCoordinates(record, 'targetRepo', 'targetOrganization', 'targetRepository');
  if (collection === 'repositories') record = retainCoordinates(record, 'fullName', 'owner', 'name');
  if (collection === 'runs') record = retainCoordinates(record, 'repositoryFullName', 'owner', 'repository');
  if (collection === 'workflows' && record.campaignId == null && record.campaign != null && record.campaign !== '') {
    if (typeof record.campaign !== 'string' || !record.campaign.trim()) {
      debugFields({ event: 'campaign-slug-rejected' });
      throw new TypeError('workflow.campaign must be a nonempty slug');
    }
    record = { ...record, campaignId: sourceId('campaign', 'dashboard-sources', record.campaign.trim()) };
  }
  if (collection === 'graderObservations' || collection === 'evalObservations') {
    record = retainFact(record, 'timestamp', 'resultTimestamp', true);
  }
  if (collection === 'evalObservations') record = retainFact(record, 'evalResult', 'answer');
  return Object.fromEntries(Object.entries(record).filter(([field]) => !fields.includes(field)));
}
