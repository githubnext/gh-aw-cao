import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  applyTableQueryLimits,
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

  it('limits every table query while preserving smaller declared limits', () => {
    const queries = [
      { name: 'events', from: 'raw-events' },
      { name: 'runs', from: 'runs', limit: 100 },
      { name: 'chart', from: 'runs' }
    ];

    expect(applyTableQueryLimits(queries, ['events', 'runs'], 25000)).toEqual([
      { name: 'events', from: 'raw-events', limit: 25000 },
      { name: 'runs', from: 'runs', limit: 100 },
      queries[2]
    ]);
  });

  it('applies the selected limit to every terminal table-backed dashboard query', () => {
    const document = JSON.parse(readFileSync(`${process.cwd()}/dashboard.json`, 'utf8'));
    const tableSources = dashboardTableSourceNames(
      /** @type {import('../../src/presenter.js').PresentationDocument} */ (document)
    );
    const limited = applyTableQueryLimits(
      /** @type {unknown[]} */ (document.dashboard.queries ?? []),
      tableSources,
      25000
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
      expect(Number(queries.get(source)?.limit), source).toBeLessThanOrEqual(25000);
    }
  });

  it('does not limit table queries consumed by downstream queries', () => {
    const queries = [
      { name: 'inventory', from: 'workflows' },
      { name: 'totals', from: 'inventory', aggregate: { values: [] } }
    ];

    expect(applyTableQueryLimits(queries, ['inventory'], 10000)[0]).toBe(queries[0]);
  });
});
