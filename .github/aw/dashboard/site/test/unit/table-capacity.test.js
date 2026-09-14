import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  applyTableQuerySafetyLimits,
  logTableCapacityDecision,
  tableRowLimitForEnvironment
} from '../../src/data/table-capacity.js';
import { dashboardTableSourceNames } from '../../src/presenter.js';

describe('adaptive table capacity', () => {
  it.each([
    [{ mobile: true, deviceMemory: 16 }, 10000],
    [{ deviceMemory: 2 }, 10000],
    [{ deviceMemory: 4 }, 25000],
    [{ deviceMemory: 8 }, 50000],
    [{ deviceMemory: 16 }, 100000],
    [{ heapSizeLimit: 1024 ** 3 }, 10000],
    [{ hardwareConcurrency: 4 }, 25000],
    [{ hardwareConcurrency: 8 }, 50000]
  ])('selects a bounded row limit for %j', (environment, expected) => {
    expect(tableRowLimitForEnvironment(environment)).toBe(expected);
  });

  it('uses the most conservative available memory signal', () => {
    expect(tableRowLimitForEnvironment({
      deviceMemory: 16,
      heapSizeLimit: 2 * (1024 ** 3)
    })).toBe(25000);
  });

  it('logs the selected row limit and browser capacity signals', () => {
    const info = vi.fn();
    const decision = {
      rowLimit: 25000,
      mobile: false,
      deviceMemoryGiB: 4,
      heapSizeLimitGiB: 2,
      hardwareConcurrency: 8
    };

    logTableCapacityDecision(decision, { info });

    expect(info).toHaveBeenCalledWith('[dashboard-table-capacity]', decision);
  });

  it('applies the engine safety ceiling while preserving smaller declared limits', () => {
    const queries = [
      { name: 'events', from: 'raw-events' },
      { name: 'runs', from: 'runs', limit: 100 },
      { name: 'chart', from: 'runs' }
    ];

    expect(applyTableQuerySafetyLimits(queries, ['events', 'runs'])).toEqual([
      { name: 'events', from: 'raw-events', limit: 100000 },
      { name: 'runs', from: 'runs', limit: 100 },
      queries[2]
    ]);
  });

  it('applies the safety ceiling to every terminal table-backed dashboard query', () => {
    const document = JSON.parse(readFileSync(`${process.cwd()}/dashboard.json`, 'utf8'));
    const tableSources = dashboardTableSourceNames(
      /** @type {import('../../src/presenter.js').PresentationDocument} */ (document)
    );
    const limited = applyTableQuerySafetyLimits(
      /** @type {unknown[]} */ (document.dashboard.queries ?? []),
      tableSources
    );
    const queries = new Map(limited.flatMap((query) => {
      if (!query || typeof query !== 'object' || Array.isArray(query)) return [];
      const definition = /** @type {Record<string, unknown>} */ (query);
      return typeof definition.name === 'string' ? [[definition.name, definition]] : [];
    }));
    const dashboardQueries = /** @type {Array<Record<string, any>>} */ (document.dashboard.queries);
    const dependencies = new Set(dashboardQueries.flatMap((query) => [
      query.from,
      ...(query.joins ?? []).map((/** @type {Record<string, unknown>} */ join) => join.source)
    ]));

    for (const source of tableSources.filter((name) => queries.has(name) && !dependencies.has(name))) {
      expect(Number(queries.get(source)?.limit), source).toBeLessThanOrEqual(100000);
    }
  });

  it('does not limit table queries consumed by downstream queries', () => {
    const queries = [
      { name: 'inventory', from: 'workflows' },
      { name: 'totals', from: 'inventory', aggregate: { values: [] } }
    ];

    expect(applyTableQuerySafetyLimits(queries, ['inventory'])[0]).toBe(queries[0]);
  });
});
