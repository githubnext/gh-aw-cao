import { issueCoordinates, issueId, operationalValueId, repositoryId, runId, sourceId, workflowId } from '../model/ids.js';
import { canonicalTimestamp, requiredString } from '../model/schema.js';

/** @type {Record<import('../model/schema.js').EntityKind, keyof import('../model/schema.js').CanonicalBatch>} */
const COLLECTIONS = {
  campaign: 'campaigns',
  repository: 'repositories',
  workflow: 'workflows',
  run: 'runs',
  domain: 'domains',
  tool: 'tools',
  audit: 'audits',
  issue: 'issues',
  'operational-value': 'operationalValues'
};
const RUN_LINKED_COLLECTIONS = /** @type {const} */ (['domains', 'tools', 'audits', 'issues']);

/**
 * @param {unknown} value
 * @param {string} field
 */
function requiredIdentifier(value, field) {
  if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim()) {
    throw new TypeError(`${field} is required`);
  }
  return value;
}

/** @param {Record<string, unknown>} value */
function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
}

/** @param {import('../model/schema.js').CanonicalObservation} observation */
function identityFor(observation) {
  const data = observation.data;
  if (!['run', 'issue'].includes(observation.kind)
    && typeof data.id === 'string' && data.id.trim()) return data.id.trim();
  switch (observation.kind) {
    case 'campaign':
      return sourceId('campaign', observation.source, requiredIdentifier(data.slug, 'campaign.slug'));
    case 'repository': return repositoryId(requiredIdentifier(data.githubId, 'repository.githubId'));
    case 'workflow': return workflowId(requiredIdentifier(data.githubId, 'workflow.githubId'));
    case 'run': return runId(
      requiredString(data.owner, 'run.owner'),
      requiredString(data.repository, 'run.repository'),
      requiredIdentifier(data.githubRunId, 'run.githubRunId')
    );
    case 'issue': {
      const coordinates = data.owner !== undefined
        && data.repository !== undefined
        && data.number !== undefined
        ? data
        : issueCoordinates(requiredString(data.url, 'issue.url'));
      return issueId(
        requiredString(coordinates.owner, 'issue.owner'),
        requiredString(coordinates.repository, 'issue.repository'),
        requiredIdentifier(coordinates.number, 'issue.number')
      );
    }
    case 'operational-value':
      return operationalValueId(
        requiredString(data.repository, 'operationalValue.repository'),
        requiredString(data.valueId, 'operationalValue.valueId'),
        requiredString(data.timestamp, 'operationalValue.timestamp')
      );
    case 'domain':
    case 'tool':
    case 'audit':
      return sourceId(observation.kind, observation.source, observation.sourceId);
  }
}

/**
 * Sorts from least to most authoritative so deterministic enrichment applies
 * the winning observation last.
 *
 * @param {import('../model/schema.js').CanonicalObservation} left
 * @param {import('../model/schema.js').CanonicalObservation} right
 * @param {Record<string, number>} precedence
 */
function compareObservations(left, right, precedence) {
  return (precedence[left.source] ?? 0) - (precedence[right.source] ?? 0)
    || Date.parse(left.observedAt) - Date.parse(right.observedAt)
    || left.source.localeCompare(right.source)
    || left.sourceId.localeCompare(right.sourceId)
    || JSON.stringify(left.data).localeCompare(JSON.stringify(right.data));
}

/**
 * Assigns deterministic per-run sequence numbers to run-linked records.
 *
 * @param {Record<string, unknown>[]} records
 * @returns {Record<string, unknown>[]}
 */
export function orderRunRecords(records) {
  /** @type {Map<string, Record<string, unknown>[]>} */
  const byRun = new Map();
  for (const record of records) {
    const runId = requiredString(record.runId, 'record.runId');
    const runRecords = byRun.get(runId) ?? [];
    runRecords.push(record);
    byRun.set(runId, runRecords);
  }
  return [...byRun.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([, runRecords]) => runRecords
      .sort((left, right) => {
        const sameSource = left.source === right.source;
        const leftSequence = Number(left.sourceSequence);
        const rightSequence = Number(right.sourceSequence);
        if (sameSource && Number.isFinite(leftSequence) && Number.isFinite(rightSequence)) {
          const difference = leftSequence - rightSequence;
          if (difference) return difference;
        }
        return String(left.timestamp).localeCompare(String(right.timestamp))
          || String(left.id).localeCompare(String(right.id));
      })
      .map((record, sequence) => record.sequence === sequence ? record : { ...record, sequence }));
}

/**
 * Purely converts source-neutral observations into deterministic canonical
 * entities. Persistence is intentionally a separate boundary.
 *
 * @param {import('../model/schema.js').CanonicalObservation[]} observations
 * @param {{ sourcePrecedence?: Record<string, number> }} [options]
 * @returns {import('../model/schema.js').CanonicalBatch}
 */
export function normalize(observations, options = {}) {
  const sourcePrecedence = options.sourcePrecedence ?? {};
  /** @type {Record<keyof import('../model/schema.js').CanonicalBatch, Map<string, Record<string, unknown>>>} */
  const entities = {
    campaigns: new Map(),
    repositories: new Map(),
    workflows: new Map(),
    runs: new Map(),
    domains: new Map(),
    tools: new Map(),
    audits: new Map(),
    issues: new Map(),
    operationalValues: new Map()
  };

  const sorted = [...observations].sort((left, right) => compareObservations(left, right, sourcePrecedence));
  for (const observation of sorted) {
    const collection = COLLECTIONS[observation.kind];
    if (!collection) throw new TypeError(`Unsupported observation kind: ${observation.kind}`);
    const observedAt = canonicalTimestamp(observation.observedAt, 'observation.observedAt');
    const id = identityFor(observation);
    const current = entities[collection].get(id) ?? {};
    entities[collection].set(id, {
      ...current,
      ...withoutUndefined(observation.data),
      id,
      observedAt,
      provenance: {
        source: observation.source,
        sourceId: observation.sourceId,
        observedAt
      }
    });
  }

  const batch = /** @type {import('../model/schema.js').CanonicalBatch} */ (Object.fromEntries(
    Object.entries(entities).map(([collection, records]) => [
      collection,
      [...records.values()].sort((left, right) => String(left.id).localeCompare(String(right.id)))
    ])
  ));
  for (const collection of RUN_LINKED_COLLECTIONS) {
    batch[collection] = orderRunRecords(batch[collection]);
  }
  return batch;
}