// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processDataRequest } from '../../src/data-worker.js';
import {
  DATABASE_NAME, openCanonicalDatabase, prepareCanonicalRecord, readCollections
} from '../../src/data/storage/indexeddb.js';
import { queryDatabaseSources, queryIndexedDatabaseSources } from '../../src/data/queries/database.js';
import { DASHBOARD_QUERY_LIMITS, executeDashboardQueries } from '../../src/data/queries/declarative.js';

const metadata = { 'as-of': '2026-10-02T20:00:00Z', 'artifact-generation': 'record-selection' };
const identity = { organization: 'githubnext', repository: 'gh-aw-cao', workflow: 'activity.md', run: '42' };
const sources = {
  repositories: { rows: [identity], metadata },
  workflows: { rows: [identity], metadata },
  runs: { rows: [{ ...identity, 'run-attempt': 1, 'started-at': metadata['as-of'] }], metadata },
  tools: { rows: [], metadata }, audits: { rows: [], metadata },
  domains: { rows: [], metadata }, issues: { rows: [], metadata }
};
const labels = {
  name: 'labels', from: 'mcp-calls', compute: [{
    as: 'opaque-label', function: 'concat',
    args: [{ field: 'mcp-server' }, { value: '/' }, { field: 'mcp-tool' }]
  }]
};
/** @param {string} label */
function selection(label) {
  return {
    name: 'selected-label', from: 'labels',
    filter: { predicates: [{ field: 'opaque-label', equals: label }] },
    select: [{ field: 'mcp-observation' }, { field: 'opaque-label' }],
    'order-by': [{ field: 'mcp-observation', direction: 'asc' }]
  };
}

/** @param {string} storeName @param {Record<string, unknown>[]} records */
async function put(storeName, records) {
  const [run] = (await readCollections(indexedDB, ['runs'])).runs;
  const database = await openCanonicalDatabase(indexedDB);
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    for (const record of records) store.put(prepareCanonicalRecord(storeName, { ...record, runId: run.id }));
    transaction.oncomplete = () => resolve(undefined);
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
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
    sourceNames: [], context: { pages: [], queries: [] }
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('indexed nullable record selection with declarative graph fusion', () => {
  it('matches opaque concat labels without splitting delimiters or losing missing/null components', async () => {
    await put('tools', [
      { id: 'a', mcpServer: 'server/with', mcpTool: 'slash/tool' },
      { id: 'b', mcpServer: 'server', mcpTool: 'with/slash/tool' },
      { id: 'c', mcpTool: 'missing-server' },
      { id: 'd', mcpServer: 'missing-tool' },
      { id: 'e', mcpServer: null, mcpTool: 'missing-server' },
      { id: 'f', mcpServer: { untrusted: true }, mcpTool: 'missing-server' }
    ].map((row) => ({ ...row, source: 'mcp', type: 'tool.call' })));
    const canonical = await queryDatabaseSources(indexedDB, sources, ['mcp-calls']);
    for (const [label, ids] of [
      ['server/with/slash/tool', ['a', 'b']],
      ['/missing-server', ['c', 'e', 'f']],
      ['missing-tool/', ['d']]
    ]) {
      const queries = [labels, selection(String(label))];
      const expected = executeDashboardQueries(queries, canonical, ['selected-label'])['selected-label'];
      const native = await queryIndexedDatabaseSources(indexedDB, sources, queries, ['selected-label']);
      expect(native['selected-label'].rows).toEqual(expected.rows);
      expect(native['selected-label'].metadata).toEqual(expected.metadata);
      expect(native['selected-label'].rows.map((row) => row['mcp-observation'])).toEqual(ids);
    }
    expect((await readCollections(indexedDB, ['tools'])).tools.every((row) => !('_queryKeys' in row))).toBe(true);
  });

  it('selects before an unbounded computed ancestor can hit its output cap', async () => {
    await put('tools', Array.from({ length: 19 }, (_, position) => ({
      id: `event-${position}`, source: 'mcp', type: 'tool.call',
      mcpServer: position < 2 ? 'selected' : 'other', mcpTool: `tool-${position < 2 ? 0 : position}`
    })));
    const canonical = await queryDatabaseSources(indexedDB, sources, ['mcp-calls']);
    const queries = [labels, selection('selected/tool-0')];
    const previous = DASHBOARD_QUERY_LIMITS['max-output-rows'];
    DASHBOARD_QUERY_LIMITS['max-output-rows'] = 5;
    try {
      expect(executeDashboardQueries(queries, canonical, ['selected-label'])['selected-label'].metadata.availability)
        .toBe('unavailable');
      const result = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (await processDataRequest({
        operation: 'query-canonical-dashboard', sourceNames: ['selected-label'],
        context: { pages: [], queries }
      }));
      expect(result['selected-label'].metadata.availability).toBe('available');
      expect(result['selected-label'].rows).toHaveLength(2);
    } finally {
      DASHBOARD_QUERY_LIMITS['max-output-rows'] = previous;
    }
  });

  it('uses the same worker boundary for direct record-source summary and domain selections', async () => {
    for (const source of ['audits', 'domains', 'tools', 'issues']) {
      await put(source, [
        { id: `${source}-selected`, source: 'audit', type: 'audit.finding', summary: 'selected', domain: 'selected.example' },
        { id: `${source}-other`, source: 'audit', type: 'audit.finding', summary: 'other', domain: 'other.example' }
      ]);
      const field = source === 'domains' ? 'domain' : 'event-summary';
      const query = {
        name: `${source}-selection`, from: source,
        filter: { predicates: [{ field, equals: source === 'domains' ? 'selected.example' : 'selected' }] },
        select: [{ field: 'event' }]
      };
      const result = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (await processDataRequest({
        operation: 'query-canonical-dashboard', sourceNames: [query.name], context: { pages: [], queries: [query] }
      }));
      expect(result[query.name].rows).toEqual([{ event: `${source}-selected` }]);
    }
  });

  it('shares tuple dictionaries and run reads only within one request', async () => {
    await put('tools', [
      { id: 'a', source: 'mcp', type: 'tool.call', mcpServer: 'server', mcpTool: 'a' },
      { id: 'b', source: 'mcp', type: 'tool.call', mcpServer: 'server', mcpTool: 'b' }
    ]);
    const keyReads = vi.spyOn(IDBIndex.prototype, 'openKeyCursor');
    const runReads = vi.spyOn(IDBObjectStore.prototype, 'getAll');
    const queries = [
      labels,
      { ...selection('server/a'), name: 'selected-a' },
      { ...selection('server/b'), name: 'selected-b' }
    ];
    const result = await queryIndexedDatabaseSources(indexedDB, sources, queries, ['selected-a', 'selected-b']);
    expect(result['selected-a'].rows.map((row) => row['mcp-observation'])).toEqual(['a']);
    expect(result['selected-b'].rows.map((row) => row['mcp-observation'])).toEqual(['b']);
    expect(keyReads).toHaveBeenCalledTimes(1);
    expect(runReads.mock.contexts.filter((store) => store instanceof IDBObjectStore && store.name === 'runs')).toHaveLength(1);

    await put('tools', [{ id: 'c', source: 'mcp', type: 'tool.call', mcpServer: 'server', mcpTool: 'a' }]);
    keyReads.mockClear();
    runReads.mockClear();
    const updated = await queryIndexedDatabaseSources(indexedDB, sources, queries, ['selected-a', 'selected-b']);
    expect(updated['selected-a'].rows.map((row) => row['mcp-observation'])).toEqual(['a', 'c']);
    expect(keyReads).toHaveBeenCalledTimes(1);
    expect(runReads.mock.contexts.filter((store) => store instanceof IDBObjectStore && store.name === 'runs')).toHaveLength(1);
  });

  it('does not trust incomplete tuple indexes or fabricate available data from an unavailable source', async () => {
    await put('tools', [{ id: 'a', source: 'mcp', type: 'tool.call', mcpServer: 'server', mcpTool: 'tool' }]);
    const queries = [labels, selection('server/tool')];
    const unavailable = { ...sources, 'mcp-calls': { rows: [], metadata: { ...metadata, availability: 'unavailable' } } };
    const result = await queryIndexedDatabaseSources(indexedDB, unavailable, queries, ['selected-label']);
    expect(result['selected-label'].metadata.availability).toBe('unavailable');
    expect(result['selected-label'].rows).toEqual([]);
    const unavailableStore = { ...sources, tools: { rows: [], metadata: { ...metadata, availability: 'unavailable' } } };
    const projected = await queryIndexedDatabaseSources(indexedDB, unavailableStore, queries, ['selected-label']);
    expect(projected['selected-label'].metadata.availability).toBe('unavailable');
    expect(projected['selected-label'].rows).toEqual([]);
    const [run] = (await readCollections(indexedDB, ['runs'])).runs;
    const database = await openCanonicalDatabase(indexedDB);
    await new Promise((resolve) => {
      const transaction = database.transaction('tools', 'readwrite');
      transaction.objectStore('tools').put({ id: 'incomplete', runId: run.id });
      transaction.oncomplete = () => resolve(undefined);
    });
    database.close();
    expect(await queryIndexedDatabaseSources(indexedDB, sources, queries, ['selected-label'])).toEqual({});
  });
});
