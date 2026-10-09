import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DATABASE_NAME,
  DATABASE_VERSION,
  countCollections,
  maintainCanonicalDatabase,
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
    expect(await countCollections(reopened, ['runs', 'audits', 'transactions'])).toEqual({
      runs: 1,
      audits: 2,
      transactions: 1
    });

    const replacement = batch();
    replacement.audits = [];
    await replaceCanonicalBatch(reopened, replacement);
    expect(await readCollection(reopened, 'audits')).toEqual([]);
    expect(readFileSync(filename, 'utf8').slice(0, 15)).toBe('SQLite format 3');
  });

  it('rebuilds outdated eval mirrors from canonical records without duplicate documents', async () => {
    const filename = temporaryDatabase();
    const record = {
      id: 'eval-observation:1', runId: 'run:1', evalId: 'eval:1',
      experimentId: 'experiment:1', variant: 'candidate',
      observedAt: '2026-09-10T00:00:00Z', provenance: { source: 'gh-aw-logs' }
    };
    const indexedDB = installSqliteIndexedDB(filename);
    const evidence = batch();
    evidence.experiments?.push({
      id: 'experiment:1', workflowId: 'workflow:1', observedAt: record.observedAt, provenance: record.provenance
    });
    evidence.evals?.push({
      id: 'eval:1', workflowId: 'workflow:1', observedAt: record.observedAt, provenance: record.provenance
    });
    evidence.evalObservations?.push(record);
    await upsertCanonicalBatch(indexedDB, evidence);
    const connection = new DatabaseSync(filename);
    connection.exec(`
      DROP TRIGGER eval_observations_insert;
      DROP TRIGGER eval_observations_update;
      DROP TRIGGER eval_observations_delete;
      DROP TABLE eval_observations;
      CREATE TABLE eval_observations (
        database_name TEXT NOT NULL, id TEXT NOT NULL, run_id TEXT, eval_id TEXT,
        observed_at TEXT NOT NULL, provenance TEXT NOT NULL, record_json TEXT NOT NULL,
        PRIMARY KEY (database_name, id)
      );
    `);
    connection.prepare(`
      INSERT INTO eval_observations
        (database_name, id, run_id, eval_id, observed_at, provenance, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(DATABASE_NAME, record.id, record.runId, record.evalId,
      record.observedAt, JSON.stringify(record.provenance), JSON.stringify(record));
    connection.close();

    const reopened = createSqliteIndexedDB(filename);
    (await openCanonicalDatabase(reopened)).close();
    const upgraded = new DatabaseSync(filename);
    expect(upgraded.prepare('SELECT experiment_id, variant FROM eval_observations').get())
      .toMatchObject({ experiment_id: 'experiment:1', variant: 'candidate' });
    expect(upgraded.prepare('PRAGMA table_info(eval_observations)').all().map((row) => row.name))
      .not.toContain('record_json');
    upgraded.close();
    expect(await readCollection(reopened, 'evalObservations')).toEqual([record]);
  });

  it('projects the six evidence collections into transactional relational SQLite tables', async () => {
    const filename = temporaryDatabase();
    const indexedDB = installSqliteIndexedDB(filename);
    const evidence = batch();
    const timestamp = '2026-09-10T00:00:00Z';
    const provenance = { source: 'gh-aw-logs', sourceId: 'run:1', observedAt: timestamp };
    evidence.experiments?.push({ id: 'experiment:1', workflowId: 'workflow:1', observedAt: timestamp, provenance });
    evidence.experimentAssignments?.push({
      id: 'assignment:1', runId: 'run:1', experimentId: 'experiment:1', variant: 'candidate',
      included: false, exclusionReason: 'insufficient-evidence', observedAt: timestamp, provenance
    });
    evidence.graders?.push({ id: 'grader:1', workflowId: 'workflow:1', observedAt: timestamp, provenance });
    evidence.graderObservations?.push({
      id: 'grade:1', runId: 'run:1', graderId: 'grader:1', value: 0.8,
      status: 'pass', auditId: 'audit:1', sourceGraderId: 'quality',
      experimentId: 'experiment:1', variant: 'candidate',
      evaluatorDigest: 'evaluator:v1', resultTimestamp: timestamp,
      observedAt: timestamp, provenance
    });
    evidence.evals?.push({ id: 'eval:1', workflowId: 'workflow:1', observedAt: timestamp, provenance });
    evidence.evalObservations?.push({
      id: 'eval-observation:1', runId: 'run:1', evalId: 'eval:1', evalResult: 'YES',
      experimentId: 'experiment:1', variant: 'candidate',
      requestedModel: 'model-requested', resolvedModel: 'model-resolved',
      auditId: 'audit:eval', observedAt: timestamp, provenance
    });
    await upsertCanonicalBatch(indexedDB, evidence);
    const connection = new DatabaseSync(filename);
    for (const table of [
      'experiments', 'experiment_assignments', 'graders',
      'grader_observations', 'evals', 'eval_observations'
    ]) {
      expect(connection.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toMatchObject({ count: 1 });
      expect(connection.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name))
        .not.toContain('record_json');
    }
    expect(connection.prepare('SELECT run_id, experiment_id, variant, included, exclusion_reason FROM experiment_assignments').get())
      .toMatchObject({ run_id: 'run:1', experiment_id: 'experiment:1',
        variant: 'candidate', included: 0, exclusion_reason: 'insufficient-evidence' });
    expect(connection.prepare(`
      SELECT grader_id, value, status, audit_id, experiment_id, variant,
             evaluator_digest, timestamp FROM grader_observations
    `).get()).toMatchObject({
      grader_id: 'grader:1', value: 0.8, status: 'pass', audit_id: 'audit:1',
      experiment_id: 'experiment:1', variant: 'candidate',
      evaluator_digest: 'evaluator:v1', timestamp
    });
    expect(connection.prepare('SELECT eval_result, audit_id FROM eval_observations').get())
      .toMatchObject({ eval_result: 'YES', audit_id: 'audit:eval' });
    for (const table of ['grader_observations', 'eval_observations']) {
      const columns = connection.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
      expect(columns).not.toContain('source_grader_id');
      expect(columns).not.toContain('source_eval_id');
      expect(columns).not.toContain('result_timestamp');
      expect(columns).not.toContain('requested_model');
      expect(columns).not.toContain('resolved_model');
    }
    expect(connection.prepare(`
      SELECT a.run_id, e.id AS experiment, a.variant, g.id AS grader,
             go.value, go.audit_id AS grader_audit, ev.id AS eval,
             eo.eval_result, eo.audit_id AS eval_audit
      FROM experiment_assignments a
      JOIN experiments e ON e.database_name = a.database_name AND e.id = a.experiment_id
      JOIN grader_observations go ON go.database_name = a.database_name
        AND go.run_id = a.run_id AND go.experiment_id = a.experiment_id AND go.variant = a.variant
      JOIN graders g ON g.database_name = go.database_name AND g.id = go.grader_id
      JOIN eval_observations eo ON eo.database_name = a.database_name
        AND eo.run_id = a.run_id AND eo.experiment_id = a.experiment_id AND eo.variant = a.variant
      JOIN evals ev ON ev.database_name = eo.database_name AND ev.id = eo.eval_id
    `).all()).toEqual([{
      run_id: 'run:1', experiment: 'experiment:1', variant: 'candidate',
      grader: 'grader:1', value: 0.8, grader_audit: 'audit:1',
      eval: 'eval:1', eval_result: 'YES', eval_audit: 'audit:eval'
    }]);
    connection.close();
    evidence.graders = [{
      ...evidence.graders?.[0], observedAt: '2026-09-09T00:00:00Z', displayName: 'Older observation'
    }];
    await upsertCanonicalBatch(indexedDB, evidence);
    const replayed = await readCollection(indexedDB, 'graders');
    expect(replayed[0]).toMatchObject({
      observedAt: timestamp,
      firstObservedAt: '2026-09-09T00:00:00Z',
      lastObservedAt: timestamp
    });
    const range = new DatabaseSync(filename);
    expect(range.prepare('SELECT first_observed_at, last_observed_at FROM graders').get())
      .toMatchObject({ first_observed_at: '2026-09-09T00:00:00Z', last_observed_at: timestamp });
    range.close();
    await replaceCanonicalBatch(indexedDB, batch());
    const after = new DatabaseSync(filename);
    expect(after.prepare('SELECT count(*) AS count FROM experiment_assignments').get()).toMatchObject({ count: 0 });
    after.close();
    await upsertCanonicalBatch(indexedDB, evidence);
    const upgraded = indexedDB.open(DATABASE_NAME, DATABASE_VERSION + 1);
    upgraded.onupgradeneeded = () => {
      for (const store of [
        'experiments', 'experimentAssignments', 'graders',
        'graderObservations', 'evals', 'evalObservations'
      ]) upgraded.result.deleteObjectStore(store);
    };
    const versioned = await /** @type {Promise<IDBDatabase>} */ (new Promise((resolve, reject) => {
      upgraded.onsuccess = () => resolve(upgraded.result);
      upgraded.onerror = () => reject(upgraded.error);
    }));
    versioned.close();
    const afterUpgrade = new DatabaseSync(filename);
    for (const table of [
      'experiments', 'experiment_assignments', 'graders',
      'grader_observations', 'evals', 'eval_observations'
    ]) {
      expect(afterUpgrade.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toMatchObject({ count: 0 });
    }
    afterUpgrade.close();
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
      '--logs', logs,
      '--retention-days', 'all',
      '--run-retention-days', 'all'
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
      '--context', context,
      '--retention-days', 'all',
      '--run-retention-days', 'all'
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
      ingestionVersion: 4,
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
      ttlDays: 7,
      runTtlDays: 'all',
      after: { counts: { runs: 2 } }
    });
  });

  it('applies separate default linked and run windows in SQLite CLI ingestion', async () => {
    const filename = temporaryDatabase();
    const runsDirectory = join(filename, '..', 'runs');
    const recordsDirectory = join(filename, '..', 'records');
    mkdirSync(runsDirectory);
    mkdirSync(recordsDirectory);
    const records = batch();
    records.audits = [];
    const old = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString();
    const expired = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    records.runs[0].observedAt = old;
    records.runs.push({ ...records.runs[0], id: 'run:recent', observedAt: recent });
    records.runs.push({ ...records.runs[0], id: 'run:expired', observedAt: expired });
    records.tools.push(
      { id: 'tool:old', runId: 'run:1', observedAt: old },
      { id: 'tool:recent', runId: 'run:recent', observedAt: recent }
    );
    records.operationalValues.push({ id: 'value:old', repositoryId: 'repository:1', observedAt: old });
    for (const [phase, directory] of [['runs', runsDirectory], ['records', recordsDirectory]]) {
      const entries = Object.entries(records).flatMap(([collection, rows]) =>
        (phase === 'runs'
          ? ['campaigns', 'repositories', 'workflows', 'runs', 'experiments', 'experimentAssignments'].includes(collection)
          : !['campaigns', 'repositories', 'workflows', 'runs', 'experiments', 'experimentAssignments'].includes(collection))
          ? rows.map((record) => ({ kind: 'record', collection, record }))
          : []);
      writeFileSync(join(directory, 'shard.jsonl'), [
        { kind: 'metadata', schemaVersion: CANONICAL_SCHEMA_VERSION, ingestionVersion: 4,
          sourceRecords: entries.length, phase, records: entries.length },
        ...entries
      ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    }
    const ingestion = JSON.parse(execFileSync(process.execPath, [
      resolve('../../activity/cao.mjs'), 'ingest-jsonl',
      '--database', filename, '--runs-dir', runsDirectory, '--records-dir', recordsDirectory
    ], { encoding: 'utf8' }));
    expect(ingestion.counts).toMatchObject({ runs: 2, tools: 1, operationalValues: 1 });
    const indexedDB = createSqliteIndexedDB(filename);
    expect((await readCollection(indexedDB, 'tools')).map(({ id }) => id)).toEqual(['tool:recent']);
  });

  it('defaults SQLite repair to seven-day linked detail and 30-day runs and values', async () => {
    const filename = temporaryDatabase();
    const indexedDB = installSqliteIndexedDB(filename);
    const canonical = batch();
    canonical.audits = [];
    canonical.runs[0].observedAt = '2026-09-01T00:00:00Z';
    canonical.runs.push({ ...canonical.runs[0], id: 'run:recent', observedAt: '2026-09-09T00:00:00Z' });
    canonical.tools.push(
      { id: 'tool:old', runId: 'run:1', observedAt: '2026-09-01T00:00:00Z' },
      { id: 'tool:recent', runId: 'run:recent', observedAt: '2026-09-09T00:00:00Z' }
    );
    canonical.operationalValues.push({
      id: 'value:old', repositoryId: 'repository:1', observedAt: '2026-09-01T00:00:00Z'
    });
    await upsertCanonicalBatch(indexedDB, canonical);
    const diagnosis = await doctorSqliteDatabase(filename, { now: Date.parse('2026-09-10T00:00:00Z') });
    expect(diagnosis).toMatchObject({ healthy: true, ttlDays: 7, runTtlDays: 30 });
    expect((await readCollection(indexedDB, 'runs')).map(({ id }) => id)).toEqual(['run:1', 'run:recent']);
    expect((await readCollection(indexedDB, 'tools')).map(({ id }) => id)).toEqual(['tool:recent']);
    expect((await readCollection(indexedDB, 'operationalValues')).map(({ id }) => id)).toEqual(['value:old']);
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
    insert.run(DATABASE_NAME, 'transactions', JSON.stringify('ingest-normalized-jsonl:sha256:stable:v3'), JSON.stringify({
      id: 'ingest-normalized-jsonl:sha256:stable:v3',
      kind: 'ingest-normalized-jsonl',
      createdAt: '2020-01-01T00:00:00Z',
      payloadHash: 'stable',
      ingestionVersion: 4
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
        transactionsRemoved: 2
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
