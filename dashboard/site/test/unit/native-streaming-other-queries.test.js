import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as storage from '../../src/data/storage/indexeddb.js';
import {
  loadDatabaseQuerySources, queryDatabaseSources, queryIndexedDatabaseSources
} from '../../src/data/queries/database.js';
import { executeDashboardQueries } from '../../src/data/queries/declarative.js';
import { authoritativeDashboard } from '../authoritative-dashboard.js';

const metadata = /** @type {import('../../src/presenter.js').SourceMetadata} */ ({
  'source-id': 'canonical-fixture', 'source-kind': 'artifact',
  'as-of': '2026-10-15T12:00:00Z', 'retrieved-at': '2026-10-15T12:00:00Z',
  availability: 'available', completeness: 'complete', freshness: 'fresh'
});
const sources = {
  tools: { rows: [], metadata },
  audits: { rows: [], metadata }
};
const mcpQueries = /** @type {import('../../src/data/queries/declarative.js').DashboardQuery[]} */ (
  authoritativeDashboard.dashboard.queries
).filter((query) => [
  'mcp-tool-workflow-totals', 'mcp-tool-totals', 'mcp-top-tools'
].includes(query.name));
const findingsQueries = /** @type {import('../../src/data/queries/declarative.js').DashboardQuery[]} */ ([
  {
    name: 'selected-findings', from: 'findings',
    filter: { predicates: [{ field: 'finding-status', equals: 'observed' }] },
    select: [
      { field: 'finding-severity', as: 'severity' },
      { field: 'run' }, { field: 'safe-output' }
    ]
  },
  {
    name: 'finding-totals', from: 'selected-findings',
    compute: [{ as: 'weight', function: 'literal', args: [{ value: 2 }] }],
    aggregate: {
      by: ['severity'],
      values: [
        { field: 'safe-output', as: 'findings', reducer: 'count' },
        { field: 'run', as: 'runs', reducer: 'distinct-count' },
        {
          field: 'weight', as: 'high-weight', reducer: 'sum',
          filter: { predicates: [{ field: 'severity', equals: 'high' }] }
        }
      ]
    },
    'order-by': [{ field: 'severity', direction: 'asc' }]
  }
]);
const mcpCount = /** @type {import('../../src/data/queries/declarative.js').DashboardQuery} */ ({
  name: 'mcp-count', from: 'mcp-calls',
  aggregate: {
    by: ['mcp-server'],
    values: [{ field: 'mcp-observation', as: 'calls', reducer: 'count' }]
  },
  'order-by': [{ field: 'mcp-server', direction: 'asc' }]
});

/** @param {Record<string, Record<string, unknown>[]>} records */
async function put(records) {
  const database = await storage.openCanonicalDatabase(indexedDB);
  try {
    for (const [storeName, rows] of Object.entries(records)) {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, 'readwrite');
        for (const row of rows) transaction.objectStore(storeName).put(row);
        transaction.oncomplete = () => resolve(undefined);
        transaction.onerror = () => reject(transaction.error);
      });
    }
  } finally {
    database.close();
  }
}

beforeEach(async () => {
  await put({
    runs: ['1', '2'].map((run) => ({
      id: `run:${run}`, githubRunId: run, owner: 'org', repository: 'repo',
      workflowPath: `workflow-${run}.md`
    })),
    tools: Array.from({ length: 2406 }, (_, index) => ({
      id: `tool:${String(index).padStart(5, '0')}`,
      runId: `run:${index % 6 === 2 ? '2' : '1'}`,
      source: index % 6 === 4 ? 'shell' : 'mcp',
      type: index % 6 === 5 ? 'audit.finding' : 'mcp.tool_call',
      mcpServer: index % 6 === 3 ? 'safe_outputs' : 'github',
      mcpTool: index % 6 === 3 ? 'create_issue' : 'list_issues',
      status: index % 6 === 1 ? 'failed' : 'completed',
      requestBytes: [2, null, 3, 11, 100, 100][index % 6],
      responseBytes: [5, null, 7, 13, 100, 100][index % 6],
      timestamp: metadata['as-of']
    })),
    audits: Array.from({ length: 2406 }, (_, index) => ({
      id: `audit:${String(index).padStart(5, '0')}`, runId: `run:${index % 2 + 1}`,
      source: 'audit', type: index % 3 === 2 ? 'mcp.tool_call' : 'audit.finding',
      status: index % 3 === 0 ? 'high' : 'low', summary: 'Retained finding',
      timestamp: metadata['as-of']
    }))
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(storage.DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
});

describe('native aggregate compatibility beyond firewall queries', () => {
  it('preserves the production MCP inventory, byte totals, workflow counts, and safe-output exclusion', async () => {
    const names = ['mcp-tool-workflow-totals', 'mcp-tool-totals', 'mcp-top-tools'];
    const canonical = await queryDatabaseSources(indexedDB, sources, ['mcp-calls']);
    const ordinary = executeDashboardQueries(mcpQueries, canonical, names);
    const native = await queryIndexedDatabaseSources(indexedDB, sources, mcpQueries, names);
    expect(Object.keys(native)).toEqual(['mcp-tool-workflow-totals']);
    const actual = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (
      await loadDatabaseQuerySources(indexedDB, sources, { queries: mcpQueries, sourceNames: names })
    );
    for (const name of names) {
      expect(actual[name].rows).toEqual(ordinary[name].rows);
      expect(actual[name].metadata).toMatchObject({
        availability: 'available', 'source-kind': 'derived', 'query-name': name
      });
    }
    expect(actual['mcp-tool-workflow-totals'].rows).toHaveLength(3);
    expect(actual['mcp-top-tools'].rows).toEqual([{
      'mcp-tool-label': 'github/list_issues', 'mcp-tool': 'list_issues', 'mcp-server': 'github',
      calls: 1203, workflows: 2, 'request-bytes': 2005, 'response-bytes': 4812
    }]);
  });

  it('preserves production tool entity insights through their computed-label ancestor', async () => {
    const definitions = /** @type {import('../../src/data/queries/declarative.js').DashboardQuery[]} */ (
      authoritativeDashboard.dashboard.queries
    ).filter((query) => ['mcp-tool-calls', 'tool-entity-insights'].includes(query.name));
    const canonical = await queryDatabaseSources(indexedDB, sources, ['mcp-calls']);
    const ordinary = executeDashboardQueries(definitions, canonical, ['tool-entity-insights']);
    const native = await queryIndexedDatabaseSources(indexedDB, sources, definitions, ['tool-entity-insights']);
    expect(native['tool-entity-insights'].rows).toEqual(ordinary['tool-entity-insights'].rows);
    expect(native['tool-entity-insights'].metadata.availability).toBe('available');
    expect(native['tool-entity-insights'].rows).toEqual(expect.arrayContaining([
      {
        'mcp-tool-label': 'github/list_issues', 'mcp-server': 'github',
        'mcp-tool': 'list_issues', 'mcp-status': 'completed', observations: 802
      },
      {
        'mcp-tool-label': 'github/list_issues', 'mcp-server': 'github',
        'mcp-tool': 'list_issues', 'mcp-status': 'failed', observations: 401
      }
    ]));
    expect(native['tool-entity-insights'].rows).toHaveLength(3);
  });

  it('preserves findings projection aliases, row-local ancestors, and conditional totals across batches', async () => {
    const canonical = await queryDatabaseSources(indexedDB, sources, ['findings']);
    const ordinary = executeDashboardQueries(findingsQueries, canonical, ['finding-totals']);
    const native = await queryIndexedDatabaseSources(indexedDB, sources, findingsQueries, ['finding-totals']);
    expect(native['finding-totals'].rows).toEqual(ordinary['finding-totals'].rows);
    expect(native['finding-totals'].metadata.availability).toBe('available');
    expect(native['finding-totals'].rows).toEqual([
      { severity: 'high', findings: 802, runs: 2, 'high-weight': 1604 },
      { severity: 'low', findings: 802, runs: 2, 'high-weight': 0 }
    ]);
  });

  it('reuses equivalent aliases only within a request and isolates different predicates', async () => {
    const scan = vi.spyOn(storage, 'scanCanonicalCollection');
    const definitions = [
      mcpCount,
      { ...mcpCount, name: 'equivalent' },
      { ...mcpCount, name: 'github-only', filter: { predicates: [{ field: 'mcp-server', equals: 'github' }] } }
    ];
    const actual = await queryIndexedDatabaseSources(indexedDB, sources, definitions, definitions.map((query) => query.name));
    expect(scan).toHaveBeenCalledTimes(2);
    expect(actual.equivalent.rows).toEqual(actual['mcp-count'].rows);
    expect(actual.equivalent.source).toBe('equivalent');
    expect(actual.equivalent.metadata['query-name']).toBe('equivalent');
    expect(actual['github-only'].rows).toEqual([{ 'mcp-server': 'github', calls: 1203 }]);
    await put({ tools: [{
      id: 'tool:new', runId: 'run:1', source: 'mcp', type: 'mcp.tool_call',
      mcpServer: 'github', mcpTool: 'list_issues', timestamp: metadata['as-of']
    }] });
    const fresh = await queryIndexedDatabaseSources(indexedDB, sources, definitions, ['github-only']);
    expect(scan).toHaveBeenCalledTimes(3);
    expect(fresh['github-only'].rows).toEqual([{ 'mcp-server': 'github', calls: 1204 }]);
  });

  it.each([
    ['mcp-calls', 'tools', mcpCount],
    ['findings', 'audits', findingsQueries[1]]
  ])('preserves empty and unavailable canonical stores for %s', async (source, store, query) => {
    const definition = /** @type {import('../../src/data/queries/declarative.js').DashboardQuery} */ ({
      ...query, from: source, compute: undefined,
      aggregate: { by: ['run'], values: [{ field: 'run', as: 'calls', reducer: 'count' }] }
    });
    const database = await storage.openCanonicalDatabase(indexedDB);
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(store, 'readwrite');
      transaction.objectStore(store).clear();
      transaction.oncomplete = () => resolve(undefined);
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
    const empty = await queryIndexedDatabaseSources(indexedDB, sources, [definition], [definition.name]);
    expect(empty[definition.name].rows).toEqual([]);
    expect(empty[definition.name].metadata.availability).toBe('empty');
    const unavailable = await queryIndexedDatabaseSources(indexedDB, {
      [store]: { rows: [], metadata: { ...metadata, availability: 'unavailable' } }
    }, [definition], [definition.name]);
    expect(unavailable[definition.name].rows).toEqual([]);
    expect(unavailable[definition.name].metadata.availability).toBe('unavailable');
  });

  it.each(['mean', 'ordered ancestor', 'limited ancestor', 'aggregate ancestor', 'union', 'join'])(
    'keeps %s on the ordinary query path',
    async (shape) => {
      const ancestor = { name: 'ancestor', from: 'mcp-calls' };
      const definitions = /** @type {import('../../src/data/queries/declarative.js').DashboardQuery[]} */ ([
        ...(shape === 'join' ? [{ ...mcpCount, name: 'servers' }] : []),
        {
          ...ancestor,
          ...(shape === 'ordered ancestor' ? { 'order-by': [{ field: 'mcp-server', direction: 'asc' }] } : {}),
          ...(shape === 'limited ancestor' ? { limit: 5 } : {}),
          ...(shape === 'aggregate ancestor' ? { aggregate: mcpCount.aggregate } : {}),
          ...(shape === 'join' ? { joins: [{
            source: 'servers', type: 'left', on: [{ left: 'mcp-server', right: 'mcp-server' }],
            fields: [{ field: 'calls', as: 'server-calls' }]
          }] } : {})
        },
        {
          name: 'result', from: 'ancestor',
          ...(shape === 'union' ? { union: ['mcp-calls'] } : {}),
          aggregate: {
            values: [{
              field: shape === 'aggregate ancestor' ? 'calls' : 'request-bytes',
              as: 'total', reducer: shape === 'mean' ? 'mean' : 'sum'
            }]
          }
        }
      ]);
      expect(await queryIndexedDatabaseSources(indexedDB, sources, definitions, ['result'])).toEqual({});
      const canonical = await queryDatabaseSources(indexedDB, sources, ['mcp-calls']);
      const ordinary = executeDashboardQueries(definitions, canonical, ['result']);
      const actual = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (
        await loadDatabaseQuerySources(indexedDB, sources, { queries: definitions, sourceNames: ['result'] })
      );
      expect(actual.result.metadata.availability).toBe('available');
      expect(actual.result.rows).toEqual(ordinary.result.rows);
    }
  );

  it('preserves existing direct-store execution for production skill queries', async () => {
    await put({ skills: [
      { id: 'skill:1', runId: 'run:1', name: 'reactive-ui', invocationCount: 2 },
      { id: 'skill:2', runId: 'run:2', name: 'reactive-ui', invocationCount: 3 },
      { id: 'skill:3', runId: 'run:1', name: 'npm', invocationCount: 1 }
    ] });
    const names = ['skill-invocations-by-skill', 'skill-invocations-by-workflow-totals', 'skill-workflow-totals'];
    const definitions = /** @type {import('../../src/data/queries/declarative.js').DashboardQuery[]} */ (
      authoritativeDashboard.dashboard.queries
    ).filter((query) => [...names, 'skill-invocations'].includes(query.name));
    expect(await queryIndexedDatabaseSources(indexedDB, {}, definitions, names)).toEqual({});
    const canonical = await queryDatabaseSources(indexedDB, {}, ['skills']);
    const ordinary = executeDashboardQueries(definitions, canonical, names);
    const actual = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (
      await loadDatabaseQuerySources(indexedDB, {}, { queries: definitions, sourceNames: names })
    );
    for (const name of names) {
      expect(actual[name].metadata.availability).toBe('available');
      expect(actual[name].rows).toEqual(ordinary[name].rows);
    }
    expect(actual['skill-invocations-by-skill'].rows).toEqual([
      { skill: 'reactive-ui', invocations: 5 }, { skill: 'npm', invocations: 1 }
    ]);
  });

  it('does not replace usable supplied logical observations with canonical-store data', async () => {
    const logical = { 'mcp-calls': {
      source: 'mcp-calls', rows: [{ 'mcp-observation': 'supplied', 'mcp-server': 'external' }], metadata
    } };
    expect(await queryIndexedDatabaseSources(indexedDB, logical, [mcpCount], [mcpCount.name])).toEqual({});
    const actual = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (
      await loadDatabaseQuerySources(indexedDB, logical, { queries: [mcpCount], sourceNames: [mcpCount.name] })
    );
    expect(actual[mcpCount.name].rows).toEqual([{ 'mcp-server': 'external', calls: 1 }]);
  });
});
