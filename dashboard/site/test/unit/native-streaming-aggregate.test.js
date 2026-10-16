import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { openCanonicalDatabase, DATABASE_NAME, scanCanonicalCollection } from '../../src/data/storage/indexeddb.js';
import { loadDatabaseQuerySources, queryDatabaseSources, queryIndexedDatabaseSources } from '../../src/data/queries/database.js';
import { createDashboardQueryBudget, executeDashboardQueries } from '../../src/data/queries/declarative.js';
import { compileDashboardViewPayloadQueries } from '../../src/data/queries/view-payload-compiler.js';
import { incrementalAggregate } from '../../src/data/queries/incremental-aggregate.js';
import { authoritativeDashboard } from '../authoritative-dashboard.js';

const queries = authoritativeDashboard.dashboard.queries.filter(
  (/** @type {{ name: string }} */ query) => ['firewall-domain-totals', 'firewall-most-blocked-domains'].includes(query.name)
);
const firewall = authoritativeDashboard.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'firewall');

/** @param {number} count @param {boolean} [mixed] @param {number} [runCount] */
async function seed(count, mixed = false, runCount = 2) {
  const database = await openCanonicalDatabase(indexedDB);
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(['runs', 'domains'], 'readwrite');
      transaction.onerror = () => reject(transaction.error);
      transaction.oncomplete = () => resolve(undefined);
      for (let run = 1; run <= runCount; run++) transaction.objectStore('runs').put({
        id: `run:${run}`, githubRunId: String(run), owner: 'org', repository: 'repo', workflowPath: 'test.md'
      });
      for (let index = 0; index < count; index++) transaction.objectStore('domains').put({
        id: `event:${String(index).padStart(7, '0')}`,
        runId: `run:${mixed && index % 3 ? '2' : '1'}`,
        source: 'firewall', type: mixed && index % 2 ? 'net_allowed' : 'net_blocked',
        domain: mixed && index % 5 ? 'other.example' : 'example.com',
        decision: mixed && index % 2 ? 'allowed' : 'denied',
        requestCount: mixed ? index % 7 : 1, timestamp: '2026-10-15T00:00:00Z'
      });
    });
  } finally {
    database.close();
  }
}

afterEach(async () => {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
});

describe('native streaming canonical aggregates', () => {
  it('keeps workflow-level firewall evidence within the unchanged operation budget at deployed scale', async () => {
    await seed(350001, false, 10000);
    const name = 'firewall-domain-workflows';
    const budget = createDashboardQueryBudget();
    const result = await queryIndexedDatabaseSources(
      indexedDB, {}, authoritativeDashboard.dashboard.queries.filter(
        (/** @type {{ name: string }} */ query) => query.name === name
      ), [name], { budget }
    );
    expect(result[name].rows).toEqual([{
      domain: 'example.com', organization: 'org', repository: 'repo', workflow: 'test.md',
      'workflow-source-url': null, runs: 1, accepted: 0, blocked: 350001
    }]);
    expect(result[name].metadata.availability).toBe('available');
    expect(budget.operations).toBeLessThan(5000000);
  }, 240000);

  it('executes both production firewall view aliases above the 200000 observation boundary', async () => {
    await seed(200001, false, 10000);
    const compiled = compileDashboardViewPayloadQueries(firewall, 'firewall', {
      queries, sourceNames: ['firewall-most-blocked-domains', 'firewall-domain-totals']
    });
    const result = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (await loadDatabaseQuerySources(indexedDB, {}, {
      queries: [...queries, ...compiled.queries], sourceNames: compiled.aliases
    }));
    expect(compiled.aliases).toHaveLength(2);
    for (const alias of compiled.aliases) {
      expect(result[alias].rows).toEqual([
        { domain: 'example.com', run: 1, accepted: 0, blocked: 200001 }
      ]);
      expect(result[alias].metadata.availability).toBe('available');
      expect(result[alias].metadata['query-name']).toBe(alias);
    }
  }, 240000);

  it('matches ordinary projection and aggregate semantics across mixed batches and scope filters', async () => {
    await seed(3001, true);
    const compiled = compileDashboardViewPayloadQueries(firewall, 'firewall', {
      queries, sourceNames: ['firewall-most-blocked-domains'],
      queryContext: { timeWindow: { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' } }
    });
    const definitions = [...queries, ...compiled.queries];
    const observations = await queryDatabaseSources(indexedDB, {}, ['firewall-observations']);
    const ordinary = executeDashboardQueries(definitions, observations, compiled.aliases);
    const native = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (await loadDatabaseQuerySources(indexedDB, {}, {
      queries: definitions, sourceNames: compiled.aliases
    }));
    expect(native[compiled.aliases[0]].rows).toEqual(ordinary[compiled.aliases[0]].rows);
    expect(native[compiled.aliases[0]].rows).toHaveLength(2);
    const excluded = compileDashboardViewPayloadQueries(firewall, 'firewall', {
      queries, sourceNames: ['firewall-most-blocked-domains'],
      queryContext: { timeWindow: { start: '2026-11-01T00:00:00Z' } }
    });
    const empty = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (await loadDatabaseQuerySources(indexedDB, {}, {
      queries: [...queries, ...excluded.queries], sourceNames: excluded.aliases
    }));
    expect(empty[excluded.aliases[0]].rows).toEqual([]);
    expect(empty[excluded.aliases[0]].metadata.availability).toBe('empty');
  });

  it('preserves unavailable inputs and rejects unsupported reducers from the native path', async () => {
    const unavailable = await queryIndexedDatabaseSources(indexedDB, {
      domains: { rows: [], metadata: { availability: 'unavailable' } }
    }, queries, ['firewall-domain-totals']);
    expect(unavailable['firewall-domain-totals'].metadata.availability).toBe('unavailable');
    expect(await queryIndexedDatabaseSources(indexedDB, {}, [{
      name: 'unsupported', from: 'firewall-observations',
      aggregate: { values: [{ field: 'request-count', as: 'value', reducer: 'mean' }] }
    }], ['unsupported'])).toEqual({});
  });

  it('bounds storage batches, scans primary-key order, and aborts visitor failures', async () => {
    await seed(2001);
    /** @type {number[]} */
    const sizes = [];
    /** @type {unknown[]} */
    const keys = [];
    await scanCanonicalCollection(indexedDB, 'domains', (rows) => {
      sizes.push(rows.length);
      keys.push(...rows.map((row) => row.id));
    });
    expect(sizes).toEqual([1000, 1000, 1]);
    expect(keys).toEqual([...keys].sort());
    await expect(scanCanonicalCollection(indexedDB, 'domains', () => {}, { batchSize: 0 })).rejects.toThrow('batchSize');
    await expect(scanCanonicalCollection(indexedDB, 'domains', () => { throw new Error('visitor failed'); }))
      .rejects.toThrow('visitor failed');
  });

  it('preserves typed groups, conditional zero sums, and exact cross-batch distinct state', () => {
    const aggregate = {
      by: ['key'],
      values: [
        { field: 'run', as: 'runs', reducer: /** @type {const} */ ('distinct-count') },
        { field: 'n', as: 'total', reducer: /** @type {const} */ ('sum'), filter: { predicates: [{ field: 'decision', equals: 'allowed' }] } },
        { field: 'run', as: 'count', reducer: /** @type {const} */ ('count') }
      ]
    };
    const reducer = incrementalAggregate(aggregate, createDashboardQueryBudget());
    const rows = [
      { key: 1, run: '1', n: 2, decision: 'allowed' },
      { key: '1', run: '1', n: 5, decision: 'denied' },
      { key: 1, run: '1', n: '3', decision: 'allowed' }
    ];
    rows.forEach((row) => reducer.append([row]));
    const ordinary = executeDashboardQueries([{ name: 'test', from: 'input', aggregate }], {
      input: { source: 'input', rows, metadata: {
        'source-id': 'input', 'source-kind': 'test', 'as-of': '', 'retrieved-at': '',
        completeness: 'complete', freshness: 'fresh'
      } }
    }, ['test']);
    expect(reducer.rows()).toEqual(ordinary.test.rows);
  });

  it('honors cancellation, shared operations, group bounds, and distinct-state bounds', () => {
    const aggregate = { values: [{ field: 'value', as: 'value', reducer: /** @type {const} */ ('distinct-count') }] };
    expect(() => incrementalAggregate(aggregate, createDashboardQueryBudget({ signal: { aborted: true } }))
      .append([{ value: 1 }])).toThrow('cancelled');
    expect(() => incrementalAggregate(aggregate, createDashboardQueryBudget({ maxOperations: 1 }))
      .append([{ value: 1 }])).toThrow('max-operations');
    const distinct = incrementalAggregate(aggregate, createDashboardQueryBudget());
    expect(() => distinct.append(Array.from({ length: 200001 }, (_, value) => ({ value })))).toThrow('distinct-value budget');
    const grouped = incrementalAggregate({ ...aggregate, by: ['value'] }, createDashboardQueryBudget());
    expect(() => grouped.append(Array.from({ length: 200001 }, (_, value) => ({ value })))).toThrow('max-input-rows');
  });

  it('preserves valid multiple distinct reducers and groups before the final output limit', () => {
    const aggregate = {
      values: [
        { field: 'a', as: 'a', reducer: /** @type {const} */ ('distinct-count') },
        { field: 'b', as: 'b', reducer: /** @type {const} */ ('distinct-count') }
      ]
    };
    const rows = Array.from({ length: 200000 }, (_, value) => ({ a: value, b: value }));
    const reducer = incrementalAggregate(aggregate, createDashboardQueryBudget());
    reducer.append(rows);
    expect(reducer.rows()).toEqual([{ a: 200000, b: 200000 }]);

    const grouped = incrementalAggregate({
      by: ['a'],
      values: [{ field: 'a', as: 'count', reducer: 'count' }]
    }, createDashboardQueryBudget());
    grouped.append(rows.slice(0, 120000));
    const limited = executeDashboardQueries([{ name: 'limited', from: 'groups', limit: 10 }], {
      groups: { source: 'groups', rows: grouped.rows(), metadata: {
        'source-id': 'groups', 'source-kind': 'test', 'as-of': '', 'retrieved-at': '',
        completeness: 'complete', freshness: 'fresh'
      } }
    }, ['limited']);
    expect(limited.limited.rows).toHaveLength(10);
  });
});
