import 'fake-indexeddb/auto';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareCanonicalStrings } from '../../src/data/normalize/order.js';
import { normalize } from '../../src/data/normalize/index.js';
import {
  openCanonicalDatabase, planCanonicalStorageTiers, readCanonicalBatch, upsertCanonicalBatch
} from '../../src/data/storage/indexeddb.js';
import {
  createStorageTierPlanner, DAY_MS, planStorageTiers
} from '../../src/data/storage/tiering.js';

const WATERMARK = Date.parse('2026-10-21T12:00:00Z');
const OPTIONS = /** @type {const} */ ({
  backend: 'indexeddb', namespace: 'stream-test', watermark: WATERMARK, seed: 'v1',
  capacities: { hot: 7, statistical: 13 }
});

/** @param {string} id @param {Record<string, unknown>} [fields] */
function run(id, fields = {}) {
  return {
    id, repositoryId: 'repo', workflowId: 'workflow',
    startedAt: '2026-10-20T00:00:00Z', observedAt: '2026-10-21T00:00:00Z',
    conclusion: 'success', ...fields
  };
}

afterEach(() => vi.restoreAllMocks());

describe('bounded streaming storage tier planner', () => {
  it('matches materialized plans across populations, capacities, seeds, outcomes and time boundaries', () => {
    const runs = Array.from({ length: 157 }, (_, index) => run(`run:${index}`, {
      startedAt: new Date(WATERMARK - (index % 10 - 1) * DAY_MS).toISOString(),
      conclusion: ['success', 'failure', 'cancelled', 'timed_out'][index % 4]
    }));
    runs.push(run('boundary', { startedAt: new Date(WATERMARK - 7 * DAY_MS).toISOString() }));
    runs.push(run('outside', { startedAt: new Date(WATERMARK - 7 * DAY_MS - 1).toISOString() }));
    runs.push(run('😀'), run('\uE000'));
    for (const backend of /** @type {const} */ (['postgres', 'sqlite', 'indexeddb'])) {
      for (const capacity of [0, 1, 20, 500]) {
        const options = {
          ...OPTIONS, backend, seed: `${backend}:${capacity}`,
          capacities: { hot: capacity, statistical: capacity * 2 }
        };
        const planner = createStorageTierPlanner(options);
        for (const record of [...runs].sort((a, b) => compareCanonicalStrings(a.id, b.id))) {
          planner.add(record);
          expect(planner.retainedCandidateCount).toBeLessThanOrEqual(capacity * 3 + 1);
        }
        expect(planner.finish()).toEqual(planStorageTiers([...runs].reverse(), options));
      }
    }
  });

  it('reconciles adjacent revisions before selection, including source authority and future winners', () => {
    const options = { ...OPTIONS, sourcePrecedence: { official: 2, fallback: 1 } };
    const records = [
      run('a', { startedAt: null, provenance: { source: 'fallback' } }),
      run('a', { provenance: { source: 'official' }, conclusion: 'failure' }),
      run('b'),
      run('b', { startedAt: new Date(WATERMARK + 1).toISOString(), observedAt: new Date(WATERMARK).toISOString() }),
      run('c', { conclusion: 'failure' }),
      run('c')
    ];
    const planner = createStorageTierPlanner(options);
    records.forEach((record) => planner.add(record));
    expect(planner.finish()).toEqual(planStorageTiers(records, options));
  });

  it('snapshots pending measurements and source precedence rather than retaining mutable input records', () => {
    const ranks = { official: 2, fallback: 1 };
    const planner = createStorageTierPlanner({ ...OPTIONS, sourcePrecedence: ranks });
    const official = run('a', { provenance: { source: 'official' }, conclusion: 'failure' });
    const expected = planStorageTiers([official], OPTIONS);
    planner.add(official);
    official.conclusion = 'success';
    official.startedAt = new Date(WATERMARK + 1).toISOString();
    ranks.fallback = 3;
    planner.add(run('a', { provenance: { source: 'fallback' } }));
    expect(planner.finish()).toEqual(expected);
  });

  it('never publishes a prefix after unordered or invalid input, or after finalization', () => {
    const unordered = createStorageTierPlanner(OPTIONS);
    unordered.add(run('b'));
    expect(() => unordered.add(run('a'))).toThrow(/ascending canonical ID/);
    expect(() => unordered.finish()).toThrow(/closed/);
    expect(() => unordered.add(run('c'))).toThrow(/closed/);

    const invalid = createStorageTierPlanner(OPTIONS);
    invalid.add(run('a', { startedAt: null }));
    expect(() => invalid.finish()).toThrow(/startedAt or completedAt/);
    expect(() => invalid.finish()).toThrow(/closed/);
    const badObservation = createStorageTierPlanner(OPTIONS);
    expect(() => badObservation.add(run('a', { observedAt: null }))).toThrow(/observedAt/);
    expect(() => badObservation.finish()).toThrow(/closed/);
    expect(() => createStorageTierPlanner({ ...OPTIONS, sourcePrecedence: { invalid: NaN } }))
      .toThrow(/finite/);

    const empty = createStorageTierPlanner(OPTIONS);
    expect(empty.finish()).toEqual(planStorageTiers([], OPTIONS));
    expect(() => empty.finish()).toThrow(/closed/);
    expect(() => empty.add(run('a'))).toThrow(/closed/);
  });

  it('retains only configured candidates and one pending winner across a large generated population', () => {
    const planner = createStorageTierPlanner(OPTIONS);
    for (let index = 0; index < 100_000; index += 1) {
      planner.add(run(`run:${String(index).padStart(6, '0')}`));
      if (index % 1000 === 0) expect(planner.retainedCandidateCount).toBeLessThanOrEqual(21);
    }
    const result = planner.finish();
    expect(result.hot).toHaveLength(7);
    expect(result.statistical).toHaveLength(13);
    expect(result.statisticalPopulation).toBe(100_000);
    expect(planner.retainedCandidateCount).toBe(20);
    expect(result.evictionEnabled).toBe(false);
    expect(result.weightsValid).toBe(false);
  });
});

describe('read-only canonical tier planning', () => {
  it('scans one bounded primary-key snapshot and leaves canonical records and receipts unchanged', async () => {
    const indexedDB = new IDBFactory();
    const runs = Array.from({ length: 103 }, (_, index) => run(`run:${index}`));
    runs.push(run('😀'), run('\uE000'));
    await upsertCanonicalBatch(indexedDB, { ...normalize([]), runs }, { validateRelationships: false });
    const before = await readCanonicalBatch(indexedDB);
    const getAll = vi.spyOn(IDBObjectStore.prototype, 'getAll');
    const open = vi.spyOn(indexedDB, 'open');
    const result = await planCanonicalStorageTiers(indexedDB, { ...OPTIONS, batchSize: 10 });
    expect(result).toEqual(planStorageTiers(runs, OPTIONS));
    expect(getAll).toHaveBeenCalledTimes(11);
    expect(getAll.mock.calls.every(([, count]) => count === 10)).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    getAll.mockRestore();
    expect(await readCanonicalBatch(indexedDB)).toEqual(before);
    const database = await openCanonicalDatabase(indexedDB);
    const request = database.transaction('transactions').objectStore('transactions').count();
    expect(await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    })).toBe(0);
    database.close();
  });

  it('rejects aborted, invalid and incomplete scans rather than returning a partial plan', async () => {
    const indexedDB = new IDBFactory();
    await upsertCanonicalBatch(indexedDB, {
      ...normalize([]), runs: [run('a'), run('b', { observedAt: null })]
    }, { validateRelationships: false });
    const before = await readCanonicalBatch(indexedDB);
    await expect(planCanonicalStorageTiers(indexedDB, { ...OPTIONS, batchSize: 1 })).rejects.toThrow(/observedAt/);
    expect(await readCanonicalBatch(indexedDB)).toEqual(before);
    const interrupted = new AbortController();
    const originalGetAll = IDBObjectStore.prototype.getAll;
    let batches = 0;
    const getAll = vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(/** @this {IDBObjectStore} */ function (
      /** @type {IDBValidKey | IDBKeyRange | null | undefined} */ query,
      /** @type {number | undefined} */ count
    ) {
      if (++batches === 2) interrupted.abort(new Error('interrupted scan'));
      return originalGetAll.call(this, query, count);
    });
    await expect(planCanonicalStorageTiers(indexedDB, {
      ...OPTIONS, batchSize: 1, signal: interrupted.signal
    })).rejects.toThrow('interrupted scan');
    getAll.mockRestore();
    expect(batches).toBe(2);
    expect(await readCanonicalBatch(indexedDB)).toEqual(before);
    const controller = new AbortController();
    controller.abort(new Error('cancelled scan'));
    const open = vi.spyOn(indexedDB, 'open');
    await expect(planCanonicalStorageTiers(indexedDB, { ...OPTIONS, signal: controller.signal }))
      .rejects.toThrow('cancelled scan');
    expect(open).not.toHaveBeenCalled();
    await expect(planCanonicalStorageTiers(indexedDB, { ...OPTIONS, batchSize: 0 })).rejects.toThrow(/batchSize/);
  });
});
