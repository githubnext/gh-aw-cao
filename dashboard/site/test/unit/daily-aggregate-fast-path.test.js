import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { queryDailyOverviewAggregateSources } from '../../src/data/queries/daily-aggregate-fast-path.js';
import { publishDailyOverviewAggregates } from '../../src/data/storage/indexeddb.js';

/** The exact live shape of `overview-dispatch-summary` from dashboard.json. */
function dispatchSummaryQuery(overrides = {}) {
  return {
    name: 'overview-dispatch-summary',
    intent: 'Count workflow dispatch runs and failures in the selected horizon.',
    from: 'runs',
    filter: { predicates: [{ field: 'event', equals: 'workflow_dispatch' }] },
    aggregate: {
      values: [
        { field: 'run', as: 'dispatches', reducer: 'count' },
        {
          field: 'run-conclusion',
          as: 'failed-dispatches',
          reducer: 'count',
          filter: { predicates: [{ field: 'run-conclusion', in: ['failure', 'startup-failure', 'stale', 'timed-out'] }] }
        }
      ]
    },
    ...overrides
  };
}

/** The exact live shape of `overview-failed-run-count` from dashboard.json. */
function failedRunCountQuery(overrides = {}) {
  return {
    name: 'overview-failed-run-count',
    intent: 'Count failed workflow runs that need operator attention.',
    from: 'runs',
    filter: { predicates: [{ field: 'run-conclusion', in: ['failure', 'startup-failure', 'stale', 'timed-out'] }] },
    aggregate: {
      values: [{ field: 'run', as: 'count', reducer: 'count' }]
    },
    ...overrides
  };
}

/**
 * @param {string} day
 * @param {Partial<Record<string, unknown>>} [overrides]
 */
function dailyAggregate(day, overrides = {}) {
  return {
    day,
    runs: 10,
    successfulRuns: 8,
    failedRuns: 2,
    dispatches: 4,
    failedDispatches: 1,
    runsByConclusion: { success: 8, failure: 2 },
    ...overrides
  };
}

describe('queryDailyOverviewAggregateSources', () => {
  it('returns nothing when no requested name is eligible', async () => {
    const indexedDB = new IDBFactory();
    const result = await queryDailyOverviewAggregateSources(
      indexedDB,
      [dispatchSummaryQuery()],
      ['overview-run-summary']
    );
    expect(result).toEqual({});
  });

  it('returns nothing when the query definition is missing', async () => {
    const indexedDB = new IDBFactory();
    const result = await queryDailyOverviewAggregateSources(indexedDB, [], ['overview-dispatch-summary']);
    expect(result).toEqual({});
  });

  it('falls back when the live query shape has drifted from the known-safe shape', async () => {
    const indexedDB = new IDBFactory();
    await publishDailyOverviewAggregates(indexedDB, {
      generation: 'generation-a',
      dailyAggregates: [dailyAggregate('2026-09-10')]
    });
    const drifted = dispatchSummaryQuery({
      joins: [{ from: 'workflows', on: [] }]
    });
    const result = await queryDailyOverviewAggregateSources(indexedDB, [drifted], ['overview-dispatch-summary']);
    expect(result).toEqual({});
  });

  it('falls back when no aggregate generation has ever been published', async () => {
    const indexedDB = new IDBFactory();
    const result = await queryDailyOverviewAggregateSources(
      indexedDB,
      [dispatchSummaryQuery()],
      ['overview-dispatch-summary']
    );
    expect(result).toEqual({});
  });

  it('sums the full published day range for the eligible query', async () => {
    const indexedDB = new IDBFactory();
    await publishDailyOverviewAggregates(indexedDB, {
      generation: 'generation-a',
      dailyAggregates: [
        dailyAggregate('2026-09-10', { dispatches: 4, failedDispatches: 1 }),
        dailyAggregate('2026-09-11', { dispatches: 6, failedDispatches: 2 })
      ]
    });

    const result = await queryDailyOverviewAggregateSources(
      indexedDB,
      [dispatchSummaryQuery()],
      ['overview-dispatch-summary', 'overview-run-summary']
    );

    expect(Object.keys(result)).toEqual(['overview-dispatch-summary']);
    expect(result['overview-dispatch-summary'].rows).toEqual([{ dispatches: 10, 'failed-dispatches': 3 }]);
    expect(result['overview-dispatch-summary'].metadata).toMatchObject({
      'source-kind': 'derived',
      availability: 'available',
      generation: 'generation-a',
      'aggregate-version': 2
    });
  });

  it('sums the full published day range for overview-failed-run-count', async () => {
    const indexedDB = new IDBFactory();
    await publishDailyOverviewAggregates(indexedDB, {
      generation: 'generation-a',
      dailyAggregates: [
        dailyAggregate('2026-09-10', { failedRuns: 2 }),
        dailyAggregate('2026-09-11', { failedRuns: 3 })
      ]
    });

    const result = await queryDailyOverviewAggregateSources(
      indexedDB,
      [failedRunCountQuery()],
      ['overview-failed-run-count']
    );

    expect(Object.keys(result)).toEqual(['overview-failed-run-count']);
    expect(result['overview-failed-run-count'].rows).toEqual([{ count: 5 }]);
    expect(result['overview-failed-run-count'].metadata).toMatchObject({
      'source-kind': 'derived',
      availability: 'available',
      generation: 'generation-a',
      'aggregate-version': 2
    });
  });

  it('falls back for overview-failed-run-count when the shape has drifted', async () => {
    const indexedDB = new IDBFactory();
    await publishDailyOverviewAggregates(indexedDB, {
      generation: 'generation-a',
      dailyAggregates: [dailyAggregate('2026-09-10')]
    });
    const drifted = failedRunCountQuery({
      aggregate: { values: [{ field: 'run', as: 'count', reducer: 'distinct-count' }] }
    });
    const result = await queryDailyOverviewAggregateSources(indexedDB, [drifted], ['overview-failed-run-count']);
    expect(result).toEqual({});
  });

  it('resolves both eligible queries independently in one call', async () => {
    const indexedDB = new IDBFactory();
    await publishDailyOverviewAggregates(indexedDB, {
      generation: 'generation-a',
      dailyAggregates: [
        dailyAggregate('2026-09-10', { dispatches: 4, failedDispatches: 1, failedRuns: 2 }),
        dailyAggregate('2026-09-11', { dispatches: 6, failedDispatches: 2, failedRuns: 3 })
      ]
    });

    const result = await queryDailyOverviewAggregateSources(
      indexedDB,
      [dispatchSummaryQuery(), failedRunCountQuery()],
      ['overview-dispatch-summary', 'overview-failed-run-count']
    );

    expect(Object.keys(result).sort()).toEqual(['overview-dispatch-summary', 'overview-failed-run-count']);
    expect(result['overview-dispatch-summary'].rows).toEqual([{ dispatches: 10, 'failed-dispatches': 3 }]);
    expect(result['overview-failed-run-count'].rows).toEqual([{ count: 5 }]);
  });

  it('returns weighted daily conclusion rows for an aliased Runs swimlane query', async () => {
    const indexedDB = new IDBFactory();
    await publishDailyOverviewAggregates(indexedDB, {
      generation: 'generation-a',
      dailyAggregates: [
        dailyAggregate('2026-09-10', { runsByConclusion: { success: 8, failure: 2 } }),
        dailyAggregate('2026-09-11', { runsByConclusion: { success: 6, cancelled: 4 } })
      ]
    });
    const query = {
      name: 'view:runs:runs-last-week:runs-daily-conclusions',
      from: 'runs',
      filter: {
        predicates: [
          { field: '@time', gte: '2026-09-10T12:00:00Z' },
          { field: '@time', lt: '2026-09-11T12:00:00Z' }
        ]
      },
      compute: [{
        as: 'day',
        function: 'date-day',
        args: [{ field: 'started-at' }]
      }],
      aggregate: {
        by: ['day', 'run-conclusion'],
        values: [{ field: 'run', as: 'runs', reducer: 'count' }]
      }
    };

    const result = await queryDailyOverviewAggregateSources(indexedDB, [query], [query.name]);

    expect(result[query.name].rows).toEqual([
      { day: '2026-09-10', 'run-conclusion': 'success', runs: 8 },
      { day: '2026-09-10', 'run-conclusion': 'failure', runs: 2 },
      { day: '2026-09-11', 'run-conclusion': 'success', runs: 6 },
      { day: '2026-09-11', 'run-conclusion': 'cancelled', runs: 4 }
    ]);
    expect(result[query.name].metadata).toMatchObject({
      'execution-path': 'daily-aggregate',
      'aggregate-version': 2
    });
  });
});
