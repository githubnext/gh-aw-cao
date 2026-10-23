import { webcrypto } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginStoredMetricLedger, beginStoredMetricScope, completeStoredMetricScope,
  METRIC_STAGING_DATABASE, MetricLedgerConflictError, readStoredMetricLedger,
  readStoredMetricScope, stageStoredMetricShard
} from '../../src/data/storage/metric-staging.js';
import { completeCompactMetricScope, createCompactMetricLedger } from '../../src/data/storage/daily-metrics.js';
import { createSqliteIndexedDB } from '../../src/data/storage/sqlite-indexeddb.js';

const watermark = Date.parse('2026-10-21T12:00:00Z');
const declaration = { id: 'scope', namespace: 'test', watermark, expectedShards: ['a', 'b'] };
const identity = { namespace: 'test', scopeId: 'scope' };
const run = {
  id: 'one', repositoryId: 'repo', workflowId: 'workflow',
  startedAt: '2026-10-20T00:00:00Z', observedAt: '2026-10-21T00:00:00Z', aicTotal: 0.1
};
const directories = /** @type {string[]} */ ([]);
beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

describe.each(['indexeddb', 'sqlite'])('%s durable metric staging', (backend) => {
  function factoryPair() {
    if (backend === 'indexeddb') {
      const factory = new IDBFactory();
      return { factory, reopen: () => factory };
    }
    const directory = mkdtempSync(join(tmpdir(), 'cao-metric-staging-'));
    directories.push(directory);
    const filename = join(directory, 'metrics.sqlite');
    return { factory: createSqliteIndexedDB(filename), reopen: () => createSqliteIndexedDB(filename) };
  }

  /** @param {IDBFactory} factory @param {string} id @param {Record<string, unknown>[]} runs */
  async function stageComplete(factory, id, runs) {
    await beginStoredMetricScope(factory, { ...declaration, id, expectedShards: ['a'] });
    await stageStoredMetricShard(factory, { ...identity, scopeId: id, shardId: 'a', runs });
  }

  it('atomically persists compact ledger rows and a checkpoint before removing staged observations', async () => {
    const { factory, reopen } = factoryPair();
    await beginStoredMetricLedger(factory, { namespace: 'test', watermark });
    await stageComplete(factory, 'first', [{ ...run, title: 'raw-detail-not-retained' }]);
    const receipt = await completeStoredMetricScope(factory, { ...identity, scopeId: 'first' });
    expect(receipt).toEqual({ ...identity, scopeId: 'first', revision: 1, watermark });
    const saved = await readStoredMetricLedger(reopen(), 'test');
    expect(saved.revision).toBe(1);
    expect(saved.ledger.checkpoint).toEqual({ scopeId: 'first', watermark, shards: ['a'] });
    expect(Object.values(saved.ledger.dailyMetrics)[0].measures.aicTotal.sum).toBe(0.1);
    expect(JSON.stringify(saved)).not.toContain('raw-detail-not-retained');
    expect(await completeStoredMetricScope(reopen(), { ...identity, scopeId: 'first' })).toEqual(receipt);
    expect(await readStoredMetricLedger(reopen(), 'test')).toEqual(saved);
    await expect(readStoredMetricScope(reopen(), { ...identity, scopeId: 'first' })).rejects.toThrow(/already committed/);
    await expect(stageStoredMetricShard(reopen(), { ...identity, scopeId: 'first', shardId: 'a', runs: [] }))
      .rejects.toThrow(/already committed/);
    const database = await new Promise((resolve, reject) => {
      const request = factory.open(METRIC_STAGING_DATABASE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const shards = await new Promise((resolve, reject) => {
      const transaction = database.transaction('shards', 'readonly');
      const request = transaction.objectStore('shards').getAll();
      /** @type {Record<string, unknown>[]} */
      let rows = [];
      request.onsuccess = () => { rows = request.result; };
      transaction.oncomplete = () => resolve(rows);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
    expect(shards).toEqual([]);
  });

  it('persists corrections across namespaces and keeps ledger bootstrap authority immutable', async () => {
    const { factory } = factoryPair();
    await beginStoredMetricLedger(factory, { namespace: 'test', watermark, sourcePrecedence: { official: 2 } });
    await beginStoredMetricLedger(factory, { namespace: 'other', watermark });
    await stageComplete(factory, 'first', [run]);
    await completeStoredMetricScope(factory, { ...identity, scopeId: 'first' });
    await stageComplete(factory, 'second', [{
      ...run, repositoryId: 'other-repo', observedAt: '2026-10-21T01:00:00Z', aicTotal: 0.3
    }]);
    await completeStoredMetricScope(factory, { ...identity, scopeId: 'second' });
    const saved = await readStoredMetricLedger(factory, 'test');
    expect(saved.revision).toBe(2);
    expect(Object.values(saved.ledger.dailyMetrics)).toHaveLength(1);
    expect(Object.values(saved.ledger.dailyMetrics)[0]).toMatchObject({ repositoryId: 'other-repo' });
    expect((await readStoredMetricLedger(factory, 'other')).ledger.dailyMetrics).toEqual({});
    await beginStoredMetricLedger(factory, { namespace: 'test', watermark, sourcePrecedence: { official: 2 } });
    expect(await readStoredMetricLedger(factory, 'test')).toEqual(saved);
    await expect(beginStoredMetricLedger(factory, { namespace: 'test', watermark, sourcePrecedence: { official: 1 } }))
      .rejects.toThrow(/changed authority/);
  });

  it('pins the deployment path and scope identity across asynchronous completion', async () => {
    const { factory } = factoryPair();
    for (const pathname of ['/one/', '/two/']) {
      const storage = { pathname };
      await beginStoredMetricLedger(factory, { namespace: 'test', watermark }, storage);
      await beginStoredMetricScope(factory, { ...declaration, expectedShards: ['a'] }, storage);
      await stageStoredMetricShard(factory, { ...identity, shardId: 'a', runs: [run] }, storage);
    }
    const storage = { pathname: '/one/' };
    const options = { ...identity };
    const pending = completeStoredMetricScope(factory, options, storage);
    options.scopeId = 'mutated';
    options.namespace = 'mutated';
    storage.pathname = '/two/';
    expect((await pending).revision).toBe(1);
    expect((await readStoredMetricLedger(factory, 'test', { pathname: '/one/' })).revision).toBe(1);
    expect((await readStoredMetricLedger(factory, 'test', { pathname: '/two/' })).revision).toBe(0);
  });

  it('retains complete staging and the prior checkpoint when replay or reduction fails', async () => {
    const { factory } = factoryPair();
    await beginStoredMetricLedger(factory, { namespace: 'test', watermark });
    await stageComplete(factory, 'first', [run]);
    await completeStoredMetricScope(factory, { ...identity, scopeId: 'first' });
    const before = await readStoredMetricLedger(factory, 'test');
    await stageComplete(factory, 'tie', [{ ...run, conclusion: 'failure' }]);
    await expect(completeStoredMetricScope(factory, { ...identity, scopeId: 'tie' })).rejects.toThrow(/authoritative replay/);
    expect((await readStoredMetricScope(factory, { ...identity, scopeId: 'tie' })).shards['["a"]']).toHaveLength(1);
    expect(await readStoredMetricLedger(factory, 'test')).toEqual(before);
    await stageComplete(factory, 'replay', [run, { ...run, conclusion: 'failure' }]);
    expect((await completeStoredMetricScope(factory, { ...identity, scopeId: 'replay' })).revision).toBe(2);
  });

  it('persists retention deletions while preserving old completion receipts', async () => {
    const { factory } = factoryPair();
    await beginStoredMetricLedger(factory, { namespace: 'test', watermark });
    await stageComplete(factory, 'first', [run]);
    const first = await completeStoredMetricScope(factory, { ...identity, scopeId: 'first' });
    for (const [id, date] of [['retire', '2026-11-16T00:00:00Z'], ['expire', '2026-12-14T00:00:00Z']]) {
      await beginStoredMetricScope(factory, {
        ...declaration, id, watermark: Date.parse(date), expectedShards: ['a']
      });
      await stageStoredMetricShard(factory, { ...identity, scopeId: id, shardId: 'a', runs: [] });
      await completeStoredMetricScope(factory, { ...identity, scopeId: id });
    }
    const saved = await readStoredMetricLedger(factory, 'test');
    expect(saved.revision).toBe(3);
    expect(saved.ledger.dailyMetrics).toEqual({});
    expect(saved.ledger.contributions).toEqual({});
    expect(await completeStoredMetricScope(factory, { ...identity, scopeId: 'first' })).toEqual(first);
    expect(await readStoredMetricLedger(factory, 'test')).toEqual(saved);
  });

  it('fails closed when retained metric rows are missing instead of publishing a partial ledger', async () => {
    const { factory } = factoryPair();
    await beginStoredMetricLedger(factory, { namespace: 'test', watermark });
    await stageComplete(factory, 'first', [run]);
    await completeStoredMetricScope(factory, { ...identity, scopeId: 'first' });
    const database = await new Promise((resolve, reject) => {
      const request = factory.open(METRIC_STAGING_DATABASE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('metrics', 'readwrite');
      transaction.objectStore('metrics').clear();
      transaction.oncomplete = () => resolve(undefined);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
    await expect(readStoredMetricLedger(factory, 'test')).rejects.toThrow(/row counts are inconsistent/);
  });

  it('returns one receipt for concurrent completion of the same scope', async () => {
    const { factory } = factoryPair();
    await beginStoredMetricLedger(factory, { namespace: 'test', watermark });
    await stageComplete(factory, 'first', [run]);
    let signalStarted = () => {};
    let releaseHash = () => {};
    const started = new Promise((resolve) => { signalStarted = () => resolve(undefined); });
    const release = new Promise((resolve) => { releaseHash = () => resolve(undefined); });
    const digest = webcrypto.subtle.digest.bind(webcrypto.subtle);
    vi.spyOn(webcrypto.subtle, 'digest').mockImplementationOnce(async (...args) => {
      signalStarted();
      await release;
      return digest(...args);
    });
    const pending = completeStoredMetricScope(factory, { ...identity, scopeId: 'first' });
    await started;
    const receipt = await completeStoredMetricScope(factory, { ...identity, scopeId: 'first' });
    releaseHash();
    expect(await pending).toEqual(receipt);
    expect((await readStoredMetricLedger(factory, 'test')).revision).toBe(1);
  });

  it('rolls back changed metric rows, checkpoint and staging deletion together on commit failure', async () => {
    const { factory } = factoryPair();
    await beginStoredMetricLedger(factory, { namespace: 'test', watermark });
    await stageComplete(factory, 'first', [run]);
    const database = await new Promise((resolve, reject) => {
      const request = factory.open(METRIC_STAGING_DATABASE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const prototype = Object.getPrototypeOf(database);
    database.close();
    const transact = prototype.transaction;
    vi.spyOn(prototype, 'transaction').mockImplementation(function (...parameters) {
      const transaction = transact.apply(this, parameters);
      const objectStore = transaction.objectStore.bind(transaction);
      vi.spyOn(transaction, 'objectStore').mockImplementation((name) => {
        const store = objectStore(name);
        if (name === 'ledgers') vi.spyOn(store, 'put').mockImplementation(() => {
          throw new Error('injected checkpoint failure');
        });
        return store;
      });
      return transaction;
    });
    await expect(completeStoredMetricScope(factory, { ...identity, scopeId: 'first' })).rejects.toThrow(/checkpoint failure/);
    vi.restoreAllMocks();
    const saved = await readStoredMetricLedger(factory, 'test');
    expect(saved).toMatchObject({ revision: 0, ledger: { contributions: {}, dailyMetrics: {}, checkpoint: null } });
    expect((await readStoredMetricScope(factory, { ...identity, scopeId: 'first' })).shards['["a"]']).toEqual([run]);
    expect((await completeStoredMetricScope(factory, { ...identity, scopeId: 'first' })).revision).toBe(1);
  });

  it('rejects a stale async reduction without overwriting another scope and succeeds on explicit retry', async () => {
    const { factory } = factoryPair();
    await beginStoredMetricLedger(factory, { namespace: 'test', watermark });
    await stageComplete(factory, 'first', [run]);
    await stageComplete(factory, 'second', [{ ...run, id: 'two' }]);
    let signalStarted = () => {};
    let releaseHash = () => {};
    const started = new Promise((resolve) => { signalStarted = () => resolve(undefined); });
    const release = new Promise((resolve) => { releaseHash = () => resolve(undefined); });
    const digest = webcrypto.subtle.digest.bind(webcrypto.subtle);
    vi.spyOn(webcrypto.subtle, 'digest').mockImplementationOnce(async (...args) => {
      signalStarted();
      await release;
      return digest(...args);
    });
    const pending = completeStoredMetricScope(factory, { ...identity, scopeId: 'first' });
    const failure = expect(pending).rejects.toBeInstanceOf(MetricLedgerConflictError);
    await started;
    expect((await completeStoredMetricScope(factory, { ...identity, scopeId: 'second' })).revision).toBe(1);
    releaseHash();
    await failure;
    expect((await readStoredMetricScope(factory, { ...identity, scopeId: 'first' })).shards['["a"]']).toHaveLength(1);
    expect((await completeStoredMetricScope(factory, { ...identity, scopeId: 'first' })).revision).toBe(2);
    expect(Object.values((await readStoredMetricLedger(factory, 'test')).ledger.dailyMetrics)[0].measures.runs).toBe(2);
  });

  it('recovers a complete immutable scope across reopened connections and feeds the compact reducer', async () => {
    const { factory, reopen } = factoryPair();
    await beginStoredMetricScope(factory, declaration);
    await stageStoredMetricShard(factory, { ...identity, shardId: 'a', runs: [run] });
    await expect(readStoredMetricScope(reopen(), identity)).rejects.toThrow(/incomplete/);
    const receipt = await stageStoredMetricShard(reopen(), { ...identity, shardId: 'b', runs: [] });
    expect(receipt).toMatchObject({ receivedShards: 2, observations: 1 });
    const restored = await readStoredMetricScope(reopen(), identity);
    expect(restored.shards).toEqual({ '["a"]': [run], '["b"]': [] });
    const ledger = await completeCompactMetricScope(createCompactMetricLedger('test', watermark), restored);
    expect(Object.values(ledger.dailyMetrics)[0].measures.aicTotal.sum).toBe(0.1);
    expect(await readStoredMetricScope(reopen(), identity)).toEqual(restored);
  });

  it('accepts declaration and reordered JSON retries but rejects changed identities without losing evidence', async () => {
    const { factory } = factoryPair();
    await beginStoredMetricScope(factory, declaration);
    await beginStoredMetricScope(factory, { ...declaration, expectedShards: ['b', 'a'] });
    const first = await stageStoredMetricShard(factory, { ...identity, shardId: 'a', runs: [run, { ...run, id: 'two' }] });
    const retry = await stageStoredMetricShard(factory, {
      ...identity, shardId: 'a', runs: [
        { ...Object.fromEntries(Object.entries(run).reverse()), id: 'two' },
        Object.fromEntries(Object.entries(run).reverse())
      ]
    });
    expect(retry).toEqual(first);
    await expect(beginStoredMetricScope(factory, { ...declaration, watermark: watermark + 1 }))
      .rejects.toThrow(/changed declaration/);
    await expect(beginStoredMetricScope(factory, { ...declaration, expectedShards: ['a', 'c'] }))
      .rejects.toThrow(/changed declaration/);
    await expect(stageStoredMetricShard(factory, { ...identity, shardId: 'a', runs: [] })).rejects.toThrow(/changed content/);
    await expect(stageStoredMetricShard(factory, { ...identity, shardId: 'other', runs: [] })).rejects.toThrow(/Undeclared/);
    await stageStoredMetricShard(factory, { ...identity, shardId: 'b', runs: [] });
    expect((await readStoredMetricScope(factory, identity)).shards['["a"]']).toHaveLength(2);
  });

  it('isolates namespace and deployment paths even with identical scope and shard IDs', async () => {
    const { factory } = factoryPair();
    await beginStoredMetricScope(factory, { ...declaration, expectedShards: ['a'] });
    await beginStoredMetricScope(factory, { ...declaration, namespace: 'other', expectedShards: ['a'] });
    await beginStoredMetricScope(factory, { ...declaration, expectedShards: ['a'] }, { pathname: '/other/' });
    await stageStoredMetricShard(factory, { ...identity, shardId: 'a', runs: [run] });
    await stageStoredMetricShard(factory, { ...identity, namespace: 'other', shardId: 'a', runs: [] });
    await stageStoredMetricShard(factory, { ...identity, shardId: 'a', runs: [] }, { pathname: '/other/' });
    expect((await readStoredMetricScope(factory, identity)).shards['["a"]']).toEqual([run]);
    expect((await readStoredMetricScope(factory, { ...identity, namespace: 'other' })).shards['["a"]']).toEqual([]);
    expect((await readStoredMetricScope(factory, identity, { pathname: '/other/' })).shards['["a"]']).toEqual([]);
    await expect(readStoredMetricScope(factory, { ...identity, scopeId: 'missing' })).rejects.toThrow(/not been declared/);
  });

  it('rolls back a shard write and its receipt together when a later write aborts', async () => {
    const { factory } = factoryPair();
    await beginStoredMetricScope(factory, declaration);
    const database = await new Promise((resolve, reject) => {
      const request = factory.open(METRIC_STAGING_DATABASE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const prototype = Object.getPrototypeOf(database);
    database.close();
    const transact = prototype.transaction;
    vi.spyOn(prototype, 'transaction').mockImplementation(function (...parameters) {
      const transaction = transact.apply(this, parameters);
      const objectStore = transaction.objectStore.bind(transaction);
      vi.spyOn(transaction, 'objectStore').mockImplementation((name) => {
        const store = objectStore(name);
        if (name === 'scopes') vi.spyOn(store, 'put').mockImplementation(() => {
          throw new Error('injected receipt write failure');
        });
        return store;
      });
      return transaction;
    });
    await expect(stageStoredMetricShard(factory, { ...identity, shardId: 'a', runs: [run] }))
      .rejects.toThrow(/injected/);
    vi.restoreAllMocks();
    const receipt = await stageStoredMetricShard(factory, { ...identity, shardId: 'a', runs: [{ ...run, aicTotal: 0.2 }] });
    expect(receipt).toMatchObject({ observations: 1, receivedShards: 1 });
  });

  it('snapshots inputs before database opening yields and rejects non-JSON observations', async () => {
    const { factory } = factoryPair();
    await beginStoredMetricScope(factory, { ...declaration, expectedShards: ['a'] });
    const runs = [{ ...run }];
    const pending = stageStoredMetricShard(factory, { ...identity, shardId: 'a', runs });
    runs[0].aicTotal = 999;
    await pending;
    expect((await readStoredMetricScope(factory, identity)).shards['["a"]'][0].aicTotal).toBe(0.1);
    for (const invalid of [undefined, NaN, Infinity, new Date(), 1n]) {
      await expect(stageStoredMetricShard(factory, { ...identity, shardId: 'b', runs: [{ ...run, invalid }] }))
        .rejects.toThrow(/JSON/);
    }
  });

  it('rejects oversized shards and undeclared scopes without persisting a receipt', async () => {
    const { factory } = factoryPair();
    await expect(stageStoredMetricShard(factory, { ...identity, shardId: 'a', runs: [] })).rejects.toThrow(/not been declared/);
    await beginStoredMetricScope(factory, declaration);
    await expect(stageStoredMetricShard(factory, {
      ...identity, shardId: 'a', runs: Array.from({ length: 1001 }, () => run)
    })).rejects.toThrow(/bounded run count/);
    expect(await stageStoredMetricShard(factory, { ...identity, shardId: 'a', runs: [] }))
      .toMatchObject({ receivedShards: 1, observations: 0 });
  });

  it('keeps receipt counts exact when connections contend and retry failed writes', async () => {
    const { factory, reopen } = factoryPair();
    await beginStoredMetricScope(factory, declaration);
    const results = await Promise.allSettled(['a', 'b'].map((shardId) =>
      stageStoredMetricShard(reopen(), { ...identity, shardId, runs: [run] })));
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        await stageStoredMetricShard(reopen(), { ...identity, shardId: ['a', 'b'][index], runs: [run] });
      }
    }
    expect((await readStoredMetricScope(reopen(), identity)).shards).toEqual({ '["a"]': [run], '["b"]': [run] });
    expect(await stageStoredMetricShard(reopen(), { ...identity, shardId: 'a', runs: [run] }))
      .toMatchObject({ receivedShards: 2, observations: 2 });
  }, 15_000);

  it('rejects corrupted restored receipt counts and unsupported versions', async () => {
    const { factory } = factoryPair();
    await beginStoredMetricScope(factory, { ...declaration, expectedShards: ['a'] });
    await stageStoredMetricShard(factory, { ...identity, shardId: 'a', runs: [] });
    const database = await new Promise((resolve, reject) => {
      const request = factory.open(METRIC_STAGING_DATABASE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const corrupt = (/** @type {Record<string, unknown>} */ fields) => new Promise((resolve, reject) => {
      const transaction = database.transaction('scopes', 'readwrite');
      transaction.objectStore('scopes').put({
        key: '["test","scope"]', version: 1, scope: { ...declaration, expectedShards: ['a'] },
        receivedShards: 1, observations: 0, ...fields
      });
      transaction.oncomplete = () => resolve(undefined);
      transaction.onabort = () => reject(transaction.error);
    });
    await corrupt({ observations: 1 });
    await expect(readStoredMetricScope(factory, identity)).rejects.toThrow(/inconsistent/);
    await corrupt({ version: 2 });
    await expect(readStoredMetricScope(factory, identity)).rejects.toThrow(/Unsupported/);
    await expect(stageStoredMetricShard(factory, { ...identity, shardId: 'a', runs: [] })).rejects.toThrow(/Unsupported/);
    database.close();
  });

  it('rejects missing declared shard data without leaking later request callbacks', async () => {
    const { factory } = factoryPair();
    await beginStoredMetricScope(factory, declaration);
    for (const shardId of ['a', 'b']) await stageStoredMetricShard(factory, { ...identity, shardId, runs: [] });
    const database = await new Promise((resolve, reject) => {
      const request = factory.open(METRIC_STAGING_DATABASE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('shards', 'readwrite');
      transaction.objectStore('shards').clear();
      transaction.oncomplete = () => resolve(undefined);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
    await expect(readStoredMetricScope(factory, identity)).rejects.toThrow(/missing its staged shard/);
  });
});

it('enforces the exact total observation limit without acknowledging an oversized scope', async () => {
  const factory = new IDBFactory();
  const shards = Array.from({ length: 101 }, (_, index) => String(index));
  await beginStoredMetricScope(factory, { ...declaration, expectedShards: shards });
  const runs = Array.from({ length: 1000 }, () => ({ id: 'one' }));
  for (const shardId of shards.slice(0, 100)) {
    await stageStoredMetricShard(factory, { ...identity, shardId, runs });
  }
  await expect(stageStoredMetricShard(factory, { ...identity, shardId: shards[100], runs: [{ id: 'one' }] }))
    .rejects.toThrow(/scope exceeds bounded/);
  expect(await stageStoredMetricShard(factory, { ...identity, shardId: shards[100], runs: [] }))
    .toMatchObject({ receivedShards: 101, observations: 100_000 });
}, 15_000);

it('recovers SQLite staging in a new process after an acknowledged shard and abrupt process exit', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cao-metric-process-'));
  directories.push(directory);
  const filename = join(directory, 'metrics.sqlite');
  const stagingUrl = pathToFileURL(resolve('src/data/storage/metric-staging.js')).href;
  const sqliteUrl = pathToFileURL(resolve('src/data/storage/sqlite-indexeddb.js')).href;
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { beginStoredMetricScope, stageStoredMetricShard } from ${JSON.stringify(stagingUrl)};
    import { createSqliteIndexedDB } from ${JSON.stringify(sqliteUrl)};
    const factory = createSqliteIndexedDB(${JSON.stringify(filename)});
    await beginStoredMetricScope(factory, ${JSON.stringify(declaration)});
    await stageStoredMetricShard(factory, ${JSON.stringify({ ...identity, shardId: 'a', runs: [run] })});
    process.exit(0);
  `], { stdio: 'pipe' });
  const factory = createSqliteIndexedDB(filename);
  await expect(readStoredMetricScope(factory, identity)).rejects.toThrow(/incomplete/);
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { createSqliteIndexedDB } from ${JSON.stringify(sqliteUrl)};
    const factory = createSqliteIndexedDB(${JSON.stringify(filename)});
    const database = await new Promise((resolve, reject) => {
      const request = factory.open(${JSON.stringify(METRIC_STAGING_DATABASE)});
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction(['shards', 'scopes'], 'readwrite');
    transaction.objectStore('shards').put({
      key: JSON.stringify(['test', 'scope', 'b']), runs: [{ id: 'unacknowledged' }]
    });
    process.exit(0);
  `], { stdio: 'pipe' });
  await expect(readStoredMetricScope(factory, identity)).rejects.toThrow(/incomplete/);
  await stageStoredMetricShard(factory, { ...identity, shardId: 'b', runs: [] });
  expect((await readStoredMetricScope(factory, identity)).shards['["a"]']).toEqual([run]);
  expect((await readStoredMetricScope(factory, identity)).shards['["b"]']).toEqual([]);
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { beginStoredMetricLedger, completeStoredMetricScope } from ${JSON.stringify(stagingUrl)};
    import { createSqliteIndexedDB } from ${JSON.stringify(sqliteUrl)};
    const factory = createSqliteIndexedDB(${JSON.stringify(filename)});
    await beginStoredMetricLedger(factory, ${JSON.stringify({ namespace: 'test', watermark })});
    await completeStoredMetricScope(factory, ${JSON.stringify(identity)});
    process.exit(0);
  `], { stdio: 'pipe' });
  const saved = await readStoredMetricLedger(factory, 'test');
  expect(saved.revision).toBe(1);
  expect(Object.values(saved.ledger.dailyMetrics)[0].measures.aicTotal.sum).toBe(0.1);
  expect(await completeStoredMetricScope(factory, identity)).toEqual({ ...identity, revision: 1, watermark });
});

it('rejects a mixed SQLite ledger read when another process commits between row reads', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cao-metric-read-fence-'));
  directories.push(directory);
  const filename = join(directory, 'metrics.sqlite');
  const factory = createSqliteIndexedDB(filename);
  await beginStoredMetricLedger(factory, { namespace: 'test', watermark });
  for (const { id, runs } of [{ id: 'first', runs: [run] }, { id: 'second', runs: [{ ...run, id: 'two' }] }]) {
    await beginStoredMetricScope(factory, { ...declaration, id, expectedShards: ['a'] });
    await stageStoredMetricShard(factory, { ...identity, scopeId: id, shardId: 'a', runs });
  }
  await completeStoredMetricScope(factory, { ...identity, scopeId: 'first' });
  const database = await new Promise((resolve, reject) => {
    const request = factory.open(METRIC_STAGING_DATABASE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const prototype = Object.getPrototypeOf(database);
  database.close();
  const transact = prototype.transaction;
  let updated = false;
  vi.spyOn(prototype, 'transaction').mockImplementation(function (...parameters) {
    const transaction = transact.apply(this, parameters);
    const objectStore = transaction.objectStore.bind(transaction);
    vi.spyOn(transaction, 'objectStore').mockImplementation((name) => {
      const store = objectStore(name);
      if (name === 'contributions') {
        const index = store.index.bind(store);
        vi.spyOn(store, 'index').mockImplementation((name) => {
          const selection = index(name);
          const getAll = selection.getAll.bind(selection);
          vi.spyOn(selection, 'getAll').mockImplementation((...args) => {
            const request = getAll(...args);
            if (!updated) {
              updated = true;
              execFileSync(process.execPath, ['--input-type=module', '-e', `
                import { completeStoredMetricScope } from ${JSON.stringify(pathToFileURL(resolve('src/data/storage/metric-staging.js')).href)};
                import { createSqliteIndexedDB } from ${JSON.stringify(pathToFileURL(resolve('src/data/storage/sqlite-indexeddb.js')).href)};
                await completeStoredMetricScope(createSqliteIndexedDB(${JSON.stringify(filename)}),
                  ${JSON.stringify({ ...identity, scopeId: 'second' })});
              `], { stdio: 'pipe' });
            }
            return request;
          });
          return selection;
        });
      }
      return store;
    });
    return transaction;
  });
  await expect(readStoredMetricLedger(factory, 'test')).rejects.toBeInstanceOf(MetricLedgerConflictError);
  vi.restoreAllMocks();
  expect(updated).toBe(true);
  const saved = await readStoredMetricLedger(factory, 'test');
  expect(saved.revision).toBe(2);
  expect(Object.values(saved.ledger.dailyMetrics)[0].measures.runs).toBe(2);
});

it('keeps staging stores separate from the canonical query database', () => {
  expect(METRIC_STAGING_DATABASE).not.toBe('gh-aw-cao-dashboard-data');
});
