import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DATABASE_NAME,
  DATABASE_VERSION,
  maintainCanonicalDatabase,
  openCanonicalDatabase,
  publishDailyOverviewAggregates,
  readCollection,
  readDailyOverviewAggregates,
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
import { CANONICAL_SCHEMA_VERSION } from '../../src/data/model/schema.js';

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
  canonical.campaigns.push({ id: 'campaign:1', slug: 'dashboard' });
  canonical.repositories.push({ id: 'repository:1' });
  canonical.workflows.push({
    id: 'workflow:1',
    repositoryId: 'repository:1',
    campaignId: 'campaign:1',
    campaign: 'dashboard'
  });
  canonical.runs.push({
    id: 'run:1',
    repositoryId: 'repository:1',
    workflowId: 'workflow:1',
    conclusion: 'success'
  });
  canonical.audits.push(
    { id: 'audit:2', runId: 'run:1', sequence: 2 },
    { id: 'audit:1', runId: 'run:1', sequence: 1 }
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

describe('SQLite IndexedDB compatibility layer', { timeout: 30000 }, () => {
  it('persists canonical records and supports compound index queries', async () => {
    const filename = temporaryDatabase();
    const indexedDB = installSqliteIndexedDB(filename);
    const database = await openCanonicalDatabase(indexedDB);
    expect([...database.objectStoreNames]).toEqual(expect.arrayContaining([
      'domains', 'tools', 'audits', 'issues'
    ]));
    expect([...database.objectStoreNames]).toContain('campaigns');
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
    expect(await readIndex(reopened, 'audits', 'byRun', ['run:1'])).toEqual([
      expect.objectContaining({ id: 'audit:1' }),
      expect.objectContaining({ id: 'audit:2' })
    ]);
    expect(await readTransactions(reopened)).toEqual([
      expect.objectContaining({ id: 'transaction:1' })
    ]);

    const replacement = batch();
    replacement.audits = [];
    await replaceCanonicalBatch(reopened, replacement);
    expect(await readCollection(reopened, 'audits')).toEqual([]);
    expect(readFileSync(filename, 'utf8').slice(0, 15)).toBe('SQLite format 3');
  });

  it('cascades retention eviction through SQLite indexes', async () => {
    const indexedDB = installSqliteIndexedDB(temporaryDatabase());
    const canonical = batch();
    canonical.runs[0].observedAt = '2026-01-01T00:00:00Z';
    canonical.audits = canonical.audits.map((record) => ({
      ...record,
      observedAt: '2026-09-09T00:00:00Z'
    }));
    await upsertCanonicalBatch(indexedDB, canonical);

    await maintainCanonicalDatabase(indexedDB, {
      now: Date.parse('2026-09-10T00:00:00Z'),
      retentionWindowMs: 30 * 24 * 60 * 60 * 1000,
      maxDatabaseBytes: Number.MAX_SAFE_INTEGER
    });

    expect(await readCollection(indexedDB, 'runs')).toEqual([]);
    expect(await readCollection(indexedDB, 'audits')).toEqual([]);
  });

  it('publishes and range-reads daily overview aggregates through the compound generation/day index', async () => {
    const filename = temporaryDatabase();
    const indexedDB = installSqliteIndexedDB(filename);

    await publishDailyOverviewAggregates(indexedDB, {
      generation: 'generation-a',
      builtAt: '2026-09-21T00:00:00Z',
      dailyAggregates: [
        { day: '2026-09-10', runs: 5, successfulRuns: 4, failedRuns: 1, dispatches: 2, failedDispatches: 0 },
        { day: '2026-09-11', runs: 6, successfulRuns: 6, failedRuns: 0, dispatches: 3, failedDispatches: 1 }
      ]
    });

    const reopened = createSqliteIndexedDB(filename);
    const result = await readDailyOverviewAggregates(reopened, { startDay: '2026-09-10', endDay: '2026-09-10' });
    expect(result.available).toBe(true);
    expect(result.generation).toBe('generation-a');
    expect(result.records).toEqual([
      expect.objectContaining({ day: '2026-09-10', runs: 5, generation: 'generation-a' })
    ]);
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
    expect(ingestion.counts).toMatchObject({ runs: 1, domains: 1, tools: 3, audits: 2, issues: 0 });

    const runs = JSON.parse(execFileSync(process.execPath, [
      script,
      'query',
      '--database', filename,
      '--collection', 'runs',
      '--where', 'conclusion=success'
    ], { encoding: 'utf8' }));
    expect(runs).toEqual([
      expect.objectContaining({ id: 'github:run:githubnext/gh-aw-cao:303' })
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
      after: {
        counts: {
          repositories: 1, workflows: 1, runs: 1, domains: 1, tools: 3, audits: 2, issues: 0
        }
      }
    });
  });

  it('ingests cached JSONL with collection context across separate Node.js processes', () => {
    const filename = temporaryDatabase();
    const script = resolve('../../activity/cao.mjs');
    const input = resolve('test/fixtures/gh-aw-logs/cached-v2.jsonl');
    const context = resolve('test/fixtures/gh-aw-logs/cached-v2-context.json');
    const shardDirectory = join(filename, '..', 'shards');
    mkdirSync(shardDirectory);
    copyFileSync(input, join(shardDirectory, 'cached-v2.jsonl'));

    const ingestion = JSON.parse(execFileSync(process.execPath, [
      script,
      'ingest-jsonl',
      '--database', filename,
      '--input-dir', shardDirectory,
      '--context', context
    ], { encoding: 'utf8' }));
    expect(ingestion).toMatchObject({
      result: {
        records: 3,
        rawRuns: 1,
        agenticRuns: 1,
        mappedRateLimits: 1
      },
      counts: {
        repositories: 1,
        workflows: 1,
        runs: 1
      }
    });

    const normalizedDirectory = join(filename, '..', 'normalized');
    const manifestPath = join(filename, '..', 'payload-hashes.json');
    const hashes = JSON.parse(execFileSync(process.execPath, [
      script,
      'hash-payloads',
      '--database', filename,
      '--shard-dir', shardDirectory,
      '--normalized-dir', normalizedDirectory,
      '--output', manifestPath
    ], { encoding: 'utf8' }));
    const normalizedName = readdirSync(normalizedDirectory).find((name) => name.endsWith('.jsonl'));
    if (!normalizedName) throw new Error('Normalized payload was not generated');
    expect(normalizedName).toMatch(/^[a-f0-9]{64}-[a-f0-9]{16}\.jsonl$/);
    expect(readdirSync(normalizedDirectory).some((name) => name.endsWith('.json'))).toBe(false);
    expect(hashes).toMatchObject({
      'dashboard.sqlite': expect.stringMatching(/^[a-f0-9]{64}$/),
      'shards/cached-v2.jsonl': expect.stringMatching(/^[a-f0-9]{64}$/),
      [`normalized/${normalizedName}`]: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    const [normalizedMetadata, ...normalizedRecords] = readFileSync(
      join(normalizedDirectory, normalizedName),
      'utf8'
    ).trim().split('\n').map((line) => JSON.parse(line));
    expect(normalizedMetadata).toMatchObject({
      kind: 'metadata',
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      ingestionVersion: 3,
      sourceRecords: 3,
      phase: 'all',
      records: normalizedRecords.length
    });
    expect(normalizedRecords.every(({ kind, collection, record }) =>
      kind === 'record' && typeof collection === 'string' && record && typeof record === 'object'
    )).toBe(true);

    const audits = JSON.parse(execFileSync(process.execPath, [
      script,
      'query',
      '--database', filename,
      '--collection', 'audits',
      '--where', 'type=github_api_rate_limit'
    ], { encoding: 'utf8' }));
    expect(audits).toEqual([
      expect.objectContaining({
        source: 'github-api',
        type: 'github_api_rate_limit',
        status: 'available'
      })
    ]);

    const audit = JSON.parse(execFileSync(process.execPath, [
      script,
      'audit-jsonl',
      '--input-dir', shardDirectory
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
      canonical: { repositories: 1, workflows: 1, runs: 1 }
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
    const oldInput = join(directory, 'old-shards');
    const currentInput = join(directory, 'current-shards');
    mkdirSync(oldInput);
    mkdirSync(currentInput);
    writeFileSync(join(oldInput, 'old.jsonl'), `${input(100, '2020-01-01T00:00:00Z')}\n`);
    writeFileSync(join(currentInput, 'current.jsonl'), `${input(200, '2026-09-11T00:00:00Z')}\n`);

    for (const source of [oldInput, currentInput]) {
      execFileSync(process.execPath, [
        script,
        'ingest-jsonl',
        '--database', filename,
        '--input-dir', source,
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
      'github:run:githubnext/gh-aw-cao:100',
      'github:run:githubnext/gh-aw-cao:200'
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
    current.audits.forEach((audit) => {
      audit.timestamp = '2026-09-09T00:00:00Z';
    });
    await upsertCanonicalBatch(indexedDB, current);

    const stale = batch();
    for (const records of Object.values(stale)) {
      for (const record of records) {
        record.id = `stale:${record.id}`;
        record.observedAt = '2020-01-01T00:00:00Z';
      }
    }
    stale.workflows[0].campaignId = stale.campaigns[0].id;
    stale.workflows[0].repositoryId = stale.repositories[0].id;
    stale.runs[0].repositoryId = stale.repositories[0].id;
    stale.runs[0].workflowId = stale.workflows[0].id;
    stale.audits.forEach((audit) => {
      audit.runId = stale.runs[0].id;
      audit.timestamp = '2020-01-01T00:00:00Z';
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
    insert.run(DATABASE_NAME, 'audits', JSON.stringify('audit:orphan'), JSON.stringify({
      id: 'audit:orphan',
      runId: 'run:missing',
      observedAt: '2026-09-09T00:00:00Z'
    }));
    insert.run(DATABASE_NAME, 'transactions', JSON.stringify('transaction:stale'), JSON.stringify({
      id: 'transaction:stale',
      kind: 'test',
      createdAt: '2020-01-01T00:00:00Z'
    }));
    insert.run(DATABASE_NAME, 'transactions', JSON.stringify('ingest-normalized-json:sha256:stable:v2'), JSON.stringify({
      id: 'ingest-normalized-json:sha256:stable:v2',
      kind: 'ingest-normalized-json',
      createdAt: '2020-01-01T00:00:00Z',
      payloadHash: 'stable',
      ingestionVersion: 2
    }));
    const malformed = connection.prepare(`
      SELECT record_key FROM __idb_records
      WHERE database_name = ? AND store_name = 'audits' AND record_key != ?
      ORDER BY record_key LIMIT 1
    `).get(DATABASE_NAME, JSON.stringify('audit:orphan'));
    expect(malformed).toBeDefined();
    connection.prepare(`
      UPDATE __idb_records SET value = 'not-json'
      WHERE database_name = ? AND store_name = 'audits' AND record_key = ?
    `).run(DATABASE_NAME, /** @type {{ record_key: string }} */ (malformed).record_key);
    connection.prepare(`
      DELETE FROM __idb_indexes
      WHERE database_name = ? AND store_name = 'audits' AND name = 'byType'
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
        canonicalRecordsRemoved: 4,
        transactionsRemoved: 1
      },
      after: {
        counts: { repositories: 2, workflows: 2, runs: 1, audits: 1 },
        transactions: 1,
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
