import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  applyTableQueryLimits,
  limitTableSources,
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
      { name: 'events', from: 'events' },
      { name: 'runs', from: 'runs', limit: 100 },
      { name: 'chart', from: 'runs' }
    ];

    expect(applyTableQueryLimits(queries, ['events', 'runs'], 25000)).toEqual([
      { name: 'events', from: 'events', limit: 25000 },
      { name: 'runs', from: 'runs', limit: 100 },
      queries[2]
    ]);
  });

  it('bounds raw table sources without changing unrelated sources', () => {
    const rows = Array.from({ length: 4 }, (_, id) => ({ id }));
    const metadata = {
      'source-id': 'fixture',
      'source-kind': 'fixture',
      'as-of': '2026-09-13T00:00:00Z',
      'retrieved-at': '2026-09-13T00:00:00Z',
      completeness: /** @type {'complete'} */ ('complete'),
      freshness: /** @type {'fresh'} */ ('fresh')
    };
    const sources = {
      table: { source: 'table', rows, metadata },
      chart: { source: 'chart', rows, metadata }
    };

    const bounded = limitTableSources(sources, ['table'], 2);

    expect(bounded.table.rows).toEqual(rows.slice(0, 2));
    expect(bounded.chart).toBe(sources.chart);
  });

  it('applies the selected limit to every table-backed dashboard query', () => {
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

    for (const source of tableSources.filter((name) => queries.has(name))) {
      expect(Number(queries.get(source)?.limit), source).toBeLessThanOrEqual(25000);
    }
  });
});
