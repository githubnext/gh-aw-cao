import 'fake-indexeddb/auto';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  canonicalDatabaseName, CANONICAL_DATABASE_SCHEMA, DATABASE_VERSION
} from '../../src/data/storage/indexeddb.js';
import { queryIndexedDatabaseSources } from '../../src/data/queries/database.js';
import {
  createDashboardQueryBudget, DASHBOARD_QUERY_LIMITS, executeDashboardQueries, resolveDashboardQuerySources
} from '../../src/data/queries/declarative.js';
import { createStreamingAggregate } from '../../src/data/queries/streaming-aggregate.js';
import { compileDashboardViewPayloadQueries } from '../../src/data/queries/view-payload-compiler.js';
import { processDataRequest } from '../../src/data-worker.js';
import { authoritativeDashboard } from '../authoritative-dashboard.js';

const factory = new IDBFactory();
const count = DASHBOARD_QUERY_LIMITS['max-input-rows'] + 20221;
const metadata = /** @type {import('../../src/presenter.js').SourceMetadata} */ ({
  availability: 'available', completeness: 'complete', freshness: 'fresh',
  'source-id': 'domains', 'source-kind': 'canonical',
  'as-of': '2026-10-10T00:00:00Z', 'retrieved-at': '2026-10-10T00:00:00Z'
});
const logicalSources = { domains: { source: 'domains', rows: [], metadata } };
const queries = authoritativeDashboard.dashboard.queries;
const totals = queries.find((/** @type {{ name: string }} */ query) => query.name === 'firewall-domain-totals');

/** @param {number} index */
function record(index) {
  const allowed = index % 3 === 0;
  return {
    id: `domain:${String(index).padStart(6, '0')}`, runId: `run:${index % 4}`,
    source: index % 17 === 0 ? 'other' : 'firewall',
    type: allowed ? 'net_allowed' : 'net_blocked', decision: allowed ? 'allowed' : 'denied',
    domain: index % 5 < 3 ? 'api.example.com' : 'github.com',
    timestamp: index % 7 === 0 ? '2026-09-01T00:00:00Z' : '2026-10-09T00:00:00Z',
    ...(index % 11 === 0 ? {} : { requestCount: index % 13 + 1 })
  };
}

function expectedRows(scoped = false) {
  const groups = new Map();
  for (let index = 0; index < count; index += 1) {
    const row = record(index);
    if (row.source !== 'firewall' || (scoped && (index % 4 >= 2 || index % 7 === 0))) continue;
    const group = groups.get(row.domain) ?? { domain: row.domain, runs: new Set(), accepted: 0, blocked: 0 };
    group.runs.add(String(index % 4));
    group[row.decision === 'allowed' ? 'accepted' : 'blocked'] += row.requestCount ?? 1;
    groups.set(row.domain, group);
  }
  return [...groups.values()]
    .map(({ runs, ...row }) => ({ ...row, run: runs.size }))
    .sort((left, right) => right.blocked - left.blocked || right.accepted - left.accepted
      || left.domain.localeCompare(right.domain));
}

/**
 * @param {unknown} definitions
 * @param {string[]} requested
 * @param {Record<string, import('../../src/presenter.js').LogicalSourceInput>} [sources]
 * @param {{ signal?: { aborted?: boolean }, budget?: import('../../src/data/queries/declarative.js').QueryBudget }} [options]
 */
async function execute(definitions, requested, sources = logicalSources, options = {}) {
  const native = await queryIndexedDatabaseSources(
    factory, sources, definitions, resolveDashboardQuerySources(definitions, requested), options
  );
  return { ...native, ...executeDashboardQueries(
    definitions, native, requested.filter((name) => !Object.hasOwn(native, name))
  ) };
}

beforeAll(async () => {
  // The streaming path uses primary keys only. Omit secondary indexes to avoid
  // fake-indexeddb's quadratic insertion cost for repeated secondary keys.
  const database = await new Promise((resolve, reject) => {
    const request = factory.open(canonicalDatabaseName(), DATABASE_VERSION);
    request.onupgradeneeded = () => {
      for (const [name, schema] of Object.entries(CANONICAL_DATABASE_SCHEMA)) {
        request.result.createObjectStore(name, { keyPath: schema.keyPath });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const runTransaction = database.transaction('runs', 'readwrite');
    for (let index = 0; index < 4; index += 1) {
      runTransaction.objectStore('runs').put({
        id: `run:${index}`, owner: 'octo', repository: index < 2 ? 'selected' : 'other',
        workflowPath: '.github/workflows/test.md', githubRunId: String(index), attempt: 1
      });
    }
    await new Promise((resolve, reject) => {
      runTransaction.oncomplete = resolve;
      runTransaction.onerror = () => reject(runTransaction.error);
    });
    for (let offset = 0; offset < count; offset += 1000) {
      const transaction = database.transaction('domains', 'readwrite');
      for (let index = offset; index < Math.min(count, offset + 1000); index += 1) {
        transaction.objectStore('domains').put(record(index));
      }
      await new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
      });
    }
  } finally {
    database.close();
  }
}, 60000);

describe('bounded canonical streaming aggregates', () => {
  it('returns exact filtered sums and cross-batch distinct runs above 200000 domains', async () => {
    expect(count - Math.ceil(count / 17)).toBeGreaterThan(DASHBOARD_QUERY_LIMITS['max-input-rows']);
    const reads = vi.spyOn(IDBObjectStore.prototype, 'getAll');
    try {
      const result = await execute(queries, ['firewall-domain-totals', 'firewall-most-blocked-domains']);
      expect(result['firewall-domain-totals'].metadata.availability).toBe('available');
      expect(result['firewall-domain-totals'].metadata.completeness).toBe('complete');
      expect(result['firewall-domain-totals'].rows).toEqual(expectedRows());
      expect(result['firewall-most-blocked-domains'].rows).toEqual(expectedRows());
      const domainReads = reads.mock.calls.filter((_, index) => (
        /** @type {IDBObjectStore} */ (reads.mock.contexts[index]).name === 'domains'
      ));
      expect(domainReads.length).toBeGreaterThan(20);
      expect(domainReads.every(([, limit]) => limit === 10000)).toBe(true);
    } finally {
      reads.mockRestore();
    }
  }, 30000);

  it('executes compiled firewall view dependencies with repository and time predicates', async () => {
    const page = authoritativeDashboard.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'firewall');
    const queryContext = {
      filters: { repository: ['selected'] },
      timeWindow: { start: '2026-10-01T00:00:00Z', end: '2026-10-11T00:00:00Z' }
    };
    const payload = compileDashboardViewPayloadQueries(page, 'firewall', {
      viewId: 'security-firewall-domains', queries, queryContext
    });
    expect(payload.aliases).toHaveLength(1);
    vi.stubGlobal('indexedDB', factory);
    try {
      const result = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (
        await processDataRequest({
          operation: 'query-canonical-dashboard', sourceNames: ['firewall-domain-totals'],
          context: { ...authoritativeDashboard.dashboard, queries },
          pageId: 'firewall', viewId: 'security-firewall-domains', queryContext
        })
      );
      expect(result[payload.aliases[0]].metadata.availability).toBe('available');
      expect(result[payload.aliases[0]].rows).toEqual(expectedRows(true));
    } finally {
      vi.unstubAllGlobals();
    }
  }, 30000);

  it('does not turn an unavailable canonical input into a partial aggregate', async () => {
    for (const source of ['domains', 'runs']) {
      const result = await execute(queries, ['firewall-domain-totals'], {
        [source]: { source, rows: [], metadata: { ...metadata, availability: 'unavailable' } }
      });
      expect(result['firewall-domain-totals'].metadata.availability).toBe('unavailable');
      expect(result['firewall-domain-totals'].rows).toEqual([]);
    }
  });

  it('fails closed when retained groups exceed the existing input bound', async () => {
    const definition = {
      name: 'event-totals', from: 'domains',
      aggregate: { by: ['event'], values: [{ field: 'request-count', as: 'requests', reducer: 'sum' }] }
    };
    const result = await execute([definition], ['event-totals']);
    expect(result['event-totals'].metadata.availability).toBe('unavailable');
    expect(result['event-totals'].metadata['query-diagnostic']).toContain('max-input-rows groups');
    expect(result['event-totals'].rows).toEqual([]);
  }, 30000);

  it('preserves abort and operation-budget cancellation without publishing partial results', async () => {
    await expect(execute(queries, ['firewall-domain-totals'], logicalSources, {
      signal: { aborted: true }
    })).rejects.toMatchObject({ name: 'DashboardQueryCancelledError', kind: 'aborted' });
    const budget = createDashboardQueryBudget({ maxOperations: 250000 });
    await expect(execute(queries, ['firewall-domain-totals'], logicalSources, { budget }))
      .rejects.toMatchObject({ name: 'DashboardQueryCancelledError', kind: 'budget' });
    expect(budget.operations).toBeGreaterThan(250000);
  });

  it('observes a signal aborted between storage batches and aborts the snapshot scan', async () => {
    const controller = new AbortController();
    const original = IDBObjectStore.prototype.getAll;
    let domainReads = 0;
    const reads = vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(/** @this {IDBObjectStore} */ function (...args) {
      if (this.name === 'domains' && ++domainReads === 2) controller.abort();
      return original.apply(this, args);
    });
    try {
      await expect(execute(queries, ['firewall-domain-totals'], logicalSources, {
        signal: controller.signal
      })).rejects.toMatchObject({ name: 'DashboardQueryCancelledError', kind: 'aborted' });
      expect(domainReads).toBe(2);
    } finally {
      reads.mockRestore();
    }
  });

  it('bounds distinct values retained across batches', () => {
    const streamed = createStreamingAggregate({
      values: [{ field: 'run', as: 'runs', reducer: 'distinct-count' }]
    }, createDashboardQueryBudget());
    for (let offset = 0; offset < DASHBOARD_QUERY_LIMITS['max-input-rows']; offset += 10000) {
      streamed.append(Array.from({ length: 10000 }, (_, index) => ({ run: offset + index })));
    }
    expect(() => streamed.append([{ run: 'last-run' }])).toThrow('max-input-rows distinct values');
  });

  it('keeps reducer null, coercion, empty-group, and floating-point semantics', () => {
    const definition = {
      ...totals, name: 'reduced', from: 'input',
      aggregate: { values: [
        { field: 'value', as: 'sum', reducer: 'sum' },
        { field: 'value', as: 'count', reducer: 'count' },
        { field: 'value', as: 'distinct', reducer: 'distinct-count' }
      ] }
    };
    delete definition.filter;
    delete definition['order-by'];
    const rows = [1e16, 1, -1e16, 1, null, '', '2', 2, 'bad', false].map((value) => ({ value }));
    const streamed = createStreamingAggregate(definition.aggregate, createDashboardQueryBudget());
    streamed.append(rows.slice(0, 2));
    streamed.append(rows.slice(2));
    const canonical = executeDashboardQueries([definition], { input: { source: 'input', rows, metadata } });
    expect(streamed.rows()).toEqual(canonical.reduced.rows);
    const empty = createStreamingAggregate(definition.aggregate, createDashboardQueryBudget());
    expect(empty.rows()).toEqual([{ sum: 0, count: 0, distinct: 0 }]);
  });
});
