import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  dailyWorkflowCutoff, DAILY_WORKFLOW_AGGREGATES, DAILY_WORKFLOW_CONTRIBUTIONS
} from '../../src/data/model/daily-workflow-aggregates.js';
import {
  DATABASE_NAME, maintainCanonicalDatabase, openCanonicalDatabase, readCollection,
  prepareCanonicalRecord, upsertCanonicalBatch
} from '../../src/data/storage/indexeddb.js';
import { writeAccountedRecords } from '../../src/data/storage/shards.js';
import { normalize } from '../../src/data/normalize/index.js';
import { createSqliteIndexedDB, installSqliteIndexedDB } from '../../src/data/storage/sqlite-indexeddb.js';
import { doctorSqliteDatabase } from '../../src/data/storage/sqlite-doctor.js';
import { sqliteRetention } from '../../../../activity/sqlite-retention.mjs';
import { ingestNormalizedJsonl } from '../../src/data/ingest/coordinator.js';
import { CANONICAL_SCHEMA_VERSION } from '../../src/data/model/schema.js';

const now = Date.parse('2026-10-23T12:00:00Z');
const filenames = /** @type {string[]} */ ([]);
const originalKeyRange = globalThis.IDBKeyRange;
const originalIndexedDB = globalThis.indexedDB;
afterEach(() => {
  vi.restoreAllMocks();
  globalThis.IDBKeyRange = originalKeyRange;
  globalThis.indexedDB = originalIndexedDB;
  for (const filename of filenames.splice(0)) rmSync(filename, { force: true });
});

/** @param {Record<string, unknown>[]} runs */
function batch(runs) {
  return {
    ...normalize([]),
    repositories: [{ id: 'repo' }],
    workflows: [{ id: 'workflow', repositoryId: 'repo' }],
    runs
  };
}

/** @param {Record<string, unknown>} [fields] */
function run(fields = {}) {
  return {
    id: 'run', repositoryId: 'repo', workflowId: 'workflow', attempt: 1,
    startedAt: '2026-10-22T01:00:00Z', ...fields
  };
}

describe.each(['browser', 'sqlite'])('daily workflow aggregates (%s)', (backend) => {
  function factory() {
    if (backend === 'browser') return new IDBFactory();
    const filename = resolve(`.daily-workflow-${process.pid}-${filenames.length}.sqlite`);
    filenames.push(filename);
    return installSqliteIndexedDB(filename);
  }

  it('delta-updates replay, partial enrichment, corrections, attempt changes, and group moves', async () => {
    const db = factory();
    const write = (/** @type {Record<string, unknown>[]} */ runs) =>
      upsertCanonicalBatch(db, batch(runs), { now, validateRelationships: false });
    await write([run({ aicTotal: 2, inputTokens: 0 }), run({ aicTotal: 2, inputTokens: 0 })]);
    await write([run({ aicTotal: 2, inputTokens: 0 })]);
    expect(await readCollection(db, DAILY_WORKFLOW_AGGREGATES)).toMatchObject([{
      runCount: 1, aicTotalSum: 2, aicTotalObservedCount: 1,
      inputTokensSum: 0, inputTokensObservedCount: 1,
      outputTokensSum: null, outputTokensObservedCount: 0
    }]);
    await write([{ id: 'run', outputTokens: 4 }]);
    await write([run({ aicTotal: 7, githubApiCalls: 0 })]);
    expect(await readCollection(db, DAILY_WORKFLOW_AGGREGATES)).toMatchObject([{
      runCount: 1, aicTotalSum: 7, outputTokensSum: 4, githubApiCallsSum: 0
    }]);
    await write([run({ startedAt: '2026-10-21T23:30:00-02:00' })]);
    expect(await readCollection(db, DAILY_WORKFLOW_AGGREGATES)).toMatchObject([{ day: '2026-10-22', runCount: 1 }]);
    await write([run({ startedAt: '2026-10-20T01:00:00Z' })]);
    expect(await readCollection(db, DAILY_WORKFLOW_AGGREGATES)).toMatchObject([{
      day: '2026-10-20', runCount: 1, aicTotalSum: 7
    }]);
    await write([run({ attempt: 2 })]);
    expect(await readCollection(db, DAILY_WORKFLOW_AGGREGATES)).toMatchObject([{
      runCount: 1, aicTotalSum: null, aicTotalObservedCount: 0
    }]);
    expect(await readCollection(db, DAILY_WORKFLOW_CONTRIBUTIONS)).toHaveLength(1);
  });

  it('retains exact UTC Monday window, keeps run summaries, and never double-counts tool evidence', async () => {
    const db = factory();
    expect(new Date(dailyWorkflowCutoff(now)).toISOString()).toBe('2026-10-05T00:00:00.000Z');
    const canonical = batch([
      run({ id: 'old', startedAt: '2026-10-04T23:59:59Z' }),
      run({ id: 'boundary', startedAt: '2026-10-05T00:00:00Z', mcpToolCalls: 3 }),
      run({ id: 'recent', mcpToolCalls: 2 })
    ]);
    canonical.tools.push({ id: 'tool', runId: 'recent', timestamp: '2026-10-22T01:00:00Z',
      invocationCount: 100 });
    await upsertCanonicalBatch(db, canonical, { now });
    const aggregates = await readCollection(db, DAILY_WORKFLOW_AGGREGATES);
    expect(aggregates.reduce((sum, row) => sum + Number(row.mcpToolCallsSum), 0)).toBe(5);
    expect(aggregates.reduce((sum, row) => sum + Number(row.toolCallsSum), 0)).toBe(100);
    expect(await readCollection(db, DAILY_WORKFLOW_CONTRIBUTIONS)).toHaveLength(2);
    await maintainCanonicalDatabase(db, {
      now: Date.parse('2026-10-26T00:00:00Z'), maxDatabaseBytes: Number.MAX_SAFE_INTEGER
    });
    expect(await readCollection(db, 'runs')).toHaveLength(3);
    expect(await readCollection(db, DAILY_WORKFLOW_AGGREGATES)).toMatchObject([{ day: '2026-10-22' }]);
    expect(await readCollection(db, DAILY_WORKFLOW_CONTRIBUTIONS)).toHaveLength(1);
  });

  it('corrects records-phase evidence after rich detail pruning without resurrecting details or double-counting', async () => {
    const db = factory();
    const canonical = batch([run({ startedAt: '2026-10-12T00:00:00Z', mcpToolCalls: 12 })]);
    canonical.tools.push(
      { id: 'tool', runId: 'run', timestamp: '2026-10-16T13:00:00Z', invocationCount: 3 },
      { id: 'zero', runId: 'run', timestamp: '2026-10-16T13:00:00Z', invocationCount: 0 },
      { id: 'unknown', runId: 'run', timestamp: '2026-10-16T13:00:00Z' }
    );
    canonical.domains.push({ id: 'domain', runId: 'run', timestamp: '2026-10-16T13:00:00Z', requestCount: 4 });
    await upsertCanonicalBatch(db, canonical, { now });
    expect(await readCollection(db, DAILY_WORKFLOW_AGGREGATES)).toMatchObject([{
      runCount: 1, mcpToolCallsSum: 12,
      toolCallsSum: 3, toolCallsObservedCount: 2,
      domainCallsSum: 4, domainCallsObservedCount: 1
    }]);
    const later = Date.parse('2026-10-25T12:00:00Z');
    await maintainCanonicalDatabase(db, { now: later, maxDatabaseBytes: Number.MAX_SAFE_INTEGER });
    expect(await readCollection(db, 'tools')).toEqual([]);
    expect(await readCollection(db, 'domains')).toEqual([]);
    async function ingest(/** @type {string} */ collection, /** @type {Record<string, unknown>} */ record, /** @type {string} */ hash) {
      async function* chunks() {
        yield [
          { kind: 'metadata', schemaVersion: CANONICAL_SCHEMA_VERSION, ingestionVersion: 5, phase: 'records', records: 1 },
          { kind: 'record', collection, record }
        ].map((row) => JSON.stringify(row)).join('\n');
      }
      return ingestNormalizedJsonl(db, chunks(), {
        now: later, payloadIdentity: hash, payloadScope: hash, expectedPhase: 'records', deferMaintenance: true
      });
    }
    const corrected = { ...canonical.tools[0], invocationCount: 7 };
    await ingest('tools', corrected, 'corrected');
    await ingest('tools', corrected, 'replayed-different-transport');
    await ingest('domains', { ...canonical.domains[0], requestCount: null }, 'domain-correction');
    expect(await readCollection(db, 'tools')).toEqual([]);
    expect(await readCollection(db, 'domains')).toEqual([]);
    expect(await readCollection(db, DAILY_WORKFLOW_AGGREGATES)).toMatchObject([{
      runCount: 1, mcpToolCallsSum: 12, toolCallsSum: 7, toolCallsObservedCount: 2,
      domainCallsSum: null, domainCallsObservedCount: 0
    }]);
    await upsertCanonicalBatch(db, batch([{ id: 'run', conclusion: 'success' }]), {
      now: later, validateRelationships: false
    });
    expect(await readCollection(db, DAILY_WORKFLOW_AGGREGATES)).toMatchObject([{
      toolCallsSum: 7, toolCallsObservedCount: 2, successCount: 1, runCount: 1
    }]);
  });

  it('groups only by namespace, UTC day, repository and workflow with measured-zero coverage', async () => {
    const db = factory();
    await upsertCanonicalBatch(db, batch([
      run({ id: 'success', event: 'schedule', conclusion: 'success', safeItemsCount: 0 }),
      run({ id: 'failure', event: 'push', conclusion: 'failure', safeItemsCount: 7 }),
      run({ id: 'missing', safeItemsCount: null }),
      run({ id: 'namespace', namespace: 'other', safeItemsCount: 3 })
    ]), { now });
    const groups = await readCollection(db, DAILY_WORKFLOW_AGGREGATES);
    expect(groups).toHaveLength(2);
    expect(groups.find((group) => group.namespace === '')).toMatchObject({
      runCount: 3, safeItemsCountSum: 7, safeItemsCountObservedCount: 2,
      successCount: 1, failureCount: 1, observedConclusionCount: 2
    });
    expect(groups.find((group) => group.namespace === 'other')).toMatchObject({
      runCount: 1, safeItemsCountSum: 3, safeItemsCountObservedCount: 1
    });
  });

  it('corrects outcome counters independently from grouping and tracks explicit unknown conclusions', async () => {
    const db = factory();
    await upsertCanonicalBatch(db, batch([
      run({ id: 'success', conclusion: 'success' }),
      run({ id: 'timed', conclusion: 'timed_out' }),
      run({ id: 'other', conclusion: 'stale' }),
      run({ id: 'missing', conclusion: null }),
      run({ id: 'empty', conclusion: '' }),
      run({ id: 'whitespace', conclusion: '  ' }),
      run({ id: 'hyphenated', conclusion: 'timed-out' })
    ]), { now });
    expect(await readCollection(db, DAILY_WORKFLOW_AGGREGATES)).toMatchObject([{
      runCount: 7, successCount: 1, timedOutCount: 1, observedConclusionCount: 4
    }]);
    await upsertCanonicalBatch(db, batch([
      run({ id: 'success', conclusion: 'failure' }),
      run({ id: 'timed', conclusion: null })
    ]), { now });
    expect(await readCollection(db, DAILY_WORKFLOW_AGGREGATES)).toMatchObject([{
      runCount: 7, successCount: 0, failureCount: 1, timedOutCount: 0, observedConclusionCount: 3
    }]);
  });

  it('uses business timestamps and never dates undated admission from ingestion time', async () => {
    const db = factory();
    await upsertCanonicalBatch(db, batch([
      run({ id: 'undated', startedAt: null, observedAt: '2026-10-22T12:00:00Z', aicTotal: 100 }),
      run({ id: 'created', startedAt: null, createdAt: '2026-10-21T12:00:00Z', aicTotal: 2 }),
      run({ id: 'completed', startedAt: 'invalid', completedAt: '2026-10-20T12:00:00Z',
        createdAt: '2026-10-19T12:00:00Z', aicTotal: 3 })
    ]), { now });
    const groups = await readCollection(db, DAILY_WORKFLOW_AGGREGATES);
    expect(groups.map((group) => group.day).sort()).toEqual(['2026-10-20', '2026-10-21']);
    expect(groups.reduce((sum, group) => sum + Number(group.aicTotalSum), 0)).toBe(5);
    expect(await readCollection(db, 'runs')).toHaveLength(3);
  });

  it('connects retained child measurements when an undated Run gains its business timestamp', async () => {
    const db = factory();
    const canonical = batch([run({ startedAt: null, observedAt: '2026-10-22T00:00:00Z' })]);
    canonical.tools.push({ id: 'tool', runId: 'run', timestamp: '2026-10-22T00:00:00Z', invocationCount: 3 });
    canonical.domains.push({ id: 'domain', runId: 'run', timestamp: '2026-10-22T00:00:00Z', requestCount: 2 });
    await upsertCanonicalBatch(db, canonical, { now });
    expect(await readCollection(db, DAILY_WORKFLOW_AGGREGATES)).toEqual([]);
    await upsertCanonicalBatch(db, batch([{ id: 'run', startedAt: '2026-10-22T00:00:00Z' }]), {
      now, validateRelationships: false
    });
    expect(await readCollection(db, DAILY_WORKFLOW_AGGREGATES)).toMatchObject([{
      runCount: 1, toolCallsSum: 3, toolCallsObservedCount: 1,
      domainCallsSum: 2, domainCallsObservedCount: 1
    }]);
  });

  it('rolls back run, aggregate, ledger and accounting together', async () => {
    const db = factory();
    const database = await openCanonicalDatabase(db);
    const transaction = database.transaction(['runs', DAILY_WORKFLOW_AGGREGATES,
      DAILY_WORKFLOW_CONTRIBUTIONS, 'storageShards'], 'readwrite');
    const aborted = new Promise((resolve) => { transaction.onabort = resolve; });
    await writeAccountedRecords(transaction, 'runs', [prepareCanonicalRecord('runs', run())], [], { now });
    transaction.abort();
    await aborted;
    const totals = await new Promise((resolve, reject) => {
      const request = database.transaction('storageShards').objectStore('storageShards').get('totals');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(totals).toBeUndefined();
    database.close();
    for (const store of /** @type {const} */ (['runs', DAILY_WORKFLOW_AGGREGATES, DAILY_WORKFLOW_CONTRIBUTIONS])) {
      expect(await readCollection(db, store)).toEqual([]);
    }
  });

  it('rolls back child evidence and its aggregate contribution together', async () => {
    const db = factory();
    const canonical = batch([run()]);
    canonical.tools.push({ id: 'tool', runId: 'run', timestamp: '2026-10-22T00:00:00Z', invocationCount: 3 });
    await upsertCanonicalBatch(db, canonical, { now });
    const database = await openCanonicalDatabase(db);
    const transaction = database.transaction(['runs', 'tools', DAILY_WORKFLOW_AGGREGATES,
      DAILY_WORKFLOW_CONTRIBUTIONS, 'storageShards'], 'readwrite');
    const aborted = new Promise((resolve) => { transaction.onabort = resolve; });
    await writeAccountedRecords(transaction, 'tools', [
      prepareCanonicalRecord('tools', { ...canonical.tools[0], invocationCount: 9 })
    ], [], { now });
    transaction.abort();
    await aborted;
    database.close();
    expect(await readCollection(db, 'tools')).toMatchObject([{ invocationCount: 3 }]);
    expect(await readCollection(db, DAILY_WORKFLOW_AGGREGATES)).toMatchObject([{
      toolCallsSum: 3, toolCallsObservedCount: 1
    }]);
    expect(await readCollection(db, DAILY_WORKFLOW_CONTRIBUTIONS)).toMatchObject([{
      toolEvidence: { tool: 3 }
    }]);
  });
});

it('persists SQLite groups and repairs them from the compact ledger after short run retention', async () => {
  const filename = resolve(`.daily-workflow-repair-${process.pid}.sqlite`);
  filenames.push(filename);
  const db = installSqliteIndexedDB(filename);
  const canonical = batch([run({ startedAt: '2026-10-05T00:00:00Z', aicTotal: 5 })]);
  canonical.tools.push({ id: 'tool', runId: 'run', timestamp: '2026-10-05T00:00:00Z', invocationCount: 2 });
  canonical.domains.push({ id: 'domain', runId: 'run', timestamp: '2026-10-05T00:00:00Z', requestCount: 9 });
  await upsertCanonicalBatch(db, canonical, { now });
  await maintainCanonicalDatabase(db, {
    ...sqliteRetention(undefined, 7 * 86400000, 86400000), now, maxDatabaseBytes: Number.MAX_SAFE_INTEGER
  });
  expect(await readCollection(db, 'runs')).toEqual([]);
  expect(await readCollection(db, 'tools')).toEqual([]);
  expect(await readCollection(db, 'domains')).toEqual([]);
  const connection = new DatabaseSync(filename);
  expect(connection.prepare('SELECT count(*) AS n FROM __idb_records WHERE store_name = ?')
    .get(DAILY_WORKFLOW_AGGREGATES)?.n).toBe(1);
  connection.prepare('DELETE FROM __idb_records WHERE database_name = ? AND store_name = ?')
    .run(DATABASE_NAME, DAILY_WORKFLOW_AGGREGATES);
  connection.close();
  const result = await doctorSqliteDatabase(filename, { now });
  expect(result.healthy).toBe(true);
  const reopened = createSqliteIndexedDB(filename);
  expect(await readCollection(reopened, DAILY_WORKFLOW_AGGREGATES)).toMatchObject([{
    runCount: 1, aicTotalSum: 5, aicTotalObservedCount: 1,
    toolCallsSum: 2, toolCallsObservedCount: 1, domainCallsSum: 9, domainCallsObservedCount: 1
  }]);
  for (const action of result.repairs?.backup ? [result.repairs.backup] : []) filenames.push(action);
});
