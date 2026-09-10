import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  canonical.repositories.push({ id: 'repository:1' });
  canonical.workflows.push({ id: 'workflow:1', repositoryId: 'repository:1' });
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
    const script = resolve('scripts/ingest-gh-aw-logs.mjs');
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
  });
});
