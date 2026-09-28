import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/** @param {string} search debug query string used to enable logging */
async function importProjectTemporalSeriesWithDebug(search) {
  const output = { debug: vi.fn() };
  vi.doMock('../../src/debug.js', async () => {
    const actual = /** @type {typeof import('../../src/debug.js')} */ (
      await vi.importActual('../../src/debug.js')
    );
    return {
      ...actual,
      createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => search, output })
    };
  });
  vi.resetModules();
  const { projectTemporalSeries } = await import('../../src/data/analytics/temporal-series.js');
  return { projectTemporalSeries, output };
}

/** @param {number} count */
function makeRows(count) {
  return Array.from({ length: count }, (_, index) => ({
    time: `2026-09-2${index % 9}T00:00:00Z`,
    series: `series-${index % 2}`,
    'metric-value': index
  }));
}

describe('temporal-series debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const { projectTemporalSeries, output } = await importProjectTemporalSeriesWithDebug('');

    projectTemporalSeries(makeRows(3), { time: 'time', series: 'series', measures: [{ field: 'metric-value', kind: 'count' }] });

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs projection-started and projection-completed under its predictable category when enabled', async () => {
    const { projectTemporalSeries, output } = await importProjectTemporalSeriesWithDebug('?debug=temporal-series');

    const rows = projectTemporalSeries(
      makeRows(4),
      { time: 'time', series: 'series', measures: [{ field: 'metric-value', kind: 'count' }] }
    );

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:temporal-series]',
      { event: 'projection-started', inputRows: 4, shape: 'tidy' }
    );
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:temporal-series]',
      { event: 'projection-completed', outputRows: rows.length }
    );
  });

  it('logs a projection-rejected event with only the limit metadata when the output-row limit is exceeded', async () => {
    const { projectTemporalSeries, output } = await importProjectTemporalSeriesWithDebug('?debug=temporal-series');
    const rows = Array.from({ length: 100_001 }, (_, index) => ({
      time: '2026-09-27T00:00:00Z',
      series: `series-${index}`,
      'metric-value': index
    }));

    expect(() => projectTemporalSeries(
      rows,
      { time: 'time', series: 'series', measures: [{ field: 'metric-value', kind: 'count' }] }
    )).toThrow(RangeError);

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:temporal-series]',
      { event: 'projection-rejected', reason: 'output-row-limit', limit: 100_000 }
    );
  });

  it('never logs row contents, only scalar counts and the projection shape', async () => {
    const { projectTemporalSeries, output } = await importProjectTemporalSeriesWithDebug('?debug=temporal-series');

    projectTemporalSeries([
      { time: '2026-09-27T00:00:00Z', series: 'secret-repo-name', 'metric-value': 1, token: 'sensitive-token-value' }
    ], { time: 'time', series: 'series', measures: [{ field: 'metric-value', kind: 'count' }] });

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toMatch(/secret|sensitive/i);
    }
  });
});
