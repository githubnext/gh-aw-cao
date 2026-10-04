/** Raw payloads remain upstream; these fields have no canonical query or lifecycle consumer. */
export const PRUNED_CANONICAL_FIELDS = /** @type {Readonly<Record<string, readonly string[]>>} */ (Object.freeze({
  runs: Object.freeze([
    'aic', 'number', 'intentionalFailure', 'tokenUsage', 'ambientContext',
    'workingSet', 'behaviorFingerprint', 'taskDomain', 'comparison',
    'agenticAssessments', 'graders', 'context', 'data', 'logsPayload',
    'logsPath', 'auditPath'
  ]),
  workflows: Object.freeze(['ghAwMetadata', 'ghAwManifest']),
  tools: Object.freeze(['isSkill', 'correlationId', 'payloadRef', 'sourceSequence', 'sequence', 'type', 'status', 'summary',
    'name', 'toolType', 'mcpServer', 'mcpTool', 'mcpServerVersion', 'mcpProtocolVersion', 'invocationCount', 'latencyMs']),
  skills: Object.freeze(['isSkill']),
  issues: Object.freeze([
    'issueState', 'issueClosed', 'issueStateReason', 'issueClosedAt',
    'issueStatusObservedAt'
  ])
}));

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
  return Object.fromEntries(Object.entries(record).filter(([field]) => !fields.includes(field)));
}
