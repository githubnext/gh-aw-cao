// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { IDBFactory, IDBKeyRange as NativeKeyRange } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalize } from '../../src/data/normalize/index.js';
import {
  openCanonicalDatabase, readCollection, readIndex, upsertCanonicalBatch
} from '../../src/data/storage/indexeddb.js';
import {
  createSqliteIndexedDB, SqliteIDBKeyRange
} from '../../src/data/storage/sqlite-indexeddb.js';
import {
  loadDatabaseQuerySources, queryDatabaseSources, queryIndexedDatabaseSources
} from '../../src/data/queries/database.js';
import {
  DASHBOARD_QUERY_LIMITS, executeDashboardQueries
} from '../../src/data/queries/declarative.js';

const directories = /** @type {string[]} */ ([]);
const metadata = { 'as-of': '2026-10-02T20:00:00Z', availability: 'available' };
const sources = Object.fromEntries(['runs', 'tools', 'audits'].map((source) => [
  source, { rows: [], metadata }
]));

function sqliteFactory() {
  const directory = `.sqlite-native-selection-test-${randomUUID()}`;
  mkdirSync(directory, { recursive: true });
  directories.push(directory);
  return createSqliteIndexedDB(join(directory, 'dashboard.sqlite'));
}

/** @template T @param {IDBRequest<T>} request @returns {Promise<T>} */
function result(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** @param {IDBTransaction} transaction */
function completed(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve(undefined);
    transaction.onerror = () => reject(transaction.error);
  });
}

/** @param {IDBFactory} factory @param {Record<string, unknown>[]} records */
async function indexedRecords(factory, records) {
  const request = factory.open('index-parity');
  request.onupgradeneeded = () => {
    const store = request.result.createObjectStore('records', { keyPath: 'id' });
    store.createIndex('byKey', 'key');
    store.createIndex('byCompound', ['prefix', 'key']);
  };
  const database = await result(request);
  const transaction = database.transaction('records', 'readwrite');
  const done = completed(transaction);
  for (const record of records) transaction.objectStore('records').put(record);
  await done;
  return database;
}

function evidence() {
  const canonical = normalize([]);
  canonical.repositories.push({ id: 'repository:1' });
  canonical.workflows.push({ id: 'workflow:1', repositoryId: 'repository:1' });
  canonical.runs.push(...['42', '99'].map((githubRunId) => ({
    id: `run:${githubRunId}`, githubRunId, owner: 'githubnext',
    repository: 'gh-aw-cao', workflowPath: 'activity.md', attempt: 1,
    repositoryId: 'repository:1', workflowId: 'workflow:1'
  })));
  for (const store of /** @type {const} */ (['tools', 'audits'])) {
    canonical[store].push(
      { id: `${store}:a`, runId: 'run:42', summary: 'selected', status: 'success' },
      { id: `${store}:b`, runId: 'run:42', summary: null },
      ...Array.from({ length: 12 }, (_, position) => ({
        id: `${store}:unrelated:${position}`, runId: 'run:99', summary: 'unrelated'
      }))
    );
  }
  return canonical;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('real SQLite native record selection', () => {
  it.each(['tools', 'audits'])('scopes %s to run 42 before applying the input-row budget', async (source) => {
    const factory = sqliteFactory();
    await upsertCanonicalBatch(factory, evidence());
    const query = {
      name: 'selected', from: source,
      filter: { predicates: [{ field: 'run', equals: '42' }] },
      select: [{ field: 'event' }, { field: 'event-summary' }, { field: 'run' }],
      'order-by': [{ field: 'event', direction: 'asc' }]
    };
    const canonical = await queryDatabaseSources(factory, sources, [source]);
    const expected = structuredClone(executeDashboardQueries([query], canonical, ['selected']).selected);
    const database = await openCanonicalDatabase(factory);
    const prototype = Object.getPrototypeOf(database);
    const records = prototype.records;
    vi.spyOn(prototype, 'records').mockImplementation(/** @this {object} */ function (/** @type {unknown} */ store) {
      if (store === 'tools' || store === 'audits') throw new Error('whole-event materialization');
      return records.call(this, store);
    });
    database.close();
    const previous = DASHBOARD_QUERY_LIMITS['max-input-rows'];
    DASHBOARD_QUERY_LIMITS['max-input-rows'] = 3;
    try {
      const loaded = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (await loadDatabaseQuerySources(factory, sources, {
        queries: [query], sourceNames: ['selected']
      }));
      expect(loaded.selected).toEqual(expected);
      expect(loaded.selected.rows).toEqual([
        { event: `${source}:a`, 'event-summary': 'selected', run: '42' },
        { event: `${source}:b`, 'event-summary': null, run: '42' }
      ]);
      expect(loaded.selected.metadata.availability).toBe('available');
    } finally {
      DASHBOARD_QUERY_LIMITS['max-input-rows'] = previous;
    }
  });

  it.each(['tools', 'audits'])('rejects over-budget %s selections without reading event rows', async (source) => {
    const factory = sqliteFactory();
    const canonical = evidence();
    canonical[/** @type {'tools' | 'audits'} */ (source)].push(
      { id: `${source}:c`, runId: 'run:42' }, { id: `${source}:d`, runId: 'run:42' }
    );
    await upsertCanonicalBatch(factory, canonical);
    const query = {
      name: 'selected', from: source,
      filter: { predicates: [{ field: 'run', equals: '42' }] },
      select: [{ field: 'event' }]
    };
    const database = await openCanonicalDatabase(factory);
    const prototype = Object.getPrototypeOf(database);
    const records = prototype.records;
    vi.spyOn(prototype, 'records').mockImplementation(/** @this {object} */ function (/** @type {unknown} */ store) {
      if (store === 'tools' || store === 'audits') throw new Error('whole-event materialization');
      return records.call(this, store);
    });
    const indexPrototype = Object.getPrototypeOf(database.transaction(source).objectStore(source).index('byRun'));
    const getAll = vi.spyOn(indexPrototype, 'getAll');
    database.close();
    const previous = DASHBOARD_QUERY_LIMITS['max-input-rows'];
    DASHBOARD_QUERY_LIMITS['max-input-rows'] = 3;
    try {
      await expect(loadDatabaseQuerySources(factory, sources, {
        queries: [query], sourceNames: ['selected']
      })).rejects.toThrow('IndexedDB selection exceeded max-input-rows of 3');
      expect(getAll).not.toHaveBeenCalled();
    } finally {
      DASHBOARD_QUERY_LIMITS['max-input-rows'] = previous;
    }
  });

  it('keeps nullable private query keys indexed without exposing them through canonical reads', async () => {
    const factory = sqliteFactory();
    vi.stubGlobal('IDBKeyRange', SqliteIDBKeyRange);
    const canonical = evidence();
    canonical.tools = [
      { id: 'a', runId: 'run:42', summary: null, source: 'mcp', type: 'tool.call', mcpTool: 'missing-server' },
      { id: 'b', runId: 'run:42', source: 'mcp', type: 'tool.call', mcpServer: null, mcpTool: 'missing-server' },
      { id: 'c', runId: 'run:42', summary: '', source: 'mcp', type: 'tool.call', mcpServer: 'server', mcpTool: 'tool' }
    ];
    await upsertCanonicalBatch(factory, canonical);
    const database = await openCanonicalDatabase(factory);
    try {
      const transaction = database.transaction('tools');
      const done = completed(transaction);
      const store = transaction.objectStore('tools');
      const counts = await Promise.all([
        result(store.index('byQuerySummary').count()),
        result(store.index('byQuerySummary').count('[null]')),
        result(store.index('byQueryMcpIdentity').count('["mcp","tool.call",null,"missing-server"]'))
      ]);
      expect(counts).toEqual([3, 2, 2]);
      await done;
    } finally {
      database.close();
    }
    const nullable = await readIndex(factory, 'tools', 'byQuerySummary', ['[null]']);
    expect(nullable).toEqual(canonical.tools.slice(0, 2));
    expect((await readCollection(factory, 'tools')).every((row) => !('_queryKeys' in row))).toBe(true);
    const query = {
      name: 'nullable', from: 'tools',
      filter: { predicates: [{ field: 'event-summary', equals: null }] },
      select: [{ field: 'event' }]
    };
    const native = await queryIndexedDatabaseSources(factory, sources, [query], ['nullable']);
    // The SQLite facade has no key cursor; production must evaluate, not fake success.
    expect(native).toEqual({});
    const loaded = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (await loadDatabaseQuerySources(factory, sources, {
      queries: [query], sourceNames: ['nullable']
    }));
    expect(loaded.nullable.rows).toEqual([{ event: 'a' }, { event: 'b' }]);
    expect(loaded.nullable.metadata.availability).toBe('available');
    const previous = DASHBOARD_QUERY_LIMITS['max-input-rows'];
    DASHBOARD_QUERY_LIMITS['max-input-rows'] = 2;
    try {
      const bounded = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (await loadDatabaseQuerySources(factory, sources, {
        queries: [query], sourceNames: ['nullable']
      }));
      expect(bounded.nullable.metadata.availability).toBe('unavailable');
    } finally {
      DASHBOARD_QUERY_LIMITS['max-input-rows'] = previous;
    }
  });
});

describe('SQLite index count and getAll key parity', () => {
  it('matches IndexedDB typed exact/range keys and excludes invalid optional fields', async () => {
    const records = [
      { id: 'missing', prefix: 'p' }, { id: 'null', prefix: 'p', key: null },
      { id: 'boolean', prefix: 'p', key: true }, { id: 'object', prefix: 'p', key: {} },
      { id: 'invalid-array', prefix: 'p', key: [null] },
      { id: 'number', prefix: 'p', key: 42 }, { id: 'number-other', prefix: 'p', key: 7 },
      { id: 'string', prefix: 'p', key: '42' }, { id: 'string-duplicate', prefix: 'p', key: '42' },
      { id: 'empty-string', prefix: 'p', key: '' }, { id: 'empty-array', prefix: 'p', key: [] },
      { id: 'array-number', prefix: 'p', key: [42] }, { id: 'array-string', prefix: 'p', key: ['42'] },
      { id: 'nested-array', prefix: 'p', key: [[42], '42'] },
      { id: 'missing-prefix', key: '42' }, { id: 'null-prefix', prefix: null, key: '42' }
    ];
    const sqlite = await indexedRecords(sqliteFactory(), records);
    const native = await indexedRecords(new IDBFactory(), records);
    try {
      for (const [name, cases] of /** @type {Array<[string, Array<[unknown, unknown]>]>} */ ([
        ['byKey', [
          [undefined, undefined], [null, null], [42, 42], ['42', '42'],
          [SqliteIDBKeyRange.only('42'), NativeKeyRange.only('42')],
          [SqliteIDBKeyRange.bound(7, '42', true, true), NativeKeyRange.bound(7, '42', true, true)],
          [SqliteIDBKeyRange.lowerBound('42', true), NativeKeyRange.lowerBound('42', true)],
          [SqliteIDBKeyRange.upperBound([42]), NativeKeyRange.upperBound([42])],
          [SqliteIDBKeyRange.bound([], [[42], '42']), NativeKeyRange.bound([], [[42], '42'])]
        ]],
        ['byCompound', [
          [undefined, undefined], [['p', 42], ['p', 42]], [['p', '42'], ['p', '42']],
          [SqliteIDBKeyRange.bound(['p', 7], ['p', '42']), NativeKeyRange.bound(['p', 7], ['p', '42'])]
        ]]
      ])) {
        for (const [sqliteQuery, nativeQuery] of cases) {
          const sqliteTransaction = sqlite.transaction('records');
          const nativeTransaction = native.transaction('records');
          const done = Promise.all([completed(sqliteTransaction), completed(nativeTransaction)]);
          const sqliteIndex = sqliteTransaction.objectStore('records').index(String(name));
          const nativeIndex = nativeTransaction.objectStore('records').index(String(name));
          const [sqliteCount, nativeCount, sqliteRows, nativeRows] = await Promise.all([
            result(sqliteIndex.count(/** @type {IDBValidKey | IDBKeyRange} */ (sqliteQuery))),
            result(nativeIndex.count(/** @type {IDBValidKey | IDBKeyRange} */ (nativeQuery))),
            result(sqliteIndex.getAll(/** @type {IDBValidKey | IDBKeyRange} */ (sqliteQuery))),
            result(nativeIndex.getAll(/** @type {IDBValidKey | IDBKeyRange} */ (nativeQuery)))
          ]);
          expect(sqliteCount).toBe(nativeCount);
          expect(sqliteRows).toEqual(nativeRows);
          expect(sqliteCount).toBe(sqliteRows.length);
          await done;
        }
      }
    } finally {
      sqlite.close();
      native.close();
    }
  });
});
