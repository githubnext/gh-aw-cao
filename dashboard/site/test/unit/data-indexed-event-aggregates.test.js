// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DATABASE_NAME, openCanonicalDatabase, queryCollectionCountGroups, readCollections
} from '../../src/data/storage/indexeddb.js';
import { queryDatabaseSources, queryIndexedDatabaseSources } from '../../src/data/queries/database.js';
import { executeDashboardQueries } from '../../src/data/queries/declarative.js';
import { processDataRequest } from '../../src/data-worker.js';
import { authoritativeDashboard } from '../authoritative-dashboard.js';

const metadata = /** @type {import('../../src/presenter.js').SourceMetadata} */ ({
  'source-id': 'test-events', 'source-kind': 'artifact', 'retrieved-at': '2026-10-02T20:00:00Z',
  'as-of': '2026-10-02T20:00:00Z', 'artifact-generation': 'indexed-events',
  availability: 'available', completeness: 'complete', freshness: 'fresh'
});
const identity = { organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/activity.md' };
const sources = {
  campaigns: { rows: [{ campaign: 'activity', 'campaign-enabled': true }], metadata },
  repositories: { rows: [identity], metadata },
  workflows: { rows: [{ ...identity, campaign: 'activity' }], metadata },
  runs: {
    rows: [1, 2].map((attempt) => ({
      ...identity, run: '42', 'run-attempt': attempt, 'started-at': metadata['as-of'],
      'run-status': 'completed', 'run-conclusion': 'success'
    })),
    metadata
  },
  tools: { rows: [], metadata }, audits: { rows: [], metadata },
  domains: { rows: [], metadata }, issues: { rows: [], metadata }
};
const queries = /** @type {import('../../src/data/queries/declarative.js').DashboardQuery[]} */ (authoritativeDashboard.dashboard.queries).filter((query) => [
  'audit-event-runs', 'domain-event-runs', 'tool-event-runs', 'issue-event-runs',
  'event-runs', 'audit-event-summary-buckets'
].includes(query.name));
const context = { pages: [], queries };

/** @param {Record<string, unknown[]>} records */
async function put(records) {
  const database = await openCanonicalDatabase(indexedDB);
  try {
    for (const [storeName, rows] of Object.entries(records)) {
      for (let offset = 0; offset < rows.length; offset += 10000) {
        await new Promise((resolve, reject) => {
          const transaction = database.transaction(storeName, 'readwrite');
          const store = transaction.objectStore(storeName);
          for (const row of rows.slice(offset, offset + 10000)) store.put(row);
          transaction.oncomplete = () => resolve(undefined);
          transaction.onerror = () => reject(transaction.error);
        });
      }
    }
  } finally {
    database.close();
  }
}

/** @param {number} count @param {string} prefix */
async function events(count, prefix) {
  const runs = (await readCollections(indexedDB, ['runs'])).runs;
  return Array.from({ length: count }, (_, position) => ({
    id: `${prefix}:${String(position).padStart(7, '0')}`,
    runId: runs[position % 2].id, type: 'audit.finding',
    status: position % 3 === 0 ? 'medium' : 'high',
    summary: position % 5 === 0 ? null : `finding-${position % 4}`,
    timestamp: metadata['as-of'], source: 'audit'
  }));
}

/** @param {string[]} names @param {unknown[]} [definitions] */
function workerQuery(names, definitions = queries) {
  return /** @type {Promise<Record<string, import('../../src/presenter.js').LogicalSourceInput>>} */ (processDataRequest({
    operation: 'query-canonical-dashboard', sourceNames: names,
    context: { ...context, queries: definitions }
  }));
}

beforeEach(async () => {
  vi.stubGlobal('self', { postMessage: () => {} });
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
  vi.stubGlobal('fetch', vi.fn(async (url) => ({
    ok: !String(url).endsWith('/sources/manifest.json'),
    status: String(url).endsWith('/sources/manifest.json') ? 404 : 200,
    json: async () => structuredClone(sources)
  })));
  await processDataRequest({
    operation: 'load-canonical-dashboard', sourceUrl: 'https://dashboard.example/sources.json',
    sourceNames: [], context
  });
  const [run] = (await readCollections(indexedDB, ['runs'])).runs;
  await put({ runs: [
    { ...run, id: `${String(run.id)}:attempt-one`, attempt: 1 },
    { ...run, attempt: 2 }
  ] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('indexed run-owned event aggregates at the production worker boundary', () => {
  it('matches canonical counts, buckets, attempts, and provenance on a small dataset', async () => {
    await put({ tools: await events(31, 'tool'), audits: await events(17, 'audit') });
    const canonical = await queryDatabaseSources(indexedDB, sources, ['tools', 'audits', 'domains', 'issues', 'workflows']);
    const expected = executeDashboardQueries(queries, canonical, ['event-runs', 'audit-event-summary-buckets']);
    const actual = await workerQuery(['event-runs', 'audit-event-summary-buckets']);
    for (const name of Object.keys(expected)) {
      expect(actual[name].rows).toEqual(expected[name].rows);
      expect(actual[name].metadata).toEqual(expected[name].metadata);
    }
    expect(actual['event-runs'].rows.map((row) => row['run-attempt']).sort()).toEqual([1, 2]);
  });

  it('counts native index groups without reading event documents', async () => {
    const count = 501;
    const [run] = (await readCollections(indexedDB, ['runs'])).runs;
    const tools = (await events(count, 'tool')).map((event) => ({
      ...event, runId: run.id, status: 'high', summary: 'retained finding'
    }));
    const audits = (await events(count + 1, 'audit')).map((event) => ({
      ...event, runId: run.id, status: 'high', summary: null
    }));
    await put({ tools, audits });
    const getAll = IDBObjectStore.prototype.getAll;
    vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(/** @this {IDBObjectStore} */ function (...args) {
      if (['tools', 'audits'].includes(this.name)) throw new Error('Event documents must not be materialized');
      return getAll.apply(this, args);
    });
    const result = await workerQuery(['tool-event-runs', 'event-runs', 'audit-event-summary-buckets']);
    expect(result['tool-event-runs'].metadata.availability).toBe('available');
    expect(result['tool-event-runs'].rows.reduce((sum, row) => sum + Number(row.events), 0)).toBe(count);
    expect(result['event-runs'].rows.reduce((sum, row) => sum + Number(row.events), 0)).toBe(count * 2 + 1);
    const buckets = result['audit-event-summary-buckets'];
    expect(buckets.metadata.availability).toBe('available');
    expect(buckets.rows.reduce((sum, row) => sum + Number(row.events), 0)).toBe(count * 2 + 1);
    expect(buckets.rows.some((row) => row['event-summary'] === null)).toBe(true);
    expect(buckets.rows.every((row) => row.campaign === 'activity')).toBe(true);
  });

  it('preserves count versus distinct-count, filters, and fail-closed duplicate joins', async () => {
    await put({ tools: await events(39, 'tool') });
    const countQuery = /** @type {import('../../src/data/queries/declarative.js').DashboardQuery} */ ({
      name: 'renamed-count', from: 'tools',
      filter: { predicates: [{ field: 'run-attempt', equals: 2 }] },
      aggregate: {
        by: ['workflow'], values: [
          { field: 'event', as: 'records', reducer: 'count' },
          { field: 'run', as: 'runs', reducer: 'distinct-count' },
          { field: 'event', as: 'other-attempt', reducer: 'count',
            filter: { predicates: [{ field: 'run-attempt', equals: 1 }] } }
        ]
      }
    });
    const attributions = {
      source: 'attributions', metadata,
      rows: [{ ...identity, campaign: 'activity' }, { ...identity, campaign: 'activity' }]
    };
    const buckets = /** @type {import('../../src/data/queries/declarative.js').DashboardQuery} */ ({
      ...queries.find((query) => query.name === 'audit-event-summary-buckets'),
      name: 'renamed-buckets', from: 'tools', union: undefined,
      joins: [{
        source: 'attributions', type: 'left',
        on: [{ left: 'workflow', right: 'workflow' }],
        fields: [{ field: 'campaign', as: 'campaign' }]
      }]
    });
    const definitions = [countQuery, buckets];
    const logical = { ...sources, attributions };
    const canonical = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ ({
      ...await queryDatabaseSources(indexedDB, logical, ['tools']), attributions
    });
    expect(canonical.tools.rows[0]['event-type']).toBe('audit.finding');
    const expected = executeDashboardQueries(definitions, canonical, definitions.map((query) => query.name));
    const native = await queryIndexedDatabaseSources(indexedDB, logical, definitions, definitions.map((query) => query.name));
    expect(native['renamed-count'].rows).toEqual(expected['renamed-count'].rows);
    expect(native['renamed-count'].rows).toEqual([{ workflow: identity.workflow, records: 20, runs: 1, 'other-attempt': 0 }]);
    const identities = {
      name: 'event-identity-counts', from: 'tools',
      aggregate: {
        by: ['workflow'], values: [
          { field: 'event', as: 'records', reducer: 'count' },
          { field: 'event', as: 'events', reducer: 'distinct-count' },
          { field: 'run-attempt', as: 'attempts', reducer: 'distinct-count' }
        ]
      }
    };
    const countedIdentities = await queryIndexedDatabaseSources(indexedDB, logical, [identities], [identities.name]);
    expect(countedIdentities[identities.name].rows).toEqual(
      executeDashboardQueries([identities], canonical, [identities.name])[identities.name].rows
    );
    expect(countedIdentities[identities.name].rows).toEqual([{ workflow: identity.workflow, records: 39, events: 39, attempts: 2 }]);
    expect(native['renamed-buckets'].rows).toEqual(expected['renamed-buckets'].rows);
    expect(native['renamed-buckets'].metadata.availability).toBe('unavailable');
    expect(native['renamed-buckets'].metadata['query-diagnostic']).toContain('more than one row per join key');

    const distinctEvents = {
      ...buckets, name: 'distinct-events',
      aggregate: { by: ['campaign'], values: [{ field: 'event', as: 'events', reducer: 'distinct-count' }] }
    };
    expect(await queryIndexedDatabaseSources(indexedDB, logical, [distinctEvents], ['distinct-events'])).toEqual({});
    const unique = { ...canonical, attributions: { ...attributions, rows: [attributions.rows[0]] } };
    expect(executeDashboardQueries([{
      ...distinctEvents, select: [{ field: 'campaign' }, { field: 'events' }], 'order-by': undefined
    }], unique, ['distinct-events'])['distinct-events'].rows)
      .toEqual([{ campaign: 'activity', events: 39 }]);
  });

  it('keeps empty, unavailable, missing dimensions, and optional union semantics honest', async () => {
    await put({ tools: await events(7, 'tool') });
    const absent = { ...sources, audits: { rows: [], metadata: { ...metadata, availability: 'unavailable' } } };
    const native = await queryIndexedDatabaseSources(indexedDB, absent, queries, ['audit-event-runs', 'tool-event-runs']);
    expect(native['audit-event-runs'].metadata.availability).toBe('unavailable');
    expect(native['audit-event-runs'].rows).toEqual([]);
    expect(/** @type {import('../../src/presenter.js').LogicalSourceInput} */ (native['tool-event-runs'])
      .rows.reduce((sum, row) => sum + Number(row.events), 0)).toBe(7);
    const empty = {
      name: 'empty-count', from: 'tools', filter: { predicates: [{ field: 'run', equals: 'missing' }] },
      aggregate: { values: [{ field: 'event', as: 'events', reducer: 'count' }] }
    };
    expect((await workerQuery(['empty-count'], [empty]))['empty-count'].rows).toEqual([{ events: 0 }]);
    const summary = /** @type {import('../../src/data/queries/declarative.js').DashboardQuery} */ ({
      ...queries.find((query) => query.name === 'audit-event-summary-buckets'), from: 'tools', union: undefined
    });
    const runs = (await readCollections(indexedDB, ['runs'])).runs;
    await put({ tools: [
      { id: 'missing-status', runId: runs[0].id, type: 'audit.finding', summary: 'not selected' },
      { id: 'missing-summary', runId: runs[0].id, type: 'audit.finding', status: 'high' }
    ] });
    const result = await workerQuery([summary.name], [summary]);
    expect(result[summary.name].rows.reduce((sum, row) => sum + Number(row.events), 0)).toBe(8);
    expect(result[summary.name].metadata.availability).toBe('available');
    const canonical = await queryDatabaseSources(indexedDB, sources, ['tools', 'workflows']);
    expect(result[summary.name].rows).toEqual(executeDashboardQueries(
      [summary], canonical, [summary.name]
    )[summary.name].rows);
    const optionalUnion = { ...summary, from: 'audits', union: ['tools'] };
    await put({ audits: await events(4, 'audit') });
    const partial = await queryIndexedDatabaseSources(indexedDB, {
      ...sources, tools: { rows: [], metadata: { ...metadata, availability: 'unavailable' } }
    }, [optionalUnion], [optionalUnion.name]);
    expect(partial[optionalUnion.name].rows.reduce((sum, row) => sum + Number(row.events), 0)).toBe(4);
    expect(partial[optionalUnion.name].metadata.completeness).toBe('partial');
  });

  it('resolves scoped record selection chains through byRun rather than whole event stores', async () => {
    await put({ tools: await events(39, 'tool') });
    const definitions = [
      { name: 'scoped-records', from: 'tools',
        filter: { predicates: [{ field: 'organization', equals: identity.organization }, { field: 'run-attempt', equals: 1 }] } },
      { name: 'scoped-events', from: 'scoped-records',
        filter: { predicates: [{ field: 'event-summary', includes: 'finding-1' }] },
        select: [{ field: 'event' }, { field: 'run-attempt' }, { field: 'event-summary' }],
        'order-by': [{ field: 'event', direction: 'asc' }], limit: 2 }
    ];
    const canonical = await queryDatabaseSources(indexedDB, sources, ['tools']);
    const expected = executeDashboardQueries(definitions, canonical, ['scoped-events'])['scoped-events'];
    const getAll = IDBObjectStore.prototype.getAll;
    vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(/** @this {IDBObjectStore} */ function (...args) {
      if (this.name === 'tools') throw new Error('Unscoped record selection');
      return getAll.apply(this, args);
    });
    const result = await workerQuery(['scoped-events'], definitions);
    expect(result['scoped-events'].rows).toEqual(expected.rows);
    expect(result['scoped-events'].metadata.availability).toBe('available');
  });

  it('cancels native index aggregation rather than publishing stale native results', async () => {
    await put({ tools: await events(9, 'tool') });
    const signal = { aborted: false };
    const count = IDBIndex.prototype.count;
    vi.spyOn(IDBIndex.prototype, 'count').mockImplementation(/** @this {IDBIndex} */ function (...args) {
      signal.aborted = true;
      return count.apply(this, args);
    });
    await expect(queryIndexedDatabaseSources(indexedDB, sources, queries, ['tool-event-runs'], { signal }))
      .rejects.toMatchObject({ kind: 'aborted' });
  });

  it('fails closed rather than truncating oversized native group input', async () => {
    await put({ tools: await events(9, 'tool') });
    await expect(queryCollectionCountGroups(indexedDB, 'tools', {
      index: 'byTypeStatusRun', nullableIndex: 'byTypeStatusRunSummary', maxGroups: 2
    })).rejects.toThrow('max-input-rows');
  });
});
