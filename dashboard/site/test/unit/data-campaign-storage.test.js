import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { normalize } from '../../src/data/normalize/index.js';
import { queryDatabaseSources } from '../../src/data/queries/database.js';
import {
  DATABASE_NAME, DATABASE_VERSION, deleteCanonicalDatabase, maintainCanonicalDatabase,
  openCanonicalDatabase, prepareCanonicalRecord, readCollection, readIndex, replaceCanonicalBatch, upsertCanonicalBatch
} from '../../src/data/storage/indexeddb.js';
import { createSqliteIndexedDB } from '../../src/data/storage/sqlite-indexeddb.js';
import { doctorSqliteDatabase } from '../../src/data/storage/sqlite-doctor.js';

const directories = /** @type {string[]} */ ([]);
const originalKeyRange = globalThis.IDBKeyRange;

function sqliteFilename() {
  const directory = mkdtempSync(join(tmpdir(), 'cao-campaign-storage-'));
  directories.push(directory);
  return join(directory, 'dashboard.sqlite');
}

function campaignBatch(version = 'v1') {
  return normalize([{
    kind: 'campaign', source: 'dashboard-sources', sourceId: 'dependabot',
    observedAt: '2026-10-02T00:00:00Z',
    data: {
      slug: 'dependabot', name: 'Dependabot', description: 'Dependency maintenance',
      mode: 'review', enabled: false, version, currentVersion: 'v2',
      updateState: version === 'v2' ? 'current' : 'update-available',
      workerCount: 0, rolloutPercent: 12.5, monthlyAiCreditBudget: 10.5,
      campaignLink: { relation: 'internal', href: '#campaign/dependabot', label: 'Dependabot' },
      intelligenceDeclaration: { campaign: 'dependabot' }
    }
  }]);
}

/** @param {DatabaseSync} connection */
function mirrorRows(connection) {
  return connection.prepare('SELECT * FROM campaigns ORDER BY database_name, id').all();
}

afterEach(() => {
  globalThis.IDBKeyRange = originalKeyRange;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe.each(['IndexedDB', 'SQLite'])('Campaign storage in %s', (backend) => {
  it('persists idle campaigns, refreshes stable identity, queries by slug, and deletes them', async () => {
    globalThis.IDBKeyRange = IDBKeyRange;
    const filename = backend === 'SQLite' ? sqliteFilename() : null;
    const factory = filename ? createSqliteIndexedDB(filename) : new IDBFactory();
    const database = await openCanonicalDatabase(factory);
    const store = database.transaction('campaigns').objectStore('campaigns');
    expect(store.keyPath).toBe('id');
    expect(store.index('bySlug').keyPath).toBe('slug');
    database.close();

    await upsertCanonicalBatch(factory, campaignBatch());
    await upsertCanonicalBatch(factory, campaignBatch('v2'));
    const reopened = filename ? createSqliteIndexedDB(filename) : factory;
    const records = await readCollection(reopened, 'campaigns');
    expect(records).toEqual(campaignBatch('v2').campaigns);
    expect(await readIndex(reopened, 'campaigns', 'bySlug', ['dependabot'])).toEqual(records);
    const sources = await queryDatabaseSources(reopened, {}, ['campaigns']);
    expect(sources.campaigns.rows).toEqual([expect.objectContaining({
      id: records[0].id, campaign: 'dependabot', 'campaign-version': 'v2',
      'campaign-enabled': false, 'campaign-worker-count': 0
    })]);
    await maintainCanonicalDatabase(reopened, {
      now: Date.parse('2027-01-01T00:00:00Z'), retentionWindowMs: 1, maxDatabaseBytes: 0
    });
    expect(await readCollection(reopened, 'campaigns')).toEqual(records);
    if (filename) {
      const connection = new DatabaseSync(filename);
      try {
        expect(mirrorRows(connection)).toEqual([expect.objectContaining({
          database_name: DATABASE_NAME, id: records[0].id, slug: 'dependabot',
          mode: 'review', enabled: 0, version: 'v2', update_state: 'current',
          worker_count: 0, rollout_percent: 12.5, monthly_ai_credit_budget: 10.5,
          observed_at: records[0].observedAt,
          campaign_link: JSON.stringify(records[0].campaignLink),
          intelligence_declaration: JSON.stringify(records[0].intelligenceDeclaration),
          provenance: JSON.stringify(records[0].provenance)
        })]);
        expect(mirrorRows(connection)[0]).not.toHaveProperty('record_json');
        expect(connection.prepare(`
          SELECT value FROM __idb_records
          WHERE database_name = ? AND store_name = 'campaigns' AND record_key = ?
        `).get(DATABASE_NAME, JSON.stringify(records[0].id))?.value)
          .toBe(JSON.stringify(prepareCanonicalRecord('campaigns', records[0])));
        expect(connection.prepare('PRAGMA index_info(campaigns_slug)').all().map((row) => row.name))
          .toEqual(['database_name', 'slug']);
      } finally {
        connection.close();
      }
    }

    await replaceCanonicalBatch(reopened, normalize([]));
    expect(await readCollection(reopened, 'campaigns')).toEqual([]);
    if (filename) {
      const connection = new DatabaseSync(filename);
      try {
        expect(mirrorRows(connection)).toEqual([]);
      } finally {
        connection.close();
      }
    }
    await upsertCanonicalBatch(reopened, campaignBatch());
    await deleteCanonicalDatabase(reopened);
    if (filename) {
      const connection = new DatabaseSync(filename);
      try {
        expect(mirrorRows(connection)).toEqual([]);
      } finally {
        connection.close();
      }
    }
  });
});

describe('SQLite Campaign mirror', () => {
  it('populates an existing canonical database without changing its records or version', async () => {
    const filename = sqliteFilename();
    const factory = createSqliteIndexedDB(filename);
    await upsertCanonicalBatch(factory, campaignBatch());
    const oldDatabase = new DatabaseSync(filename);
    oldDatabase.exec(`
      DROP TRIGGER campaigns_insert;
      DROP TRIGGER campaigns_update;
      DROP TRIGGER campaigns_delete;
      DROP TABLE campaigns;
    `);
    oldDatabase.close();

    const reopened = createSqliteIndexedDB(filename);
    const database = await openCanonicalDatabase(reopened);
    expect(database.version).toBe(DATABASE_VERSION);
    database.close();
    const connection = new DatabaseSync(filename);
    try {
      expect(mirrorRows(connection)).toEqual([expect.objectContaining({
        id: campaignBatch().campaigns[0].id, slug: 'dependabot', version: 'v1'
      })]);
    } finally {
      connection.close();
    }
    expect(await readCollection(reopened, 'campaigns')).toEqual(campaignBatch().campaigns);
  });

  it('repairs a database missing its Campaign table through the SQLite doctor', async () => {
    const filename = sqliteFilename();
    const factory = createSqliteIndexedDB(filename);
    await upsertCanonicalBatch(factory, campaignBatch());
    const connection = new DatabaseSync(filename);
    connection.exec(`
      DROP TRIGGER campaigns_insert;
      DROP TRIGGER campaigns_update;
      DROP TRIGGER campaigns_delete;
      DROP TABLE campaigns;
    `);
    connection.close();

    const diagnosis = await doctorSqliteDatabase(filename, { now: Date.parse('2026-10-02T00:00:00Z') });
    expect(diagnosis.healthy).toBe(true);
    expect(diagnosis.repairs?.actions).toContain('rebuild-schema');
    const repaired = new DatabaseSync(filename);
    try {
      expect(mirrorRows(repaired)).toEqual([expect.objectContaining({
        id: campaignBatch().campaigns[0].id, slug: 'dependabot', version: 'v1'
      })]);
    } finally {
      repaired.close();
    }
  });

  it('rolls back failed writes and scopes store and database deletion', async () => {
    const filename = sqliteFilename();
    const factory = createSqliteIndexedDB(filename);
    await upsertCanonicalBatch(factory, campaignBatch());
    const request = factory.open('other-dashboard', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('campaigns', { keyPath: 'id' });
    const other = await /** @type {Promise<IDBDatabase>} */ (new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }));
    const write = other.transaction('campaigns', 'readwrite');
    write.objectStore('campaigns').put(campaignBatch().campaigns[0]);
    await new Promise((resolve, reject) => {
      write.oncomplete = resolve;
      write.onabort = () => reject(write.error);
    });
    other.close();

    const database = await openCanonicalDatabase(factory);
    const transaction = database.transaction('campaigns', 'readwrite');
    transaction.objectStore('campaigns').put(campaignBatch('v2').campaigns[0]);
    transaction.objectStore('campaigns').put({ slug: 'missing-id' });
    await new Promise((resolve) => { transaction.onabort = resolve; });
    database.close();
    expect(await readCollection(factory, 'campaigns')).toEqual(campaignBatch().campaigns);
    const connection = new DatabaseSync(filename);
    try {
      expect(mirrorRows(connection).map((row) => row.version)).toEqual(['v1', 'v1']);
    } finally {
      connection.close();
    }

    const upgrade = factory.open(DATABASE_NAME, DATABASE_VERSION + 1);
    upgrade.onupgradeneeded = () => upgrade.result.deleteObjectStore('campaigns');
    const upgraded = await /** @type {Promise<IDBDatabase>} */ (new Promise((resolve, reject) => {
      upgrade.onsuccess = () => resolve(upgrade.result);
      upgrade.onerror = () => reject(upgrade.error);
    }));
    upgraded.close();
    await deleteCanonicalDatabase(factory);
    const after = new DatabaseSync(filename);
    try {
      expect(mirrorRows(after)).toEqual([expect.objectContaining({ database_name: 'other-dashboard' })]);
    } finally {
      after.close();
    }
  });
});
