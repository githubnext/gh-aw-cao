import { adaptCachedGhAwJsonl } from '../../src/data/adapters/gh-aw-logs.js';
import { CANONICAL_SCHEMA_VERSION } from '../../src/data/model/schema.js';
import { normalize } from '../../src/data/normalize/index.js';

/** @param {string} jsonl */
export function normalizedActivityShards(jsonl) {
  const batch = normalize(adaptCachedGhAwJsonl(jsonl).observations);
  const sourceRecords = jsonl.trim().split('\n').filter(Boolean).length;
  /**
   * @param {'runs' | 'records'} phase
   * @param {(keyof import('../../src/data/model/schema.js').CanonicalBatch)[]} collections
   */
  const encode = (phase, collections) => {
    const records = collections.flatMap((collection) =>
      batch[collection].map((record) => ({ kind: 'record', collection, record }))
    );
    return [
      {
        kind: 'metadata',
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        ingestionVersion: 3,
        sourceRecords,
        phase,
        records: records.length
      },
      ...records
    ].map((line) => JSON.stringify(line)).join('\n') + '\n';
  };
  return {
    runs: encode('runs', ['campaigns', 'repositories', 'workflows', 'runs']),
    records: encode('records', ['domains', 'tools', 'audits', 'issues'])
  };
}

/** @param {string} jsonl */
export function normalizedRunShard(jsonl) {
  return normalizedActivityShards(jsonl).runs;
}
