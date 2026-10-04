// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DATABASE_NAME, openCanonicalDatabase, prepareCanonicalRecord, upsertCanonicalBatch
} from '../../src/data/storage/indexeddb.js';
import { normalize } from '../../src/data/normalize/index.js';
import { queryDatabaseSources, queryIndexedDatabaseSources } from '../../src/data/queries/database.js';
import { createDashboardQueryBudget, executeDashboardQueries } from '../../src/data/queries/declarative.js';

const at = '2026-10-03T14:00:00.000Z';
const metadata = { 'source-id': 'audits', 'source-kind': 'artifact', 'as-of': at, 'retrieved-at': at,
  availability: 'available', completeness: 'complete', freshness: 'fresh' };
const sources = { audits: { source: 'audits', rows: [], metadata } };
const query = {
  name: 'audit-counts', from: 'audits',
  aggregate: { by: ['run', 'run-attempt'], values: [{ field: 'event', as: 'events', reducer: 'count' }] }
};

/** @param {number} count */
async function seed(count) {
  const batch = normalize([]);
  batch.repositories.push({ id: 'repository:1' });
  batch.workflows.push({ id: 'workflow:1', repositoryId: 'repository:1', path: 'workflow.md' });
  batch.runs.push(...['42', '43'].map((run, index) => ({
    id: `run:${run}`, githubRunId: run, attempt: index + 1, owner: 'org', repository: 'repo',
    workflowPath: 'workflow.md', workflowId: 'workflow:1', repositoryId: 'repository:1', observedAt: at
  })));
  batch.audits = Array.from({ length: count }, (_, index) => ({
    id: `audit:${String(index).padStart(6, '0')}`, runId: index % 2 ? 'run:43' : 'run:42',
    source: 'audit', type: 'audit.finding', status: 'high', summary: index % 3 ? 'finding' : null,
    timestamp: at, observedAt: at
  }));
  await upsertCanonicalBatch(indexedDB, batch);
}

beforeEach(async () => {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
});
afterEach(() => vi.restoreAllMocks());

describe('native event indexes remain separate from compact Tool measures', () => {
  it('matches canonical event counts, attempts, and provenance', async () => {
    await seed(31);
    const canonical = await queryDatabaseSources(indexedDB, sources, ['audits']);
    const expected = executeDashboardQueries([query], canonical, [query.name]);
    const actual = await queryIndexedDatabaseSources(indexedDB, sources, [query], [query.name]);
    expect(actual[query.name].rows).toEqual(expected[query.name].rows);
    expect(actual[query.name].metadata).toEqual(expected[query.name].metadata);
  });

  it('counts native index groups without reading event documents', async () => {
    await seed(501);
    const original = IDBObjectStore.prototype.getAll;
    vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(/** @this {IDBObjectStore} */ function (...args) {
      if (this.name === 'audits') throw new Error('Event documents must not be materialized');
      return original.apply(this, args);
    });
    const result = await queryIndexedDatabaseSources(indexedDB, sources, [query], [query.name]);
    expect(result[query.name].rows.reduce((total, row) => total + Number(row.events), 0)).toBe(501);
  });

  it('preserves count versus distinct-count and source filters', async () => {
    await seed(39);
    const selected = { ...query, filter: { predicates: [{ field: 'run-attempt', equals: 2 }] },
      aggregate: { by: ['workflow'], values: [
        { field: 'event', as: 'events', reducer: 'count' }, { field: 'run', as: 'runs', reducer: 'distinct-count' }
      ] } };
    const native = await queryIndexedDatabaseSources(indexedDB, sources, [selected], [query.name]);
    expect(native[query.name].rows).toEqual([{ workflow: 'workflow.md', events: 19, runs: 1 }]);
  });

  it('keeps unavailable event evidence unavailable', async () => {
    await seed(7);
    const result = await queryIndexedDatabaseSources(indexedDB,
      { audits: { ...sources.audits, metadata: { ...metadata, availability: 'unavailable' } } },
      [query], [query.name]);
    expect(result[query.name].rows).toEqual([]);
    expect(result[query.name].metadata.availability).toBe('unavailable');
  });

  it('cancels rather than publishing stale indexed results', async () => {
    await seed(7);
    const controller = new AbortController();
    controller.abort();
    await expect(queryIndexedDatabaseSources(indexedDB, sources, [query], [query.name],
      { budget: createDashboardQueryBudget({ signal: controller.signal }) })).rejects.toThrow();
  });

  it('does not create old Tool event tuple indexes or accept event-grain Tool rows', async () => {
    const database = await openCanonicalDatabase(indexedDB);
    try {
      expect([...database.transaction('tools').objectStore('tools').indexNames]).toEqual(['byRun', 'byTool']);
      expect(() => prepareCanonicalRecord('tools', { id: 'old', runId: 'run:42', type: 'tool.call' })).toThrow('toolId');
    } finally {
      database.close();
    }
  });
});
