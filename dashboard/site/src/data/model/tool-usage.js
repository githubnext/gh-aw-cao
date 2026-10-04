import { identityDigest } from './digest.js';
import { canonicalTimestamp, requiredString } from './schema.js';

const IDENTITY_FIELDS = ['mcpServer', 'mcpTool', 'name', 'toolType', 'mcpServerVersion', 'mcpProtocolVersion'];
const CALL_TYPES = new Set(['tool.call', 'agent_tool_start', 'tool_call']);
const OUTCOME_TYPES = new Set(['tool.result', 'tool.error', 'agent_tool_done']);
const FAILED_STATUSES = new Set(['error', 'failure', 'failed']);

/** @param {string} kind @param {unknown} value */
export function toolMeasureId(kind, value) {
  return `${kind}:${identityDigest(JSON.stringify(value))}`;
}

/** @param {Record<string, unknown>} record @param {string[]} fields */
function identityTuple(record, fields) {
  return fields.map(field => Object.hasOwn(record, field) ? [true, record[field]] : [false]);
}

/** @param {Record<string, unknown>} record @param {string} field @param {number} value */
function add(record, field, value) {
  const total = Number(record[field]) + value;
  if (!Number.isFinite(total) || (field !== 'latencySum' && !Number.isSafeInteger(total))) {
    throw new RangeError(`Tool usage ${field} exceeds its exact numeric budget`);
  }
  record[field] = total;
}

/**
 * Aggregate deduplicated source events, never configured tools or inferred
 * executions. Each source owns its call grain; correlations never cross sources.
 * @param {Record<string, unknown>[]} events
 */
export function aggregateToolEvents(events) {
  /** @type {Map<string, Record<string, unknown>>} */
  const identities = new Map();
  /** @type {Map<string, Record<string, unknown>>} */
  const usages = new Map();
  /** @type {Map<string, Record<string, unknown>>} */
  const counters = new Map();
  /** @type {Map<string, { event: Record<string, unknown>, usage: Record<string, unknown> }[]>} */
  const correlations = new Map();
  const seen = new Set();
  /** @type {Map<string, string[]>} */
  const runEvidence = new Map();
  const ordered = [...events].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp))
    || String(a.id).localeCompare(String(b.id)));
  for (const event of ordered) {
    const eventId = requiredString(event.id, 'Tool event id');
    if (seen.has(eventId)) throw new TypeError(`Tool events must be deduplicated before aggregation: ${eventId}`);
    seen.add(eventId);
    const runId = requiredString(event.runId, 'Tool event runId');
    const source = requiredString(event.source, 'Tool event source');
    const timestamp = canonicalTimestamp(event.timestamp, 'Tool event timestamp');
    const observedAt = canonicalTimestamp(event.observedAt, 'Tool event observedAt');
    const evidence = runEvidence.get(runId) ?? [];
    evidence.push(identityDigest(JSON.stringify(Object.fromEntries(Object.entries(event).sort(([a], [b]) => a.localeCompare(b))))));
    runEvidence.set(runId, evidence);
    for (const field of IDENTITY_FIELDS) {
      if (Object.hasOwn(event, field) && event[field] !== null && typeof event[field] !== 'string') {
        throw new TypeError(`Observed Tool identity ${field} must be a string or null`);
      }
      for (const field of ['type', 'status']) {
        if (Object.hasOwn(event, field) && event[field] !== null && typeof event[field] !== 'string') {
          throw new TypeError(`Tool event ${field} must be a string or null`);
        }
      }
    }
    const toolId = toolMeasureId('observed-tool', identityTuple(event, IDENTITY_FIELDS));
    const previousIdentity = identities.get(toolId);
    identities.set(toolId, {
      id: toolId,
      ...Object.fromEntries(IDENTITY_FIELDS.filter(field => Object.hasOwn(event, field))
        .map(field => [field, event[field]])),
      observedAt: previousIdentity && String(previousIdentity.observedAt) > observedAt
        ? previousIdentity.observedAt : observedAt
    });
    const id = toolMeasureId('tool-usage', [runId, source, toolId]);
    let usage = usages.get(id);
    if (!usage) {
      usage = {
        id, runId, toolId, source, observedAt, timestamp, lastTimestamp: timestamp,
        eventCount: 0, callCount: 0, outcomeCount: 0, successCount: 0, failedCount: 0,
        incompleteCount: 0, unknownOutcomeCount: 0, unmatchedCount: 0, ambiguousCount: 0,
        requestBytes: 0, requestBytesCount: 0, responseBytes: 0, responseBytesCount: 0,
        latencySum: 0, latencyCount: 0
      };
      usages.set(id, usage);
    }
    add(usage, 'eventCount', 1);
    if (String(usage.observedAt) < observedAt) usage.observedAt = observedAt;
    if (String(usage.timestamp) > timestamp) usage.timestamp = timestamp;
    if (String(usage.lastTimestamp) < timestamp) usage.lastTimestamp = timestamp;
    const counterId = toolMeasureId('tool-counter', [id, timestamp.slice(0, 10), identityTuple(event, ['type', 'status'])]);
    let counter = counters.get(counterId);
    if (!counter) {
      counter = {
        id: counterId, runId, usageId: id, eventCount: 0, observedAt, timestamp, lastTimestamp: timestamp,
        requestBytes: 0, requestBytesCount: 0, responseBytes: 0, responseBytesCount: 0,
        ...Object.fromEntries(['type', 'status'].filter(field => Object.hasOwn(event, field))
          .map(field => [field, event[field]]))
      };
      counters.set(counterId, counter);
    }
    add(counter, 'eventCount', 1);
    if (String(counter.observedAt) < observedAt) counter.observedAt = observedAt;
    if (String(counter.timestamp) > timestamp) counter.timestamp = timestamp;
    if (String(counter.lastTimestamp) < timestamp) counter.lastTimestamp = timestamp;
    if (CALL_TYPES.has(String(event.type))) {
      add(usage, 'callCount', 1);
      usage.sampleCallId ??= eventId;
    } else if (OUTCOME_TYPES.has(String(event.type))) {
      add(usage, 'outcomeCount', 1);
      usage.sampleOutcomeId ??= eventId;
      add(usage, event.status === 'success' ? 'successCount'
        : event.status === 'incomplete' ? 'incompleteCount'
        : FAILED_STATUSES.has(String(event.status)) ? 'failedCount' : 'unknownOutcomeCount', 1);
    }
    if (CALL_TYPES.has(String(event.type)) || OUTCOME_TYPES.has(String(event.type))) {
      const correlation = typeof event.correlationId === 'string' && event.correlationId
        ? event.correlationId : ['unmatched', eventId];
      const key = JSON.stringify([runId, source, correlation]);
      const records = correlations.get(key) ?? [];
      records.push({ event, usage });
      correlations.set(key, records);
    }
  }
  for (const records of correlations.values()) {
    const calls = records.filter(({ event }) => CALL_TYPES.has(String(event.type)));
    const outcomes = records.filter(({ event }) => OUTCOME_TYPES.has(String(event.type)));
    const paired = calls.length === 1 && outcomes.length === 1
      && calls[0].usage.id === outcomes[0].usage.id;
    const ambiguous = calls.length > 1 || outcomes.length > 1
      || (calls.length === 1 && outcomes.length === 1 && !paired);
    if (!paired) {
      for (const { usage } of records) add(usage, ambiguous ? 'ambiguousCount' : 'unmatchedCount', 1);
    }
    for (const { event, usage } of calls) {
      const outcome = paired ? outcomes[0].event : undefined;
      const counter = counters.get(toolMeasureId('tool-counter', [
        usage.id, canonicalTimestamp(event.timestamp, 'Tool call timestamp').slice(0, 10), identityTuple(event, ['type', 'status'])
      ]));
      if (!counter) throw new Error('Tool call is missing its categorical counter');
      for (const field of ['requestBytes', 'responseBytes', 'latencyMs']) {
        if (event[field] !== undefined && event[field] !== null && outcome?.[field] !== undefined
            && outcome[field] !== null && event[field] !== outcome[field]) {
          throw new TypeError(`Correlated Tool ${field} measurements conflict`);
        }
        const input = event[field] ?? outcome?.[field];
        if (input === undefined || input === null) continue;
        if (typeof input !== 'number' || !Number.isFinite(input) || input < 0
            || (field !== 'latencyMs' && !Number.isSafeInteger(input))) {
          throw new TypeError(`Tool ${field} must be a finite nonnegative ${field === 'latencyMs' ? 'number' : 'safe integer'}`);
        }
        if (field === 'latencyMs') {
          add(usage, 'latencySum', input);
          add(usage, 'latencyCount', 1);
          usage.latencyMin = Math.min(Number(usage.latencyMin ?? input), input);
          usage.latencyMax = Math.max(Number(usage.latencyMax ?? input), input);
        } else {
          add(usage, field, input);
          add(usage, `${field}Count`, 1);
          add(counter, field, input);
          add(counter, `${field}Count`, 1);
        }
      }
    }
  }
  const sorted = (/** @type {Map<string, Record<string, unknown>>} */ map) =>
    [...map.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const revisions = new Map([...runEvidence].map(([id, evidence]) => [id, toolMeasureId('tool-evidence-revision', evidence)]));
  for (const usage of usages.values()) usage.evidenceRevision = revisions.get(String(usage.runId));
  for (const counter of counters.values()) counter.evidenceRevision = revisions.get(String(counter.runId));
  return { tools: sorted(usages), toolIdentities: sorted(identities), toolCounters: sorted(counters) };
}

/** @param {Record<string, unknown>} record */
export function validateToolUsage(record) {
  for (const field of ['toolId', 'runId', 'source', 'evidenceRevision']) requiredString(record[field], `Tool usage ${field}`);
  for (const field of ['eventCount', 'callCount', 'outcomeCount', 'successCount', 'failedCount',
    'incompleteCount', 'unknownOutcomeCount', 'unmatchedCount', 'ambiguousCount',
    'requestBytes', 'requestBytesCount', 'responseBytes', 'responseBytesCount', 'latencyCount']) {
    if (!Number.isSafeInteger(record[field]) || Number(record[field]) < 0) {
      throw new TypeError(`Tool usage ${field} must be a nonnegative safe integer`);
    }

  }
  if (Number(record.callCount) > Number(record.eventCount) || Number(record.outcomeCount) > Number(record.eventCount)
      || Number(record.callCount) + Number(record.outcomeCount) > Number(record.eventCount)
      || Number(record.successCount) + Number(record.failedCount) + Number(record.incompleteCount)
        + Number(record.unknownOutcomeCount) !== record.outcomeCount) {
    throw new TypeError('Tool usage counters do not preserve their observation grain');
  }
  if (record.eventCount === 0) throw new TypeError('Tool usage must contain observed events');
  if (typeof record.latencySum !== 'number' || !Number.isFinite(record.latencySum) || record.latencySum < 0
      || Number(record.requestBytesCount) > Number(record.callCount)
      || Number(record.responseBytesCount) > Number(record.callCount)
      || Number(record.latencyCount) > Number(record.callCount)) {
    throw new TypeError('Tool usage measurement denominators are invalid');
  }
  for (const field of ['timestamp', 'lastTimestamp', 'observedAt']) canonicalTimestamp(record[field], `Tool usage ${field}`);
  for (const [sum, count] of [['requestBytes', 'requestBytesCount'], ['responseBytes', 'responseBytesCount'], ['latencySum', 'latencyCount']]) {
    if (record[count] === 0 && record[sum] !== 0) throw new TypeError('Unknown Tool measurements cannot have nonzero sums');
  }
  if (String(record.timestamp) > String(record.lastTimestamp)) throw new TypeError('Tool usage time range is invalid');
  for (const field of ['latencyMin', 'latencyMax']) {
    if (record.latencyCount === 0 && Object.hasOwn(record, field)) throw new TypeError('Unknown Tool latency must not have extrema');
    if (Number(record.latencyCount) > 0 && (typeof record[field] !== 'number' || !Number.isFinite(record[field]) || Number(record[field]) < 0)) {
      throw new TypeError('Known Tool latency requires finite nonnegative extrema');
    }
  }
}

/**
 * A partial same-attempt Run enrichment does not revoke its current evidence.
 * An explicit revision (including null) or a different attempt replaces it.
 * @param {Record<string, unknown> | undefined} previous
 * @param {Record<string, unknown>} incoming
 */
export function mergeToolRunRevision(previous, incoming) {
  if (!previous || Object.hasOwn(incoming, 'toolUsageRevision') || incoming.attempt !== previous.attempt
      || !Object.hasOwn(previous, 'toolUsageRevision')) return incoming;
  return { ...incoming, toolUsageRevision: previous.toolUsageRevision };
}
