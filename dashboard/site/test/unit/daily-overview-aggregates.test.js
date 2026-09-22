import { describe, expect, it } from 'vitest';
import { buildDailyOverviewAggregates, resolveRunUtcDay } from '../../src/data/analytics/daily-overview-aggregates.js';

/** @param {Partial<Record<string, unknown>>} overrides */
function run(overrides) {
  return {
    id: 'run-1',
    event: 'schedule',
    status: 'completed',
    conclusion: 'success',
    startedAt: '2026-09-10T00:00:00Z',
    createdAt: '2026-09-10T00:00:00Z',
    ...overrides
  };
}

describe('resolveRunUtcDay', () => {
  it('derives the UTC calendar day from startedAt', () => {
    expect(resolveRunUtcDay(run({ startedAt: '2026-09-10T23:59:59Z' }))).toBe('2026-09-10');
  });

  it('falls back to createdAt when startedAt is missing', () => {
    expect(resolveRunUtcDay(run({ startedAt: null, createdAt: '2026-09-11T01:00:00Z' }))).toBe('2026-09-11');
  });

  it('returns null for unparsable or missing timestamps', () => {
    expect(resolveRunUtcDay(run({ startedAt: null, createdAt: null }))).toBeNull();
    expect(resolveRunUtcDay(run({ startedAt: 'not-a-date', createdAt: null }))).toBeNull();
  });

  it('falls back to createdAt when startedAt is present but unparsable', () => {
    expect(resolveRunUtcDay(run({ startedAt: 'not-a-date', createdAt: '2026-09-12T00:00:00Z' }))).toBe('2026-09-12');
  });

  it('normalizes a boundary timestamp in a non-UTC offset to its UTC day', () => {
    // 2026-09-10T23:30:00-01:00 is 2026-09-11T00:30:00Z.
    expect(resolveRunUtcDay(run({ startedAt: '2026-09-10T23:30:00-01:00' }))).toBe('2026-09-11');
  });
});

describe('buildDailyOverviewAggregates', () => {
  it('returns an empty array for empty input', () => {
    expect(buildDailyOverviewAggregates([])).toEqual([]);
    expect(buildDailyOverviewAggregates(undefined)).toEqual([]);
  });

  it('groups runs deterministically by UTC day and sorts ascending', () => {
    const result = buildDailyOverviewAggregates([
      run({ id: 'r2', startedAt: '2026-09-11T00:00:00Z' }),
      run({ id: 'r1', startedAt: '2026-09-10T00:00:00Z' })
    ]);
    expect(result.map((record) => record.day)).toEqual(['2026-09-10', '2026-09-11']);
  });

  it('computes every supported additive metric', () => {
    const result = buildDailyOverviewAggregates([
      run({ id: 'r1', conclusion: 'success' }),
      run({ id: 'r2', conclusion: 'failure' }),
      run({ id: 'r3', event: 'workflow_dispatch', conclusion: 'success' }),
      run({ id: 'r4', event: 'workflow_dispatch', conclusion: 'timed-out' }),
      run({ id: 'r5', conclusion: 'stale' }),
      run({ id: 'r6', status: 'in_progress', conclusion: null })
    ]);
    expect(result).toEqual([
      {
        day: '2026-09-10',
        runs: 6,
        successfulRuns: 2,
        failedRuns: 3,
        dispatches: 2,
        failedDispatches: 1,
        runsByConclusion: {
          success: 2,
          failure: 1,
          'timed-out': 1,
          stale: 1,
          unknown: 1
        }
      }
    ]);
  });

  it('skips runs without a resolvable UTC day instead of corrupting a bucket', () => {
    const result = buildDailyOverviewAggregates([
      run({ id: 'r1', startedAt: null, createdAt: null }),
      run({ id: 'r2', startedAt: '2026-09-10T00:00:00Z' })
    ]);
    expect(result).toEqual([
      {
        day: '2026-09-10',
        runs: 1,
        successfulRuns: 1,
        failedRuns: 0,
        dispatches: 0,
        failedDispatches: 0,
        runsByConclusion: { success: 1 }
      }
    ]);
  });

  it('reports zero-valued days as absent rather than fabricating empty records', () => {
    // The pure aggregator only ever emits days that have at least one run;
    // callers of readDailyOverviewAggregates are responsible for filling
    // gaps in a requested date range with zero-valued days.
    const result = buildDailyOverviewAggregates([run({ id: 'r1' })]);
    expect(result).toHaveLength(1);
  });

  it('deduplicates canonical identities, keeping the last observation (replace semantics)', () => {
    const result = buildDailyOverviewAggregates([
      run({ id: 'r1', conclusion: 'failure' }),
      run({ id: 'r1', conclusion: 'success' }) // corrected/replaced record for the same id
    ]);
    expect(result).toEqual([
      {
        day: '2026-09-10',
        runs: 1,
        successfulRuns: 1,
        failedRuns: 0,
        dispatches: 0,
        failedDispatches: 0,
        runsByConclusion: { success: 1 }
      }
    ]);
  });

  it('is order-independent for a given set of canonical identities', () => {
    const a = buildDailyOverviewAggregates([
      run({ id: 'r1', conclusion: 'success' }),
      run({ id: 'r2', conclusion: 'failure' })
    ]);
    const b = buildDailyOverviewAggregates([
      run({ id: 'r2', conclusion: 'failure' }),
      run({ id: 'r1', conclusion: 'success' })
    ]);
    expect(a).toEqual(b);
  });
});
