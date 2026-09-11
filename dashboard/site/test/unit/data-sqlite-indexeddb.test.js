import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DATABASE_NAME,
  DATABASE_VERSION,
  openCanonicalDatabase,
  readCollection,
  readIndex,
  readTransactions,
  recordTransaction,
  replaceCanonicalBatch,
  upsertCanonicalBatch
} from '../../src/data/storage/indexeddb.js';
import { normalize } from '../../src/data/normalize/index.js';
import { doctorSqliteDatabase } from '../../src/data/storage/sqlite-doctor.js';
import {
  createSqliteIndexedDB,
  installSqliteIndexedDB
} from '../../src/data/storage/sqlite-indexeddb.js';

const temporaryDirectories = /** @type {string[]} */ ([]);
const originalIndexedDB = globalThis.indexedDB;
const originalIDBKeyRange = globalThis.IDBKeyRange;

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'cao-sqlite-indexeddb-'));
  temporaryDirectories.push(directory);
  return join(directory, 'dashboard.sqlite');
}

function batch() {
  const canonical = normalize([]);
  canonical.packages.push({ id: 'package:1', slug: 'dashboard' });
  canonical.repositories.push({ id: 'repository:1' });
  canonical.workflows.push({
    id: 'workflow:1',
    repositoryId: 'repository:1',
    packageId: 'package:1',
    package: 'dashboard'
  });
  canonical.runs.push({
    id: 'run:1',
    repositoryId: 'repository:1',
    workflowId: 'workflow:1',
    conclusion: 'success'
  });
  canonical.sessions.push({ id: 'session:1', runId: 'run:1' });
  canonical.events.push(
    { id: 'event:2', sessionId: 'session:1', sequence: 2 },
    { id: 'event:1', sessionId: 'session:1', sequence: 1 }
  );
  return canonical;
}

afterEach(() => {
  globalThis.indexedDB = originalIndexedDB;
  globalThis.IDBKeyRange = originalIDBKeyRange;
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe('SQLite IndexedDB compatibility layer', () => {
  it('persists canonical records and supports compound index queries', async () => {
    const filename = temporaryDatabase();
    const indexedDB = installSqliteIndexedDB(filename);
    const database = await openCanonicalDatabase(indexedDB);
    expect([...database.objectStoreNames]).toContain('events');
    expect([...database.objectStoreNames]).toContain('packages');
    database.close();

    await upsertCanonicalBatch(indexedDB, batch());
    await recordTransaction(indexedDB, {
      id: 'transaction:1',
      kind: 'test',
      createdAt: '2026-09-10T00:00:00Z'
    });

    const reopened = createSqliteIndexedDB(filename);
    expect(await readCollection(reopened, 'runs')).toEqual([
      expect.objectContaining({ id: 'run:1', conclusion: 'success' })
    ]);
    expect(await readIndex(reopened, 'events', 'bySessionSequence', ['session:1'])).toEqual([
      expect.objectContaining({ id: 'event:1' }),
      expect.objectContaining({ id: 'event:2' })
    ]);
    expect(await readTransactions(reopened)).toEqual([
      expect.objectContaining({ id: 'transaction:1' })
    ]);

    const replacement = batch();
    replacement.events = [];
    await replaceCanonicalBatch(reopened, replacement);
    expect(await readCollection(reopened, 'events')).toEqual([]);
    expect(readFileSync(filename, 'utf8').slice(0, 15)).toBe('SQLite format 3');
  });

  it('deletes the named IndexedDB database without deleting the SQLite file', async () => {
    const filename = temporaryDatabase();
    const indexedDB = installSqliteIndexedDB(filename);
    const database = await openCanonicalDatabase(indexedDB);
    database.close();

    expect(await indexedDB.databases()).toEqual([
      { name: DATABASE_NAME, version: DATABASE_VERSION }
    ]);
    await new Promise((resolvePromise, reject) => {
      const request = indexedDB.deleteDatabase(DATABASE_NAME);
      request.onsuccess = resolvePromise;
      request.onerror = () => reject(request.error);
    });
    expect(await indexedDB.databases()).toEqual([]);
  });

  it('can retry a schema upgrade after the upgrade handler fails', async () => {
    const indexedDB = installSqliteIndexedDB(temporaryDatabase());
    const failed = indexedDB.open('upgrade-retry', 1);
    failed.onupgradeneeded = () => {
      throw new Error('upgrade failed');
    };
    await expect(new Promise((resolvePromise, reject) => {
      failed.onsuccess = resolvePromise;
      failed.onerror = () => reject(failed.error);
    })).rejects.toThrow('upgrade failed');

    const retried = indexedDB.open('upgrade-retry', 1);
    retried.onupgradeneeded = () => {
      retried.result.createObjectStore('records', { keyPath: 'id' });
    };
    const database = await new Promise((resolvePromise, reject) => {
      retried.onsuccess = () => resolvePromise(retried.result);
      retried.onerror = () => reject(retried.error);
    });
    expect([...database.objectStoreNames]).toEqual(['records']);
    database.close();
  });

  it('ingests and queries gh-aw logs across separate Node.js processes', () => {
    const filename = temporaryDatabase();
    const script = resolve('../../activity/cao.mjs');
    const context = resolve('test/fixtures/gh-aw-logs/context.json');
    const logs = resolve('test/fixtures/gh-aw-logs/run-303');

    const ingestion = JSON.parse(execFileSync(process.execPath, [
      script,
      'ingest',
      '--database', filename,
      '--context', context,
      '--logs', logs
    ], { encoding: 'utf8' }));
    expect(ingestion.counts).toMatchObject({ runs: 1, sessions: 1, events: 6 });

    const runs = JSON.parse(execFileSync(process.execPath, [
      script,
      'query',
      '--database', filename,
      '--collection', 'runs',
      '--where', 'conclusion=success'
    ], { encoding: 'utf8' }));
    expect(runs).toEqual([
      expect.objectContaining({ id: 'github:run:303:attempt:1' })
    ]);

    const diagnosis = JSON.parse(execFileSync(process.execPath, [
      script,
      'doctor',
      '--database', filename,
      '--ttl-days', '36500'
    ], { encoding: 'utf8' }));
    expect(diagnosis).toMatchObject({
      command: 'doctor',
      healthy: true,
      after: { counts: { repositories: 1, workflows: 1, runs: 1, jobs: 1, sessions: 1, events: 6 } }
    });
  });

  it('ingests cached JSONL with collection context across separate Node.js processes', () => {
    const filename = temporaryDatabase();
    const script = resolve('../../activity/cao.mjs');
    const input = resolve('test/fixtures/gh-aw-logs/cached-v2.jsonl');
    const context = resolve('test/fixtures/gh-aw-logs/cached-v2-context.json');

    const ingestion = JSON.parse(execFileSync(process.execPath, [
      script,
      'ingest-jsonl',
      '--database', filename,
      '--input', input,
      '--context', context
    ], { encoding: 'utf8' }));
    expect(ingestion).toMatchObject({
      result: {
        records: 3,
        rawRuns: 1,
        agenticRuns: 1,
        sessions: 2,
        mappedRateLimits: 1
      },
      counts: {
        repositories: 1,
        workflows: 1,
        runs: 1,
        sessions: 2
      }
    });

    const events = JSON.parse(execFileSync(process.execPath, [
      script,
      'query',
      '--database', filename,
      '--collection', 'events',
      '--where', 'type=github_api_rate_limit'
    ], { encoding: 'utf8' }));
    expect(events).toEqual([
      expect.objectContaining({
        source: 'github-api',
        type: 'github_api_rate_limit',
        status: 'available'
      })
    ]);

    const audit = JSON.parse(execFileSync(process.execPath, [
      script,
      'audit-jsonl',
      '--input', input
    ], { encoding: 'utf8' }));
    expect(audit).toMatchObject({
      command: 'audit-jsonl',
      source: {
        records: 3,
        rawRunObservations: 1,
        uniqueRawRuns: 1,
        duplicateRawRunObservations: 0,
        enrichedRunObservations: 1,
        uniqueEnrichedRuns: 1,
        duplicateEnrichedRunObservations: 0,
        unenrichedRuns: 0,
        enrichmentCoveragePercent: 100
      },
      canonical: { repositories: 1, workflows: 1, runs: 1, sessions: 1 }
    });
  });

  it('preserves backfilled history when retention is all', () => {
    const filename = temporaryDatabase();
    const directory = join(filename, '..');
    const script = resolve('../../activity/cao.mjs');
    /** @param {number} databaseId @param {string} timestamp */
    const input = (databaseId, timestamp) => JSON.stringify({
      schema_version: 2,
      kind: 'workflow_runs',
      request: { repository: 'githubnext/gh-aw-cao' },
      payload: [{
        databaseId,
        attempt: 1,
        workflowName: 'Dashboard',
        status: 'completed',
        conclusion: 'success',
        createdAt: timestamp,
        updatedAt: timestamp
      }]
    });
    const oldInput = join(directory, 'old.jsonl');
    const currentInput = join(directory, 'current.jsonl');
    writeFileSync(oldInput, `${input(100, '2020-01-01T00:00:00Z')}\n`);
    writeFileSync(currentInput, `${input(200, '2026-09-11T00:00:00Z')}\n`);

    for (const source of [oldInput, currentInput]) {
      execFileSync(process.execPath, [
        script,
        'ingest-jsonl',
        '--database', filename,
        '--input', source,
        '--run-retention-days', 'all'
      ], { encoding: 'utf8' });
    }

    const runs = JSON.parse(execFileSync(process.execPath, [
      script,
      'query',
      '--database', filename,
      '--collection', 'runs'
    ], { encoding: 'utf8' }));
    expect(/** @type {{ id: string }[]} */ (runs).map((run) => run.id)).toEqual([
      'github:run:100:attempt:1',
      'github:run:200:attempt:1'
    ]);

    const diagnosis = JSON.parse(execFileSync(process.execPath, [
      script,
      'doctor',
      '--database', filename,
      '--run-ttl-days', 'all'
    ], { encoding: 'utf8' }));
    expect(diagnosis).toMatchObject({
      healthy: true,
      ttlDays: 30,
      runTtlDays: 'all',
      after: { counts: { runs: 2 } }
    });
  });

  it('repairs malformed, orphaned, and expired canonical data', async () => {
    const filename = temporaryDatabase();
    const indexedDB = createSqliteIndexedDB(filename);
    const current = batch();
    for (const records of Object.values(current)) {
      for (const record of records) record.observedAt = '2026-09-09T00:00:00Z';
    }
    current.events.forEach((event) => {
      event.timestamp = '2026-09-09T00:00:00Z';
    });
    await upsertCanonicalBatch(indexedDB, current);

    const stale = batch();
    for (const records of Object.values(stale)) {
      for (const record of records) {
        record.id = `stale:${record.id}`;
        record.observedAt = '2020-01-01T00:00:00Z';
      }
    }
    stale.workflows[0].packageId = stale.packages[0].id;
    stale.workflows[0].repositoryId = stale.repositories[0].id;
    stale.runs[0].repositoryId = stale.repositories[0].id;
    stale.runs[0].workflowId = stale.workflows[0].id;
    stale.sessions[0].runId = stale.runs[0].id;
    stale.events.forEach((event) => {
      event.sessionId = stale.sessions[0].id;
      event.timestamp = '2020-01-01T00:00:00Z';
    });
    await upsertCanonicalBatch(indexedDB, stale);

    const connection = new DatabaseSync(filename);
    connection.prepare('INSERT INTO __idb_databases (name, version) VALUES (?, ?)')
      .run('unrelated-database', 1);
    connection.prepare(`
      INSERT INTO __idb_stores (database_name, name, key_path) VALUES (?, ?, ?)
    `).run('unrelated-database', 'notes', JSON.stringify('id'));
    connection.prepare(`
      INSERT INTO __idb_records (database_name, store_name, record_key, value)
      VALUES (?, ?, ?, ?)
    `).run('unrelated-database', 'notes', JSON.stringify('note:1'), JSON.stringify({ id: 'note:1' }));
    connection.prepare(`
      INSERT INTO __idb_stores (database_name, name, key_path) VALUES (?, ?, ?)
    `).run(DATABASE_NAME, 'annotations', JSON.stringify('id'));
    const insert = connection.prepare(`
      INSERT INTO __idb_records (database_name, store_name, record_key, value)
      VALUES (?, ?, ?, ?)
    `);
    insert.run(DATABASE_NAME, 'annotations', JSON.stringify('annotation:1'), JSON.stringify({
      id: 'annotation:1'
    }));
    insert.run(DATABASE_NAME, 'events', JSON.stringify('event:orphan'), JSON.stringify({
      id: 'event:orphan',
      sessionId: 'session:missing',
      observedAt: '2026-09-09T00:00:00Z'
    }));
    insert.run(DATABASE_NAME, 'transactions', JSON.stringify('transaction:stale'), JSON.stringify({
      id: 'transaction:stale',
      kind: 'test',
      createdAt: '2020-01-01T00:00:00Z'
    }));
    const malformed = connection.prepare(`
      SELECT record_key FROM __idb_records
      WHERE database_name = ? AND store_name = 'events' AND record_key != ?
      ORDER BY record_key LIMIT 1
    `).get(DATABASE_NAME, JSON.stringify('event:orphan'));
    expect(malformed).toBeDefined();
    connection.prepare(`
      UPDATE __idb_records SET value = 'not-json'
      WHERE database_name = ? AND store_name = 'events' AND record_key = ?
    `).run(DATABASE_NAME, /** @type {{ record_key: string }} */ (malformed).record_key);
    connection.prepare(`
      DELETE FROM __idb_indexes
      WHERE database_name = ? AND store_name = 'events' AND name = 'byType'
    `).run(DATABASE_NAME);
    connection.close();

    const diagnosis = await doctorSqliteDatabase(filename, {
      now: Date.parse('2026-09-10T00:00:00Z'),
      ttlDays: 30
    });
    expect(diagnosis).toMatchObject({
      healthy: true,
      repairs: {
        invalidRecordsRemoved: 2,
        canonicalRecordsRemoved: 5,
        transactionsRemoved: 1
      },
      after: {
        counts: { repositories: 2, workflows: 2, runs: 1, jobs: 0, sessions: 1, events: 1 },
        transactions: 0,
        invalidRecords: {},
        relationshipErrors: []
      }
    });
    expect(diagnosis.repairs.actions).toEqual(expect.arrayContaining([
      'remove-invalid-records',
      'prune-expired-or-orphaned-records',
      'prune-expired-transactions',
      'rebuild-schema',
      'reindex',
      'optimize',
      'vacuum'
    ]));
    expect(diagnosis.repairs.backup).toMatch(/\.doctor-backup-/);
    expect(existsSync(/** @type {string} */ (diagnosis.repairs.backup))).toBe(true);
    const repairedConnection = new DatabaseSync(filename);
    expect(repairedConnection.prepare(`
      SELECT COUNT(*) AS count FROM __idb_records WHERE database_name = ?
    `).get('unrelated-database')).toEqual({ count: 1 });
    repairedConnection.close();
  });

  it('recreates missing record storage and rejects overflowing TTL windows', async () => {
    const filename = temporaryDatabase();
    const indexedDB = installSqliteIndexedDB(filename);
    const database = await openCanonicalDatabase(indexedDB);
    database.close();

    const connection = new DatabaseSync(filename);
    connection.exec('DROP TABLE __idb_records');
    connection.close();

    const diagnosis = await doctorSqliteDatabase(filename);
    expect(diagnosis).toMatchObject({
      healthy: true,
      before: { recordError: expect.stringContaining('__idb_records') },
      after: { recordError: null }
    });
    expect(diagnosis.repairs.actions).toContain('rebuild-storage');
    await expect(doctorSqliteDatabase(filename, { ttlDays: Number.MAX_VALUE }))
      .rejects.toThrow('TTL days must produce a finite window greater than zero');
  });

  it('preserves standalone structural parents during TTL repair', async () => {
    const filename = temporaryDatabase();
    const indexedDB = installSqliteIndexedDB(filename);
    const canonical = normalize([]);
    canonical.repositories.push({ id: 'repository:standalone' });
    canonical.workflows.push({
      id: 'workflow:standalone',
      repositoryId: 'repository:standalone'
    });
    await upsertCanonicalBatch(indexedDB, canonical);

    const diagnosis = await doctorSqliteDatabase(filename);
    expect(diagnosis).toMatchObject({
      healthy: true,
      after: {
        counts: { repositories: 1, workflows: 1, runs: 0 }
      },
      repairs: { canonicalRecordsRemoved: 0 }
    });
  });

  it('reports unrelated foreign-key violations without rewriting canonical data', async () => {
    const filename = temporaryDatabase();
    const indexedDB = installSqliteIndexedDB(filename);
    const database = await openCanonicalDatabase(indexedDB);
    database.close();
    const connection = new DatabaseSync(filename);
    connection.exec('PRAGMA foreign_keys = OFF');
    connection.prepare(`
      INSERT INTO __idb_stores (database_name, name, key_path) VALUES (?, ?, ?)
    `).run('missing-database', 'notes', JSON.stringify('id'));
    connection.close();

    const diagnosis = await doctorSqliteDatabase(filename);
    expect(diagnosis).toMatchObject({
      healthy: true,
      before: {
        sqlite: { foreignKeyViolations: 0, outOfScopeForeignKeyViolations: 1 }
      },
      repairs: { backup: null }
    });
  });
});
