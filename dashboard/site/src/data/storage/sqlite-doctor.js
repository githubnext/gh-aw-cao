import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { relationshipErrors } from '../model/schema.js';
import { DATABASE_NAME, DATABASE_VERSION } from './indexeddb.js';
import { mergeRetainedRecords, RETENTION_WINDOW_DAYS } from './retention.js';
import { SQLITE_INDEXEDDB_METADATA_SCHEMA } from './sqlite-indexeddb.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const ENTITY_STORES = /** @type {const} */ (
  ['repositories', 'workflows', 'runs', 'jobs', 'sessions', 'events']
);
const EXPECTED_INDEXES = /** @type {Record<string, Record<string, string | string[]>>} */ ({
  repositories: { byGithubId: 'githubId', byFullName: 'fullName' },
  workflows: { byRepository: 'repositoryId', byRepositoryPath: ['repositoryId', 'path'] },
  runs: {
    byRepository: 'repositoryId',
    byWorkflow: 'workflowId',
    byStatus: 'status',
    byRepositoryStartedAt: ['repositoryId', 'startedAt'],
    byWorkflowStartedAt: ['workflowId', 'startedAt']
  },
  jobs: { byRun: 'runId', byRunStartedAt: ['runId', 'startedAt'] },
  sessions: {
    byRun: 'runId',
    byJob: 'jobId',
    byRunStartedAt: ['runId', 'startedAt'],
    byJobStartedAt: ['jobId', 'startedAt']
  },
  events: {
    bySessionSequence: ['sessionId', 'sequence'],
    bySessionTimestamp: ['sessionId', 'timestamp'],
    byType: 'type',
    bySource: 'source',
    byCorrelation: 'correlationId'
  },
  transactions: { byCreatedAt: 'createdAt', byKind: 'kind' }
});
const EXPECTED_STORES = [...ENTITY_STORES, 'transactions'];

/** @typedef {{ id: string, kind: string, createdAt: string, [field: string]: unknown }} DoctorTransaction */

/** @returns {import('../model/schema.js').CanonicalBatch} */
function emptyBatch() {
  return /** @type {import('../model/schema.js').CanonicalBatch} */ (
    /** @type {unknown} */ (Object.fromEntries(ENTITY_STORES.map((store) => [store, []])))
  );
}

/** @param {Record<string, unknown> | undefined} row */
function firstValue(row) {
  return row ? Object.values(row)[0] : null;
}

/** @param {string} filename */
function sqliteDiagnostics(filename) {
  const connection = new DatabaseSync(filename, { readOnly: true });
  try {
    const integrity = connection.prepare('PRAGMA integrity_check').all()
      .map((row) => String(firstValue(row)));
    return {
      integrity,
      foreignKeyViolations: connection.prepare('PRAGMA foreign_key_check').all().length,
      pageCount: Number(firstValue(connection.prepare('PRAGMA page_count').get()) ?? 0),
      freePages: Number(firstValue(connection.prepare('PRAGMA freelist_count').get()) ?? 0)
    };
  } finally {
    connection.close();
  }
}

/** @param {string} filename */
function schemaDiagnostics(filename) {
  const connection = new DatabaseSync(filename, { readOnly: true });
  try {
    return schemaDiagnosticsFromConnection(connection);
  } finally {
    connection.close();
  }
}

/** @param {DatabaseSync} connection */
function schemaDiagnosticsFromConnection(connection) {
  let version;
  let stores;
  let indexes;
  try {
    version = Number(firstValue(connection.prepare(`
      SELECT version FROM __idb_databases WHERE name = ?
    `).get(DATABASE_NAME)) ?? 0);
    stores = connection.prepare(`
      SELECT name, key_path FROM __idb_stores
      WHERE database_name = ? ORDER BY name
    `).all(DATABASE_NAME);
    indexes = connection.prepare(`
      SELECT store_name, name, key_path FROM __idb_indexes
      WHERE database_name = ? ORDER BY store_name, name
    `).all(DATABASE_NAME);
  } catch (error) {
    return {
      version: 0,
      stores: [],
      issues: [`IndexedDB metadata is unavailable: ${error instanceof Error ? error.message : String(error)}`]
    };
  }
  const issues = [];
  if (version !== DATABASE_VERSION) issues.push(`database version is ${version}; expected ${DATABASE_VERSION}`);
  const actualStores = stores.map((row) => String(row.name));
  for (const store of EXPECTED_STORES) {
    const row = stores.find((candidate) => candidate.name === store);
    if (!row) issues.push(`missing object store ${store}`);
    else if (String(row.key_path) !== JSON.stringify('id')) issues.push(`invalid key path for ${store}`);
  }
  for (const store of actualStores) {
    if (!EXPECTED_STORES.includes(store)) issues.push(`unexpected object store ${store}`);
  }
  for (const [store, expected] of Object.entries(EXPECTED_INDEXES)) {
    for (const [name, keyPath] of Object.entries(expected)) {
      const row = indexes.find((candidate) => candidate.store_name === store && candidate.name === name);
      if (!row) issues.push(`missing index ${store}.${name}`);
      else if (String(row.key_path) !== JSON.stringify(keyPath)) issues.push(`invalid key path for ${store}.${name}`);
    }
    for (const row of indexes.filter((candidate) => candidate.store_name === store)) {
      if (!(String(row.name) in expected)) issues.push(`unexpected index ${store}.${String(row.name)}`);
    }
  }
  return { version, stores: actualStores, issues };
}

/** @param {string} filename */
function scanRecords(filename) {
  const connection = new DatabaseSync(filename, { readOnly: true });
  try {
    return scanRecordsFromConnection(connection);
  } finally {
    connection.close();
  }
}

/** @param {DatabaseSync} connection */
function scanRecordsFromConnection(connection) {
  let rows;
  try {
    rows = connection.prepare(`
      SELECT store_name, record_key, value FROM __idb_records
      WHERE database_name = ? ORDER BY store_name, record_key
    `).all(DATABASE_NAME);
  } catch (error) {
    return {
      batch: emptyBatch(),
      transactions: /** @type {DoctorTransaction[]} */ ([]),
      invalid: /** @type {{ store: string, recordKey: string, reason: string }[]} */ ([]),
      error: `record storage is unavailable: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  const batch = emptyBatch();
  const transactions = /** @type {DoctorTransaction[]} */ ([]);
  const invalid = /** @type {{ store: string, recordKey: string, reason: string }[]} */ ([]);
  for (const row of rows) {
    const store = String(row.store_name);
    if (!EXPECTED_STORES.includes(store)) continue;
    let key;
    let value;
    let reason = '';
    try {
      key = JSON.parse(String(row.record_key));
    } catch {
      reason = 'invalid record key JSON';
    }
    try {
      value = JSON.parse(String(row.value));
    } catch {
      reason ||= 'invalid record JSON';
    }
    if (!reason && (!value || typeof value !== 'object' || Array.isArray(value))) {
      reason = 'record is not an object';
    }
    if (!reason && (typeof value.id !== 'string' || !value.id)) reason = 'record has no string id';
    if (!reason && key !== value.id) reason = 'record key does not match id';
    if (!reason && store === 'transactions'
      && (typeof value.kind !== 'string' || typeof value.createdAt !== 'string')) {
      reason = 'transaction metadata is invalid';
    }
    if (reason) {
      invalid.push({ store, recordKey: String(row.record_key), reason });
    } else if (store === 'transactions') {
      transactions.push(/** @type {DoctorTransaction} */ (value));
    } else {
      batch[/** @type {keyof import('../model/schema.js').CanonicalBatch} */ (store)].push(value);
    }
  }
  return { batch, transactions, invalid, error: null };
}

/** @param {import('../model/schema.js').CanonicalBatch} batch */
function counts(batch) {
  return Object.fromEntries(ENTITY_STORES.map((store) => [store, batch[store].length]));
}

/** @param {{ store: string, reason: string }[]} invalid */
function summarizeInvalid(invalid) {
  const summary = /** @type {Record<string, number>} */ ({});
  for (const row of invalid) {
    const key = `${row.store}: ${row.reason}`;
    summary[key] = (summary[key] ?? 0) + 1;
  }
  return summary;
}

/** @param {DoctorTransaction[]} transactions @param {number} horizon */
function retainedTransactions(transactions, horizon) {
  return transactions.filter((transaction) => {
    const timestamp = Date.parse(String(transaction.createdAt ?? ''));
    return Number.isFinite(timestamp) && timestamp >= horizon;
  });
}

/**
 * @param {import('../model/schema.js').CanonicalBatch} left
 * @param {import('../model/schema.js').CanonicalBatch} right
 */
function sameBatch(left, right) {
  return ENTITY_STORES.every((store) => JSON.stringify(
    [...left[store]].sort((a, b) => String(a.id).localeCompare(String(b.id)))
  ) === JSON.stringify(
    [...right[store]].sort((a, b) => String(a.id).localeCompare(String(b.id)))
  ));
}

/**
 * @param {DatabaseSync} connection
 * @param {string} filename
 * @param {string} checkedAt
 * @param {string} [suffix]
 */
async function createBackup(connection, filename, checkedAt, suffix = '') {
  const backupPath = `${filename}.doctor-backup-${checkedAt.replaceAll(/[^0-9]/g, '')}${suffix}.sqlite`;
  await backup(connection, backupPath);
  return backupPath;
}

/** @param {string} filename @param {string} checkedAt */
async function backupDatabase(filename, checkedAt) {
  const connection = new DatabaseSync(filename, { readOnly: true });
  try {
    return await createBackup(connection, filename, checkedAt);
  } finally {
    connection.close();
  }
}

/**
 * @param {DatabaseSync} connection
 * @param {import('../model/schema.js').CanonicalBatch} batch
 * @param {DoctorTransaction[]} transactions
 */
function writeCanonicalDatabase(connection, batch, transactions) {
  for (const table of ['__idb_records', '__idb_indexes', '__idb_stores']) {
    connection.prepare(`DELETE FROM ${table} WHERE database_name = ?`).run(DATABASE_NAME);
  }
  connection.prepare('DELETE FROM __idb_databases WHERE name = ?').run(DATABASE_NAME);
  connection.prepare('INSERT INTO __idb_databases (name, version) VALUES (?, ?)').run(
    DATABASE_NAME,
    DATABASE_VERSION
  );
  const insertStore = connection.prepare(`
    INSERT INTO __idb_stores (database_name, name, key_path) VALUES (?, ?, ?)
  `);
  const insertIndex = connection.prepare(`
    INSERT INTO __idb_indexes (database_name, store_name, name, key_path) VALUES (?, ?, ?, ?)
  `);
  for (const store of EXPECTED_STORES) {
    insertStore.run(DATABASE_NAME, store, JSON.stringify('id'));
    for (const [name, keyPath] of Object.entries(EXPECTED_INDEXES[store])) {
      insertIndex.run(DATABASE_NAME, store, name, JSON.stringify(keyPath));
    }
  }
  const insertRecord = connection.prepare(`
    INSERT INTO __idb_records (database_name, store_name, record_key, value) VALUES (?, ?, ?, ?)
  `);
  for (const store of ENTITY_STORES) {
    for (const record of batch[store]) {
      insertRecord.run(DATABASE_NAME, store, JSON.stringify(record.id), JSON.stringify(record));
    }
  }
  for (const transaction of transactions) {
    insertRecord.run(
      DATABASE_NAME,
      'transactions',
      JSON.stringify(transaction.id),
      JSON.stringify(transaction)
    );
  }
}

/**
 * @param {string} filename
 * @param {string} checkedAt
 * @param {number} now
 * @param {number} retentionWindowMs
 */
async function repairCanonicalDatabase(filename, checkedAt, now, retentionWindowMs) {
  const connection = new DatabaseSync(filename);
  let backupPath = null;
  let locked = false;
  try {
    connection.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const dataVersion = Number(firstValue(connection.prepare('PRAGMA data_version').get()));
      const candidateBackup = await createBackup(
        connection,
        filename,
        checkedAt,
        attempt === 1 ? '-repair' : `-repair-${attempt}`
      );
      connection.exec('BEGIN EXCLUSIVE;');
      locked = true;
      if (Number(firstValue(connection.prepare('PRAGMA data_version').get())) === dataVersion) {
        backupPath = candidateBackup;
        break;
      }
      connection.exec('ROLLBACK;');
      locked = false;
      await rm(candidateBackup, { force: true });
    }
    if (!locked) throw new Error('database changed while creating a repair backup');
    connection.exec(SQLITE_INDEXEDDB_METADATA_SCHEMA);
    const scanned = scanRecordsFromConnection(connection);
    const schema = schemaDiagnosticsFromConnection(connection);
    const horizon = now - retentionWindowMs;
    const repairedBatch = mergeRetainedRecords(scanned.batch, emptyBatch(), {
      now,
      retentionWindowMs
    });
    const transactions = retainedTransactions(scanned.transactions, horizon);
    writeCanonicalDatabase(connection, repairedBatch, transactions);
    connection.exec('COMMIT;');
    locked = false;
    return {
      backupPath,
      scanned,
      schema,
      repairedBatch,
      transactions,
      relationshipIssues: relationshipErrors(scanned.batch)
    };
  } catch (error) {
    if (locked) {
      try {
        connection.exec('ROLLBACK;');
      } catch {
        // The transaction may already have been rolled back by SQLite.
      }
    }
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { backupPath });
  } finally {
    connection.close();
  }
}

/**
 * @param {string} filename
 * @param {string[]} actions
 * @param {string[]} errors
 */
function maintainSqlite(filename, actions, errors) {
  let connection;
  try {
    connection = new DatabaseSync(filename);
  } catch (error) {
    errors.push(`open database for repair: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  try {
    for (const statement of ['REINDEX', 'PRAGMA optimize', 'VACUUM']) {
      try {
        connection.exec(`${statement};`);
        actions.push(statement.toLowerCase().replace('pragma ', ''));
      } catch (error) {
        errors.push(`${statement}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    connection.close();
  }
}

/**
 * Diagnoses and repairs the canonical SQLite-backed IndexedDB database.
 *
 * @param {string} filename
 * @param {{ now?: number, ttlDays?: number }} [options]
 */
export async function doctorSqliteDatabase(filename, options = {}) {
  const databasePath = path.resolve(filename);
  const databaseStat = await stat(databasePath);
  if (!databaseStat.isFile()) throw new Error(`SQLite database is not a file: ${databasePath}`);
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const ttlDays = Number.isFinite(options.ttlDays) ? Number(options.ttlDays) : RETENTION_WINDOW_DAYS;
  const retentionWindowMs = ttlDays * DAY_MS;
  if (ttlDays <= 0 || !Number.isFinite(retentionWindowMs)) {
    throw new TypeError('TTL days must produce a finite window greater than zero');
  }
  const checkedAt = new Date(now).toISOString();
  const actions = /** @type {string[]} */ ([]);
  const errors = /** @type {string[]} */ ([]);
  let backupPath = null;
  let beforeSqlite;

  try {
    beforeSqlite = sqliteDiagnostics(databasePath);
  } catch (error) {
    errors.push(`initial diagnostics: ${error instanceof Error ? error.message : String(error)}`);
    try {
      backupPath = await backupDatabase(databasePath, checkedAt);
    } catch (backupError) {
      errors.push(`backup: ${backupError instanceof Error ? backupError.message : String(backupError)}`);
      return {
        command: 'doctor',
        database: databasePath,
        checkedAt,
        ttlDays,
        healthy: false,
        error: 'Database repair requires a successful backup',
        repairs: { actions, errors, backup: backupPath }
      };
    }
    maintainSqlite(databasePath, actions, errors);
    try {
      beforeSqlite = sqliteDiagnostics(databasePath);
    } catch (afterError) {
      return {
        command: 'doctor',
        database: databasePath,
        checkedAt,
        ttlDays,
        healthy: false,
        error: afterError instanceof Error ? afterError.message : String(afterError),
        repairs: { actions, errors, backup: backupPath }
      };
    }
  }

  if (beforeSqlite.integrity.some((result) => result !== 'ok')) {
    try {
      backupPath = await backupDatabase(databasePath, checkedAt);
    } catch (error) {
      errors.push(`backup: ${error instanceof Error ? error.message : String(error)}`);
      return {
        command: 'doctor',
        database: databasePath,
        checkedAt,
        ttlDays,
        healthy: false,
        before: { sqlite: beforeSqlite },
        error: 'Database repair requires a successful backup',
        repairs: { actions, errors, backup: backupPath }
      };
    }
    maintainSqlite(databasePath, actions, errors);
    const afterSqlite = sqliteDiagnostics(databasePath);
    if (afterSqlite.integrity.some((result) => result !== 'ok')) {
      return {
        command: 'doctor',
        database: databasePath,
        checkedAt,
        ttlDays,
        healthy: false,
        before: { sqlite: beforeSqlite },
        after: { sqlite: afterSqlite },
        repairs: { actions, errors, backup: backupPath }
      };
    }
  }

  const beforeSchema = schemaDiagnostics(databasePath);
  const scanned = scanRecords(databasePath);
  const relationshipIssues = relationshipErrors(scanned.batch);
  const horizon = now - retentionWindowMs;
  const repairedBatch = mergeRetainedRecords(scanned.batch, emptyBatch(), {
    now,
    retentionWindowMs
  });
  const transactions = retainedTransactions(scanned.transactions, horizon);
  const transactionRowsRemoved = scanned.transactions.length - transactions.length;
  const canonicalRowsRemoved = ENTITY_STORES.reduce(
    (total, store) => total + scanned.batch[store].length - repairedBatch[store].length,
    0
  );
  const canonicalDataChanged = !sameBatch(scanned.batch, repairedBatch);
  const needsRepair = beforeSchema.issues.length > 0
    || beforeSqlite.foreignKeyViolations > 0
    || Boolean(scanned.error)
    || scanned.invalid.length > 0
    || relationshipIssues.length > 0
    || canonicalDataChanged
    || transactionRowsRemoved > 0;
  let invalidRecordsRemoved = scanned.invalid.length;
  let repairedCanonicalRows = canonicalRowsRemoved;
  let repairedTransactionRows = transactionRowsRemoved;

  if (needsRepair) {
    let repair;
    try {
      repair = await repairCanonicalDatabase(databasePath, checkedAt, now, retentionWindowMs);
      backupPath = repair.backupPath;
    } catch (error) {
      backupPath = error && typeof error === 'object' && 'backupPath' in error
        ? /** @type {{ backupPath: string | null }} */ (error).backupPath
        : null;
      errors.push(`repair: ${error instanceof Error ? error.message : String(error)}`);
      return {
        command: 'doctor',
        database: databasePath,
        checkedAt,
        ttlDays,
        healthy: false,
        before: {
          sizeBytes: databaseStat.size,
          sqlite: beforeSqlite,
          schema: beforeSchema,
          counts: counts(scanned.batch),
          transactions: scanned.transactions.length,
          invalidRecords: summarizeInvalid(scanned.invalid),
          relationshipErrors: relationshipIssues,
          recordError: scanned.error
        },
        error: backupPath
          ? 'Database repair failed and was rolled back'
          : 'Database repair requires a successful backup',
        repairs: { actions, errors, backup: backupPath }
      };
    }
    const lockedBatch = repair.scanned.batch;
    invalidRecordsRemoved = repair.scanned.invalid.length;
    repairedCanonicalRows = ENTITY_STORES.reduce(
      (total, store) => total + lockedBatch[store].length - repair.repairedBatch[store].length,
      0
    );
    repairedTransactionRows = repair.scanned.transactions.length - repair.transactions.length;
    if (repair.schema.issues.length > 0 || beforeSqlite.foreignKeyViolations > 0) {
      actions.push('rebuild-schema');
    }
    if (scanned.error) actions.push('rebuild-storage');
    if (invalidRecordsRemoved > 0) actions.push('remove-invalid-records');
    if (repairedCanonicalRows > 0) actions.push('prune-expired-or-orphaned-records');
    else if (!sameBatch(lockedBatch, repair.repairedBatch)) actions.push('normalize-canonical-records');
    if (repairedTransactionRows > 0) actions.push('prune-expired-transactions');
    maintainSqlite(databasePath, actions, errors);
  }

  const afterSqlite = sqliteDiagnostics(databasePath);
  const afterSchema = schemaDiagnostics(databasePath);
  const afterScan = scanRecords(databasePath);
  const afterRelationshipIssues = relationshipErrors(afterScan.batch);
  const healthy = afterSqlite.integrity.every((result) => result === 'ok')
    && afterSqlite.foreignKeyViolations === 0
    && afterSchema.issues.length === 0
    && afterScan.invalid.length === 0
    && afterRelationshipIssues.length === 0
    && !afterScan.error
    && errors.length === 0;

  return {
    command: 'doctor',
    database: databasePath,
    checkedAt,
    ttlDays,
    healthy,
    before: {
      sizeBytes: databaseStat.size,
      sqlite: beforeSqlite,
      schema: beforeSchema,
      counts: counts(scanned.batch),
      transactions: scanned.transactions.length,
      invalidRecords: summarizeInvalid(scanned.invalid),
      relationshipErrors: relationshipIssues,
      recordError: scanned.error
    },
    after: {
      sizeBytes: (await stat(databasePath)).size,
      sqlite: afterSqlite,
      schema: afterSchema,
      counts: counts(afterScan.batch),
      transactions: afterScan.transactions.length,
      invalidRecords: summarizeInvalid(afterScan.invalid),
      relationshipErrors: afterRelationshipIssues,
      recordError: afterScan.error
    },
    repairs: {
      actions,
      errors,
      backup: backupPath,
      invalidRecordsRemoved,
      canonicalRecordsRemoved: repairedCanonicalRows,
      transactionsRemoved: repairedTransactionRows
    }
  };
}
