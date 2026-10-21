import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectTemporalSeries } from '../../src/data/analytics/temporal-series.js';

afterEach(() => vi.restoreAllMocks());

describe('temporal projection execution', () => {
  it.each(['tidy', 'groups', 'panels'])('parses timestamps once per observation for %s', (shape) => {
    const rows = Array.from({ length: 100 }, (_, index) => ({
      at: new Date(Date.UTC(2026, 0, 100 - index)).toISOString(),
      repo: `r${index % 2}`, value: index, direction: 'increase',
      metrics: { quality: index, coverage: index / 2 }
    }));
    const parse = vi.spyOn(Date, 'parse');
    const result = projectTemporalSeries(rows, {
      time: 'at', series: 'repo',
      shape: /** @type {'tidy'|'groups'|'panels'} */ (shape),
      carry: ['direction'],
      measures: [{ field: 'value', kind: 'primary' }],
      maps: [{ field: 'metrics', kind: 'diagnostic' }],
      ...(shape === 'groups' ? { trend: { direction: 'direction' } } : {})
    });
    expect(result.length).toBeGreaterThan(0);
    expect(parse).toHaveBeenCalledTimes(rows.length);
  });

  it('preserves first-seen labels and stable chronological ties across offsets', () => {
    const result = projectTemporalSeries([
      { at: '2026-01-03T00:00:00Z', repo: 'z', metrics: { v: 7 }, labels: [{ id: 'v', name: 'Original' }] },
      { at: '2026-01-01T01:00:00+01:00', repo: 'z', metrics: { v: -10 } },
      { at: '2026-01-01T00:00:00Z', repo: 'a', metrics: { v: -5 } },
      { at: 'invalid', repo: 'z', metrics: { v: 100 } },
      { at: '2026-01-02', repo: 'z', metrics: { v: null } }
    ], {
      time: 'at', series: 'repo', shape: 'groups',
      maps: [{ field: 'metrics', definitions: 'labels', kind: 'diagnostic' }],
      trend: { direction: 'direction' }
    });
    expect(result).toEqual([{
      metric: 'v', 'metric-key': 'diagnostic:metrics:v', 'metric-name': 'Original',
      'metric-kind': 'diagnostic', 'metric-group': 'metrics',
      points: [
        { x: '2026-01-01T01:00:00+01:00', y: -10, color: 'z', key: 'diagnostic:metrics:v:1' },
        { x: '2026-01-01T00:00:00Z', y: -5, color: 'a', key: 'diagnostic:metrics:v:2' },
        { x: '2026-01-03T00:00:00Z', y: 7, color: 'z', key: 'diagnostic:metrics:v:0' }
      ],
      'trend-start-value': -10, 'trend-end-value': 7, 'trend-delta': 17,
      'trend-relative-percent': 170, 'trend-observed-direction': 'up',
      'trend-assessment': 'neutral', 'trend-observation-count': 3
    }]);
  });

  it.each(['tidy', 'groups', 'panels'])('bounds expanded points, not final %s rows', (shape) => {
    const rows = Array.from({ length: 50_000 }, () => ({ at: '2026-01-01', repo: 'r', value: 1 }));
    const definition = {
      time: 'at', series: 'repo',
      shape: /** @type {'tidy'|'groups'|'panels'} */ (shape),
      measures: [{ field: 'value', kind: 'first' }, { field: 'value', kind: 'second' }]
    };
    const result = projectTemporalSeries(rows, definition);
    expect(result).toHaveLength(shape === 'tidy' ? 100_000 : 2);
    expect(() => projectTemporalSeries([...rows, rows[0]], definition)).toThrow('100000-row output limit');
  });
});
