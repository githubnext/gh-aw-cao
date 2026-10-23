// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DAILY_WORKFLOW_METRICS, rebuildDailyWorkflowAggregates } from '../../src/data/model/daily-workflow-aggregates.js';
import { DATABASE_NAME, openCanonicalDatabase, upsertCanonicalBatch } from '../../src/data/storage/indexeddb.js';
import { normalize } from '../../src/data/normalize/index.js';
import { queryDatabaseSources } from '../../src/data/queries/database.js';
import { executeDashboardQueries } from '../../src/data/queries/declarative.js';
import { createCanonicalQueries } from '../../src/data/queries/index.js';
import { compileDashboardQueryTypes } from '../../src/query-type-checker.js';
import { TABLE_FIELDS } from '../../src/specification.js';
import { authoritativeDashboard } from '../authoritative-dashboard.js';

const now = Date.parse('2026-10-23T12:00:00Z');
const metadata = {
  'as-of': '2026-10-23T12:00:00Z', completeness: 'partial', freshness: 'fresh'
};

/** @param {Record<string, unknown[]>} records */
async function put(records) {
  const database = await openCanonicalDatabase(indexedDB);
  try {
    const transaction = database.transaction(Object.keys(records), 'readwrite');
    for (const [name, rows] of Object.entries(records)) {
      for (const row of rows) transaction.objectStore(name).put(row);
    }
    await new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve(undefined);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

beforeEach(async () => {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
});

describe('retained UTC daily workflow query source', () => {
  it('counts canonical Run identities rather than historical attempts', async () => {
    for (const attempt of [1, 2]) {
      await upsertCanonicalBatch(indexedDB, {
        ...normalize([]),
        repositories: [{ id: 'repo' }],
        workflows: [{ id: 'workflow', repositoryId: 'repo' }],
        runs: [{
          id: 'same-run', repositoryId: 'repo', workflowId: 'workflow',
          startedAt: '2026-10-22T12:00:00Z', attempt, aicTotal: attempt + 1
        }]
      }, { now, validateRelationships: false });
    }
    const sources = await queryDatabaseSources(indexedDB, {}, ['daily-workflow-aggregates']);
    expect(sources['daily-workflow-aggregates'].rows).toMatchObject([{
      'run-count': 1, 'aic-total-sum': 3, 'aic-total-observed-count': 1
    }]);
  });

  it('matches real tool/domain measurements without replacing them with MCP or firewall totals', async () => {
    await upsertCanonicalBatch(indexedDB, {
      ...normalize([]),
      repositories: [{ id: 'repo', owner: 'owner', name: 'repository' }],
      workflows: [{ id: 'workflow', repositoryId: 'repo', path: '.github/workflows/test.md' }],
      runs: [{
        id: 'run', repositoryId: 'repo', workflowId: 'workflow', owner: 'owner',
        repository: 'repository', workflowPath: '.github/workflows/test.md', githubRunId: 1,
        startedAt: '2026-10-22T12:00:00Z', mcpToolCalls: 100, firewallAllowedCalls: 200
      }],
      tools: [2, 0, null, undefined].map((invocationCount, index) => ({
        id: `tool-${index}`, runId: 'run', timestamp: '2026-10-22T12:00:00Z',
        ...(invocationCount === undefined ? {} : { invocationCount })
      })),
      domains: [4, 0, null, undefined].map((requestCount, index) => ({
        id: `domain-${index}`, runId: 'run', timestamp: '2026-10-22T12:00:00Z',
        ...(requestCount === undefined ? {} : { requestCount })
      }))
    }, { now, validateRelationships: false });
    const sources = await queryDatabaseSources(indexedDB, {}, ['daily-workflow-aggregates', 'tools', 'domains']);
    for (const [source, detailField, metric] of [
      ['tools', 'invocation-count', 'tool-calls'],
      ['domains', 'request-count', 'domain-calls']
    ]) {
      const result = executeDashboardQueries([{
        name: 'detail', from: source, aggregate: { values: [
          { field: detailField, as: 'calls', reducer: 'sum' },
          { field: detailField, as: 'observed', reducer: 'count' }
        ] }
      }, {
        name: 'daily', from: 'daily-workflow-aggregates', aggregate: { values: [
          { field: `${metric}-sum`, as: 'calls', reducer: 'sum' },
          { field: `${metric}-observed-count`, as: 'observed', reducer: 'sum' }
        ] }
      }], sources, ['detail', 'daily']);
      expect(result.daily.rows, source).toEqual(result.detail.rows);
      expect(result.daily.rows).toEqual([{ calls: source === 'tools' ? 2 : 4, observed: 2 }]);
    }
    expect(sources['daily-workflow-aggregates'].rows[0]).toMatchObject({
      'run-count': 1, 'mcp-tool-calls-sum': 100, 'firewall-allowed-calls-sum': 200,
      'tool-calls-observed-count': 2, 'domain-calls-observed-count': 2
    });
  });

  it('preserves additive recorded outcomes while keeping absent conclusions unobserved', async () => {
    const groups = [
      { field: 'success-count', as: 'successful', conclusions: ['success'] },
      { field: 'failure-count', as: 'failed', conclusions: ['failure'] },
      { field: 'cancelled-count', as: 'cancelled', conclusions: ['cancelled'] },
      { field: 'skipped-count', as: 'skipped', conclusions: ['skipped'] },
      { field: 'timed-out-count', as: 'timed-out', conclusions: ['timed_out'] },
      { field: 'action-required-count', as: 'action-required', conclusions: ['action_required'] },
      { field: 'neutral-count', as: 'neutral', conclusions: ['neutral'] },
      { field: 'startup-failure-count', as: 'startup-failure', conclusions: ['startup_failure'] }
    ];
    const recognized = groups.flatMap(({ conclusions }) => conclusions);
    const recorded = [...recognized, 'timed-out', 'action-required', 'startup-failure', 'unrecognized'];
    const runs = [...recorded, '', '   ', null, undefined]
      .map((conclusion, index) => ({
        id: `outcome-${index}`, repositoryId: 'repo', workflowId: 'workflow',
        startedAt: '2026-10-22T12:00:00Z', ...(conclusion === undefined ? {} : { conclusion })
      }));
    await put(rebuildDailyWorkflowAggregates(runs, now));
    const sources = await queryDatabaseSources(indexedDB, {}, ['daily-workflow-aggregates']);
    const detail = {
      name: 'detail', from: 'detail-input', aggregate: { values: [
        { field: 'id', as: 'runs', reducer: 'count' },
        ...groups.map(({ conclusions, as }) => ({
          field: 'id', as, reducer: 'count', filter: { predicates: [{ field: 'conclusion', in: conclusions }] }
        })),
        {
          field: 'conclusion', as: 'observed', reducer: 'count',
          filter: { predicates: [{ field: 'conclusion', in: recorded }] }
        }
      ] }
    };
    const daily = {
      name: 'daily', from: 'daily-workflow-aggregates', aggregate: { values: [
        { field: 'run-count', as: 'runs', reducer: 'sum' },
        ...groups.map(({ field, as }) => ({ field, as, reducer: 'sum' })),
        { field: 'observed-conclusion-count', as: 'observed', reducer: 'sum' }
      ] }
    };
    const result = executeDashboardQueries([detail, daily], {
      ...sources, 'detail-input': { source: 'detail-input', rows: runs, metadata: sources['daily-workflow-aggregates'].metadata }
    }, ['detail', 'daily']);
    expect(result.daily.rows).toEqual(result.detail.rows);
    expect(result.daily.rows).toEqual([{
      runs: 16, successful: 1, failed: 1, cancelled: 1, skipped: 1, 'timed-out': 1,
      'action-required': 1, neutral: 1, 'startup-failure': 1, observed: 12
    }]);
  });

  it('matches detailed additive totals and known counts without treating null or absent telemetry as measured zero', async () => {
    const runs = [
      { id: 'one', repositoryId: 'repo', workflowId: 'workflow', startedAt: '2026-10-21T23:59:59Z', aicTotal: 5, inputTokens: 10 },
      { id: 'two', repositoryId: 'repo', workflowId: 'workflow', startedAt: '2026-10-22T00:00:00Z', aicTotal: 0, inputTokens: null },
      { id: 'three', repositoryId: 'repo', workflowId: 'workflow', startedAt: '2026-10-22T12:00:00Z', aicTotal: null },
      { id: 'four', repositoryId: 'repo', workflowId: 'workflow', startedAt: '2026-10-23T00:00:00Z' },
      { id: 'outside-retention', repositoryId: 'repo', workflowId: 'workflow', startedAt: '2026-10-01T12:00:00Z', aicTotal: 1000 }
    ];
    await put({
      ...rebuildDailyWorkflowAggregates(runs, now),
      repositories: [{ id: 'repo', owner: 'owner', name: 'repository' }],
      workflows: [{ id: 'workflow', repositoryId: 'repo', path: '.github/workflows/test.md' }]
    });
    /** @type {Parameters<typeof queryDatabaseSources>[3]} */
    const metrics = { onMetrics: (value) => {
      expect(value.stores).toEqual(['daily_workflow_aggregates', 'repositories', 'workflows']);
      expect(value.recordsRead).toBe(5);
    } };
    const sources = await queryDatabaseSources(indexedDB, {
      daily_workflow_aggregates: { metadata }
    }, ['daily-workflow-aggregates'], metrics);
    const daily = sources['daily-workflow-aggregates'];
    expect(Object.keys(sources)).toEqual(['daily-workflow-aggregates']);
    expect(daily.metadata).toMatchObject({ completeness: 'partial', freshness: 'fresh' });
    expect(daily.rows).toHaveLength(3);
    expect(daily.rows[2]).toMatchObject({
      date: '2026-10-23', organization: 'owner', repository: 'repository',
      workflow: '.github/workflows/test.md', 'run-count': 1,
      'aic-total-sum': null, 'aic-total-observed-count': 0
    });

    for (const metric of DAILY_WORKFLOW_METRICS) {
      const field = metric.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      const detailQuery = {
        name: 'detail', from: 'detail-input',
        filter: { predicates: [
          { field: 'startedAt', gte: '2026-10-21T00:00:00Z' },
          { field: 'startedAt', lt: '2026-10-24T00:00:00Z' }
        ] },
        aggregate: { values: [
          { field: 'id', as: 'runs', reducer: 'count' },
          { field: metric, as: 'sum', reducer: 'sum' },
          { field: metric, as: 'known', reducer: 'count' }
        ] }
      };
      const dailyQuery = {
        name: 'daily', from: 'daily-workflow-aggregates',
        filter: { predicates: [
          { field: 'date', gte: '2026-10-21' },
          { field: 'date', lt: '2026-10-24' }
        ] },
        aggregate: { values: [
          { field: 'run-count', as: 'runs', reducer: 'sum' },
          { field: `${field}-sum`, as: 'sum', reducer: 'sum' },
          { field: `${field}-observed-count`, as: 'known', reducer: 'sum' }
        ] }
      };
      const result = executeDashboardQueries([detailQuery, dailyQuery], {
        ...sources, 'detail-input': { source: 'detail-input', rows: runs, metadata: daily.metadata }
      }, ['detail', 'daily']);
      expect(result.daily.rows, metric).toEqual(result.detail.rows);
      if (metric === 'aicTotal') expect(result.daily.rows).toEqual([{ runs: 4, sum: 5, known: 2 }]);
      if (metric === 'inputTokens') expect(result.daily.rows).toEqual([{ runs: 4, sum: 10, known: 1 }]);
    }
  });

  it('registers additive measures and indexed workflow/repository access without detailed run reads', async () => {
    await put(rebuildDailyWorkflowAggregates([
      { id: 'a', repositoryId: 'repo-a', workflowId: 'flow-a', startedAt: '2026-10-22T12:00:00Z', aicTotal: 0 },
      { id: 'b', repositoryId: 'repo-b', workflowId: 'flow-b', startedAt: '2026-10-22T12:00:00Z', aicTotal: 2 }
    ], now));
    const queries = createCanonicalQueries(indexedDB).dailyWorkflowAggregates;
    expect(await queries.forRepository('repo-a')).toMatchObject([{ repositoryId: 'repo-a', runCount: 1 }]);
    expect(await queries.forWorkflow('flow-b')).toMatchObject([{ workflowId: 'flow-b', aicTotalSum: 2 }]);
    expect(await queries.forDay('2026-10-22')).toHaveLength(2);
    expect(await queries.forWorkflow('missing')).toEqual([]);
    expect(compileDashboardQueryTypes([{
      name: 'bounded-daily-total', from: 'daily-workflow-aggregates',
      aggregate: { by: ['organization', 'repository', 'workflow'], values: [
        { field: 'run-count', as: 'runs', reducer: 'sum' },
        { field: 'aic-total-sum', as: 'aic', reducer: 'sum' },
        { field: 'aic-total-observed-count', as: 'known', reducer: 'sum' }
      ] }
    }]).errors).toEqual([]);
    expect(TABLE_FIELDS['daily-workflow-aggregates']).not.toContain('run-conclusion');
    expect(TABLE_FIELDS['daily-workflow-aggregates']).not.toContain('resolved-model');
    expect(TABLE_FIELDS['daily-workflow-aggregates']).not.toContain('event');
  });

  it('does not silently replace arbitrary retained-run horizons or incompatible detailed queries', () => {
    const queries = /** @type {import('../../src/data/queries/declarative.js').DashboardQuery[]} */ (authoritativeDashboard.dashboard.queries);
    for (const [name, from] of [
      ['indexing-runs-table-count', 'runs'],
      ['workflow-run-observation-counts', 'overview-runs']
    ]) {
      expect(queries.find((query) => query.name === name)).toMatchObject({ from });
      expect(queries.find((query) => query.name === name)?.time).toBeUndefined();
    }
    expect(queries.find((query) => query.name === 'overview-rhythm')).toMatchObject({
      from: 'overview-runs', time: { range: '15d' },
      aggregate: { values: [{ reducer: 'calendar-week-rhythm' }] }
    });
    expect(queries.find((query) => query.name === 'runs-daily-conclusions')).toMatchObject({
      from: 'runs', aggregate: { by: ['day', 'run-conclusion'] }
    });
  });
});
