import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { processDataRequest } from '../../src/data-worker.js';
import { normalize } from '../../src/data/normalize/index.js';
import { DATABASE_NAME, upsertCanonicalBatch } from '../../src/data/storage/indexeddb.js';

const observedAt = '2026-10-02T00:00:00Z';
const queries = [{
  name: 'paged-tools', from: 'tools', select: [{ field: 'event' }],
  'order-by': [{ field: 'event', direction: 'asc' }]
}];

/** @param {string[]} ids */
async function seed(ids) {
  const batch = normalize([]);
  batch.tools = ids.map((id) => ({
    id, runId: 'run:fixture', source: 'mcp', type: 'tool.call',
    timestamp: observedAt, observedAt
  }));
  await upsertCanonicalBatch(indexedDB, batch, { validateRelationships: false });
}

/** @param {string} generation @param {string} [continuationToken] */
async function load(generation, continuationToken) {
  return /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (
    await processDataRequest({
      operation: 'load-dashboard-query-sources', queries, sourceNames: ['paged-tools'],
      sources: {
        tools: {
          source: 'tools', rows: [],
          metadata: {
            'as-of': observedAt, 'retrieved-at': observedAt,
            'artifact-generation': generation, availability: 'available'
          }
        }
      },
      pagination: { 'paged-tools': { limit: 1, continuationToken } }
    })
  );
}

beforeEach(async () => {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
});

describe('worker continuation source revisions', () => {
  it('continues the same source generation without repeating observations', async () => {
    await seed(['a', 'b']);
    const first = (await load('v1'))['paged-tools'];
    expect(first.rows).toEqual([{ event: 'a' }]);
    expect(first.continuationToken).toEqual(expect.any(String));
    const second = (await load('v1', first.continuationToken))['paged-tools'];
    expect(second.rows).toEqual([{ event: 'b' }]);
  });

  it('rejects an old token after the source generation changes', async () => {
    await seed(['a', 'b']);
    const first = (await load('v1'))['paged-tools'];
    await seed(['0', 'a', 'b']);
    await expect(load('v2', first.continuationToken)).rejects.toThrow(/stale/i);
  });
});
