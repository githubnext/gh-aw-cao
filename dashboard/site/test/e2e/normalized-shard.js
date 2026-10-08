import { adaptCachedGhAwJsonl } from '../../src/data/adapters/gh-aw-logs.js';
import { CANONICAL_SCHEMA_VERSION } from '../../src/data/model/schema.js';
import { normalize } from '../../src/data/normalize/index.js';
import { projectAuditEvidence } from '../../src/data/model/audit-projection.js';

/** @param {string} jsonl */
export function normalizedActivityShards(jsonl) {
  const { batch, receipt } = projectAuditEvidence(normalize(adaptCachedGhAwJsonl(jsonl).observations));
  const sourceRecords = jsonl.trim().split('\n').filter(Boolean).length;
  /**
   * @param {'runs' | 'records'} phase
   * @param {(keyof import('../../src/data/model/schema.js').CanonicalBatch)[]} collections
   */
  const encode = (phase, collections) => {
    const records = collections.flatMap((collection) =>
      (batch[collection] ?? []).map((record) => ({ kind: 'record', collection, record }))
    );
    return [
      {
        kind: 'metadata',
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        ingestionVersion: 5,
        projection: receipt,
        sourceRecords,
        phase,
        records: records.length
      },
      ...records
    ].map((line) => JSON.stringify(line)).join('\n') + '\n';
  };
  return {
    runs: encode('runs', ['campaigns', 'repositories', 'workflows', 'runs', 'experiments', 'experimentAssignments']),
    records: encode('records', ['domains', 'tools', 'skills', 'friction', 'audits', 'issues',
      'operationalValues', 'graders', 'graderObservations', 'evals', 'evalObservations'])
  };
}

/** @param {string} jsonl */
export function normalizedRunShard(jsonl) {
  return normalizedActivityShards(jsonl).runs;
}
