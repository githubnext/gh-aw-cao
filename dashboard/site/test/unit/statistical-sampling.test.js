import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import fixture from '../fixtures/statistical-sampling.json' with { type: 'json' };
import { sampleStatisticalRuns, statisticalPriority, STATISTICAL_CAPACITIES, STATISTICAL_INPUT_LIMITS } from '../../src/data/queries/statistical-sample.js';
import { openCanonicalDatabase } from '../../src/data/storage/indexeddb.js';
import { queryDatabaseSources } from '../../src/data/queries/database.js';
import { processDataRequest } from '../../src/data-worker.js';

vi.stubGlobal('crypto', webcrypto);
const options = { watermark: fixture.watermark, capacity: fixture.capacity, complete: true };

describe('independent frozen statistical sampling', () => {
  it('shares framed SHA256 priorities and largest-remainder/failure-reserve golden membership with Go', async () => {
    const result = await sampleStatisticalRuns(fixture.rows, options);
    expect(result.rows.map((row) => row.id)).toEqual(fixture.expectedIds);
    expect(result.frame).toMatchObject({
      'population-count': 6, 'selected-count': 3, 'incomplete-count': 1,
      'weight-valid': true, 'full-population-estimable': true,
      strata: [
        { stratum: '2026-10-01/success', population: 3, allocation: 1 },
        { stratum: '2026-10-02/failure', population: 1, allocation: 1 },
        { stratum: '2026-10-02/success', population: 2, allocation: 1 }
      ]
    });
    expect(result.rows.map((row) => row['statistical-weight'])).toEqual([3, 1, 2]);
    expect(await statisticalPriority('github:run:o/r:1')).toBe(fixture.priority);
    const reversed = await sampleStatisticalRuns([...fixture.rows].reverse(), options);
    expect(reversed).toEqual(result);
    const duplicates = await sampleStatisticalRuns([...fixture.rows, fixture.rows[0]], options);
    expect(duplicates.rows).toEqual(result.rows);
    expect(duplicates.frame['population-count']).toBe(6);
  });

  it('handles zero capacity, exact seven-day expiry, hot exclusion, and seed changes independently', async () => {
    const zero = await sampleStatisticalRuns(fixture.rows, { ...options, capacity: 0 });
    expect(zero.rows).toEqual([]);
    expect(zero.frame['population-count']).toBe(6);
    expect(zero.frame['full-population-estimable']).toBe(false);
    const expired = await sampleStatisticalRuns(fixture.rows, { ...options, watermark: '2026-10-08T12:00:00.001Z', capacity: 20 });
    expect(expired.rows.some((row) => row.id === fixture.rows[0].id)).toBe(false);
    expect(expired.rows.some((row) => row.id === fixture.rows[6].id)).toBe(true);
    const hot = await sampleStatisticalRuns(fixture.rows, { ...options, hotIds: [fixture.rows[5].id] });
    expect(hot.frame['hot-excluded-count']).toBe(1);
    expect(hot.rows.some((row) => row.id === fixture.rows[5].id)).toBe(false);
    expect(await statisticalPriority('github:run:o/r:1', 'different-seed'))
      .not.toEqual(await statisticalPriority('github:run:o/r:1'));
    expect(STATISTICAL_CAPACITIES).toEqual({ postgres: 64000, sqlite: 8000, indexeddb: 16000 });
  });

  it('matches full-sort bottom-k selection across strata, capacities, and input orders', async () => {
    const rows = Array.from({ length: 513 }, (_, index) => ({
      ...fixture.rows[index % 6], id: `github:run:o/r:${index + 1}`, githubRunId: String(index + 1)
    }));
    const priorities = new Map(await Promise.all(rows.map(async (row) =>
      /** @type {[string, string]} */ ([row.id, await statisticalPriority(row.id)]))));
    const sorted = [...rows].sort((a, b) => {
      const left = String(priorities.get(a.id));
      const right = String(priorities.get(b.id));
      return left < right ? -1 : left > right ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    for (const capacity of [0, 1, 7, 31, 513, 600]) {
      const result = await sampleStatisticalRuns(rows, { ...options, capacity });
      const expected = result.frame.strata.flatMap(({ stratum, population, allocation, cutoff }) => {
        const candidates = sorted.filter((row) => `${row.startedAt.slice(0, 10)}/${row.conclusion}` === stratum);
        expect(candidates).toHaveLength(population);
        expect(cutoff).toBe(allocation > 0 ? priorities.get(candidates[allocation - 1].id) : null);
        return candidates.slice(0, allocation).map((row) => row.id);
      });
      expect(result.rows.map((row) => row.id)).toEqual(expected);
      expect(result.rows).toHaveLength(Math.min(capacity, rows.length));
      expect(await sampleStatisticalRuns([...rows].reverse(), { ...options, capacity })).toEqual(result);
    }
  });

  it('never invents weights for incomplete frames, conflicting duplicates, invalid or missing timestamps', async () => {
    for (const rows of [
      [...fixture.rows, { ...fixture.rows[0], startedAt: 'invalid' }],
      [...fixture.rows, { ...fixture.rows[1], startedAt: undefined }],
      [...fixture.rows, { ...fixture.rows[0], startedAt: '2026-02-30T00:00:00Z' }],
      [...fixture.rows, { ...fixture.rows[0], conclusion: 'failure' }]
    ]) {
      const result = await sampleStatisticalRuns(rows, options);
      expect(result.frame['weight-valid']).toBe(false);
      expect(result.rows.every((row) => !Object.hasOwn(row, 'statistical-weight'))).toBe(true);
    }
    const partial = await sampleStatisticalRuns(fixture.rows, { ...options, complete: false });
    expect(partial.rows.every((row) => row['statistical-weight-valid'] === false)).toBe(true);
    const poisoned = await sampleStatisticalRuns(fixture.rows.map((row) => ({
      ...row, 'statistical-weight': 999, 'statistical-probability': 1
    })), { ...options, complete: false });
    expect(poisoned.rows.every((row) => !Object.hasOwn(row, 'statistical-weight'))).toBe(true);
    const conflicting = [...fixture.rows, { ...fixture.rows[0], conclusion: 'failure' }, { ...fixture.rows[0], conclusion: 'failure' }];
    const quarantined = await sampleStatisticalRuns(conflicting, options);
    expect(quarantined).toEqual(await sampleStatisticalRuns([...conflicting].reverse(), options));
    expect(quarantined.frame['quarantined-count']).toBe(1);
    expect(quarantined.rows.some((row) => row.id === fixture.rows[0].id)).toBe(false);
    await expect(sampleStatisticalRuns(fixture.rows, { ...options, watermark: undefined })).rejects.toThrow('watermark');
    await expect(sampleStatisticalRuns(fixture.rows, { ...options, capacity: -1 })).rejects.toThrow('capacity');
  });

  it('uses createdAt only as the execution fallback and gives the frozen frame a deterministic identity', async () => {
    const rows = [{
      ...fixture.rows[0], startedAt: null, createdAt: fixture.rows[0].startedAt,
      observedAt: '2099-01-01T00:00:00Z'
    }];
    const result = await sampleStatisticalRuns(rows, options);
    expect(result.rows).toHaveLength(1);
    expect(result.frame['frame-id']).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.frame['frame-id']).toBe((await sampleStatisticalRuns(rows, options)).frame['frame-id']);
    expect(result.frame['frame-id']).not.toBe((await sampleStatisticalRuns(rows, { ...options, seed: 'other' })).frame['frame-id']);
    const observationOnly = await sampleStatisticalRuns([{ ...rows[0], createdAt: null }], options);
    expect(observationOnly.rows).toEqual([]);
    expect(observationOnly.frame['weight-valid']).toBe(false);
    const offset = await sampleStatisticalRuns([{
      ...fixture.rows[0], startedAt: '2026-10-01T14:00:00+02:00'
    }], options);
    expect(offset.rows).toHaveLength(1);
  });

  it('fails closed before admitting an oversized candidate frame and observes cancellation checkpoints', async () => {
    await expect(sampleStatisticalRuns(Array(STATISTICAL_INPUT_LIMITS.rows + 1).fill(fixture.rows[0]), options))
      .rejects.toThrow('input row budget');
    await expect(sampleStatisticalRuns(fixture.rows, {
      ...options, checkpoint: () => { throw new Error('cancelled'); }
    })).rejects.toThrow('cancelled');
  });

  it('resolves through the production data worker and filters only after frozen membership', async () => {
    const factory = new IDBFactory();
    const database = await openCanonicalDatabase(factory);
    const transaction = database.transaction('runs', 'readwrite');
    for (const row of fixture.rows) transaction.objectStore('runs').put(row);
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = reject;
    });

    database.close();
    const sources = {
      runs: { rows: [], metadata: { availability: 'available', completeness: 'complete', 'as-of': fixture.watermark } }
    };
    const queries = [{
      name: 'sampled', from: 'statistical-runs',
      filter: { predicates: [{ field: 'run-conclusion', equals: 'success' }] },
      select: [
        { field: 'id' }, { field: 'statistical-weight' }, { field: 'sample-weight' },
        { field: 'sample-probability' }, { field: 'sample-stratum' }
      ]
    }];
    const previous = globalThis.indexedDB;
    vi.stubGlobal('indexedDB', factory);
    /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */
    let result;
    try {
      result = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (await processDataRequest({
        operation: 'load-dashboard-query-sources', sources, queries, sourceNames: ['sampled', 'runs']
      }));
    } finally {
      vi.stubGlobal('indexedDB', previous);
    }
    const sampled = result.sampled;
    expect(sampled.rows).toHaveLength(5);
    expect(sampled.metadata['statistical-frame']).toMatchObject({ 'population-count': 6, capacity: 16000 });
    expect(sampled.metadata['sample-frame']).toEqual(sampled.metadata['statistical-frame']);
    expect(sampled.rows.every((row) => row['sample-weight'] === 1 && row['sample-probability'] === 1
      && typeof row['sample-stratum'] === 'string')).toBe(true);
    expect(result.runs.rows).toHaveLength(9);
    // The production worker's loader owns the canonical database; direct
    // execution of a missing statistical source must not fall back to exact runs.
    const unavailable = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
      operation: 'execute-dashboard-queries', sources: {}, queries, sourceNames: ['sampled']
    }));
    expect(unavailable.sampled.metadata.availability).toBe('unavailable');
  });

  it('keeps every owned observation of selected runs without sampling children independently', async () => {
    const factory = new IDBFactory();
    const database = await openCanonicalDatabase(factory);
    const stores = ['tools', 'domains', 'skills', 'audits'];
    const transaction = database.transaction(['runs', ...stores], 'readwrite');
    for (const row of fixture.rows) transaction.objectStore('runs').put(row);
    for (const store of stores) {
      for (const [id, runId] of [
        ['a', fixture.rows[0].id], ['b', fixture.rows[0].id],
        ['expired', fixture.rows[7].id], ['running', fixture.rows[8].id]
      ]) transaction.objectStore(store).put({ id, runId, name: id, source: 'fixture', type: 'fixture' });
    }
    await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = reject; });
    database.close();
    const result = await queryDatabaseSources(factory, {
      runs: { metadata: { 'as-of': fixture.watermark, completeness: 'complete', availability: 'available' } }
    }, stores.flatMap((store) => [store, `statistical-${store}`]));
    for (const store of stores) {
      expect(result[store].rows).toHaveLength(4);
      expect(result[`statistical-${store}`].rows.map((row) => row.id)).toEqual(['a', 'b']);
      expect(result[`statistical-${store}`].rows.every((row) => row['statistical-weight'] === 1)).toBe(true);
      expect(result[`statistical-${store}`].metadata['statistical-frame']).toMatchObject({ 'population-count': 6 });
    }
  });

  it('does not refill a bounded sample after a consumer narrows to an unselected run', async () => {
    const factory = new IDBFactory();
    const rows = Array.from({ length: STATISTICAL_CAPACITIES.indexeddb + 1 }, (_, index) => ({
      ...fixture.rows[0], id: `github:run:o/r:${index + 1}`, githubRunId: String(index + 1)
    }));
    const sample = await sampleStatisticalRuns(rows, { watermark: fixture.watermark, complete: true });
    const selected = new Set(sample.rows.map((row) => row.id));
    const missing = rows.find((row) => !selected.has(row.id));
    expect(missing).toBeDefined();
    const database = await openCanonicalDatabase(factory);
    const transaction = database.transaction('runs', 'readwrite');
    for (const row of rows) transaction.objectStore('runs').put(row);
    await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = reject; });
    database.close();
    const previous = globalThis.indexedDB;
    vi.stubGlobal('indexedDB', factory);
    try {
      const query = {
        name: 'narrow', from: 'statistical-runs',
        filter: { predicates: [{ field: 'id', equals: missing?.id }] }
      };
      const result = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (await processDataRequest({
        operation: 'load-dashboard-query-sources',
        sources: { runs: { metadata: { 'as-of': fixture.watermark, completeness: 'complete' } } },
        queries: [query], sourceNames: ['narrow']
      }));
      expect(result.narrow.rows).toEqual([]);
      expect(result.narrow.metadata['statistical-frame']).toMatchObject({
        'population-count': 16001, 'selected-count': 16000
      });
    } finally {
      vi.stubGlobal('indexedDB', previous);
    }
  }, 30000);
});
