import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { URL as NodeURL, pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { normalize } from '../../src/data/normalize/index.js';
import {
  DATABASE_NAME, openCanonicalDatabase, readCollection, upsertCanonicalBatch,
} from '../../src/data/storage/indexeddb.js';
import { installSqliteIndexedDB } from '../../src/data/storage/sqlite-indexeddb.js';

const directories = /** @type {string[]} */ ([]);
const originalIndexedDB = globalThis.indexedDB;
const originalKeyRange = globalThis.IDBKeyRange;
afterEach(() => {
  globalThis.indexedDB = originalIndexedDB;
  globalThis.IDBKeyRange = originalKeyRange;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function overlayFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'cao-overlay-'));
  directories.push(directory);
  const snapshot = join(directory, 'snapshot.sqlite');
  const local = join(directory, 'local.sqlite');
  const base = installSqliteIndexedDB(snapshot);
  const batch = normalize([]);
  batch.repositories.push({ id: 'repo:1', owner: 'octo', name: 'one' });
  batch.workflows.push({ id: 'workflow:1', repositoryId: 'repo:1', campaignId: 'campaign:1' });
  batch.runs.push({ id: 'run:1', repositoryId: 'repo:1', workflowId: 'workflow:1', attempt: 1, conclusion: 'success' });
  batch.tools.push({ id: 'tool:1', runId: 'run:1', name: 'old' });
  await upsertCanonicalBatch(base, batch, { validateRelationships: false });
  const connection = new DatabaseSync(local);
  const uri = pathToFileURL(snapshot);
  uri.searchParams.set('mode', 'ro');
  connection.prepare('ATTACH DATABASE ? AS snapshot').run(uri.href);
  connection.exec(readFileSync(new NodeURL('../../../../internal/dashboardquery/overlay.sql', import.meta.url), 'utf8'));
  connection.prepare('INSERT INTO __cao_overlay_metadata (id,snapshot_revision) VALUES(1,?)').run('fixture');
  connection.close();
  return { snapshot, local, indexedDB: installSqliteIndexedDB(local, { snapshotPath: snapshot, snapshotRevision: 'fixture' }) };
}

it('reads attached history without copying it and keeps local upserts across reopen', async () => {
  const { indexedDB, local, snapshot } = await overlayFixture();
  const before = readFileSync(snapshot);
  expect(await readCollection(indexedDB, 'runs')).toHaveLength(1);
  const physical = new DatabaseSync(local);
  expect(physical.prepare('SELECT count(*) AS n FROM __idb_records').get()?.n).toBe(0);
  physical.close();
  const batch = normalize([]);
  batch.runs.push({ id: 'run:2', repositoryId: 'repo:1', workflowId: 'workflow:1', attempt: 1 });
  await upsertCanonicalBatch(indexedDB, batch, { validateRelationships: false });
  const reopened = installSqliteIndexedDB(local, { snapshotPath: snapshot, snapshotRevision: 'fixture' });
  expect((await readCollection(reopened, 'runs')).map((run) => run.id)).toEqual(['run:1', 'run:2']);
  expect(readFileSync(snapshot)).toEqual(before);
});

it('keeps deletions and clears in the delta, rolls them back atomically, and allows reinsertion', async () => {
  const { indexedDB, local, snapshot } = await overlayFixture();
  const before = readFileSync(snapshot);
  const database = await openCanonicalDatabase(indexedDB);
  const transaction = database.transaction('runs', 'readwrite');
  transaction.objectStore('runs').delete('run:1');
  transaction.abort();
  await new Promise((resolve) => { transaction.onabort = resolve; });
  database.close();
  expect(await readCollection(indexedDB, 'runs')).toHaveLength(1);
  const db = await openCanonicalDatabase(indexedDB);
  const deletion = db.transaction('tools', 'readwrite');
  deletion.objectStore('tools').clear();
  await new Promise((resolve, reject) => { deletion.oncomplete = resolve; deletion.onerror = reject; });
  db.close();
  const reopened = installSqliteIndexedDB(local, { snapshotPath: snapshot, snapshotRevision: 'fixture' });
  expect(await readCollection(reopened, 'tools')).toEqual([]);
  const batch = normalize([]);
  batch.tools.push({ id: 'tool:1', runId: 'run:1', name: 'new' });
  await upsertCanonicalBatch(reopened, batch, { validateRelationships: false });
  expect(await readCollection(reopened, 'tools')).toMatchObject([{ id: 'tool:1', name: 'new' }]);
  expect(readFileSync(snapshot)).toEqual(before);
});

it('rejects schema migrations and mismatched snapshot identities', async () => {
  const { local, snapshot } = await overlayFixture();
  const wrong = installSqliteIndexedDB(local, { snapshotPath: snapshot, snapshotRevision: 'wrong' });
  await expect(openCanonicalDatabase(wrong)).rejects.toThrow('does not match');
  const indexedDB = installSqliteIndexedDB(local, { snapshotPath: snapshot, snapshotRevision: 'fixture' });
  const request = indexedDB.open(DATABASE_NAME, 10000);
  await expect(new Promise((resolve, reject) => {
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  })).rejects.toThrow('cannot migrate');
});
