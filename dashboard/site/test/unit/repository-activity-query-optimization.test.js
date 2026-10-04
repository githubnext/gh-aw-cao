import 'fake-indexeddb/auto';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processDataRequest } from '../../src/data-worker.js';
import {
  createDashboardQueryBudget,
  executeDashboardQueries,
  resolveDashboardQuerySources
} from '../../src/data/queries/declarative.js';
import { compileDashboardViewPayloadQueries } from '../../src/data/queries/view-payload-compiler.js';
import { DATABASE_NAME } from '../../src/data/storage/indexeddb.js';
import { authoritativeDashboard } from '../authoritative-dashboard.js';
import { publishedToolMeasures } from '../tool-fixtures.js';

/** @typedef {import('../../src/presenter.js').LogicalSourceInput} Source */
/** @typedef {import('../../src/data/queries/declarative.js').DashboardQuery} Query */

const dashboard = authoritativeDashboard.dashboard;
/** @type {Query[]} */
const queries = dashboard.queries;
const canonicalNames = ['repositories', 'workflows', 'runs', 'outcomes', 'audits', 'domains', 'tools', 'issues'];
const publicNames = [
  'repository-workflow-totals', 'repository-report-totals',
  'repository-run-totals', 'repository-activity-core', 'repository-activity'
];
/** @type {import('../../src/data/queries/view-payload-compiler.js').GlobalQueryContext[]} */
const contexts = [
  { timeWindow: { start: '2026-09-01T00:00:00Z', end: '2026-09-24T00:00:00Z' } },
  { timeWindow: { start: '2026-09-20T00:00:00Z', end: '2026-09-20T00:00:10Z' } },
  { timeWindow: { start: '2026-09-20T00:00:00Z', end: '2026-09-24T00:00:00Z' } },
  { filters: { organization: ['other'] } },
  { filters: { 'rollout-mode': ['review'], organization: ['org'] } },
  { search: { fields: ['repository'], query: 'alpha' } }
];

/** @type {Query} */
const originalRunTotals = {
  name: 'repository-run-totals',
  from: 'run-import-status',
  aggregate: {
    by: ['organization', 'repository'],
    values: [
      { field: 'run', as: 'runs', reducer: 'distinct-count' },
      {
        field: 'run-conclusion', as: 'failed', reducer: 'count',
        filter: { predicates: [{ field: 'run-conclusion', in: ['failure', 'startup-failure', 'timed-out'] }] }
      },
      {
        field: 'run-conclusion', as: 'action-required', reducer: 'count',
        filter: { predicates: [{ field: 'run-conclusion', equals: 'action-required' }] }
      },
      { field: 'imported', as: 'imported-runs', reducer: 'sum' }
    ]
  }
};
const baseline = queries.map((query) => {
  if (query.name === originalRunTotals.name) return originalRunTotals;
  if (query.name !== 'repository-activity') return query;
  return {
    ...query,
    joins: query.joins?.map((join) => ({ ...join, source: 'repository-aic-totals' }))
  };
});

/** @param {string} name @param {Record<string, unknown>[]} rows */
function source(name, rows) {
  return {
    source: name, rows,
    metadata: {
      'source-id': name, 'source-kind': 'fixture',
      'as-of': '2026-09-24T00:00:00Z', 'retrieved-at': '2026-09-24T01:00:00Z',
      availability: rows.length ? 'available' : 'empty',
      completeness: 'complete', freshness: 'fresh'
    }
  };
}

function fixture() {
  const repositories = [
    ['org', 'alpha'], ['other', 'alpha'], ['org', 'approval'], ['org', 'running'],
    ['org', 'disabled'], ['org', 'reported'], ['org', 'empty']
  ].map(([organization, repository]) => ({
    organization, repository,
    'repository-link': { href: `https://github.com/${organization}/${repository}`, relation: 'repository' }
  }));
  const workflows = repositories.filter((row) => row.repository !== 'empty').map((row) => ({
    ...row, workflow: '.github/workflows/worker.md',
    'workflow-active': ['disabled', 'alpha', 'running'].includes(row.repository) ? 'false' : 'true',
    'rollout-mode': 'review'
  }));
  /** @param {string} repository @param {string} run @param {string} conclusion @param {number | null} aic */
  const run = (repository, run, conclusion, aic) => ({
    organization: 'org', repository, workflow: '.github/workflows/worker.md',
    run, 'run-attempt': 1, 'run-conclusion': conclusion, 'run-status': 'completed',
    'started-at': '2026-09-20T00:00:00Z', 'aic-total': aic, 'rollout-mode': 'review'
  });
  const runs = [
    run('alpha', '100', 'success', 3),
    run('alpha', '101', 'failure', 2),
    run('alpha', '102', 'startup-failure', 5),
    run('alpha', '103', 'timed-out', 7),
    run('alpha', '104', 'stale', 11),
    run('alpha', '105', 'action-required', 13),
    { ...run('alpha', '106', 'success', 29), organization: 'other' },
    run('approval', '200', 'action-required', null),
    run('running', '300', 'cancelled', 0),
    { ...run('reported', '400', 'success', 17), 'started-at': '2026-09-01T00:00:00Z' }
  ];
  /** @param {string} run @param {string} event @param {string} [type] */
  const record = (run, event, type = 'tool.call') => ({
    run, 'run-attempt': 1, event, 'event-source': 'fixture', 'event-type': type,
    'event-timestamp': '2026-09-20T00:00:10Z', 'event-summary': 'Retained evidence',
    'safe-output-type': 'create_issue',
    'safe-output-url': type === 'safe_output.created' ? `https://github.com/org/evidence/issues/${run}` : undefined
  });
  return {
    repositories: source('repositories', repositories),
    workflows: source('workflows', workflows),
    runs: source('runs', runs),
    audits: source('audits', [record('100', 'audit-one'), record('100', 'audit-two')]),
    domains: source('domains', [record('101', 'domain-one')]),
    tools: source('tools', [{
      ...record('102', 'tool-one'), ...publishedToolMeasures, id: 'tool-one', 'tool-id': 'observed-tool:fixture',
      'last-event-timestamp': '2026-09-20T00:00:10Z'
    }]),
    'tool-identities': source('tool-identities', [{ id: 'observed-tool:fixture', name: 'fixture' }]),
    issues: source('issues', [
      record('103', 'issue-one', 'safe_output.created'),
      record('300', 'issue-two', 'safe_output.created'),
      record('400', 'issue-three', 'safe_output.created')
    ])
  };
}

/** @param {Record<string, unknown>} [inputs] */
async function canonicalSources(inputs = fixture()) {
  return /** @type {Record<string, Source>} */ (await processDataRequest({
    operation: 'load-dashboard-query-sources',
    ingest: true, sources: inputs, queries: [], sourceNames: canonicalNames
  }));
}

/** @param {Query[] | Record<string, unknown>[]} definitions @param {Record<string, Source>} sources @param {string[]} [names] */
function workerQuery(definitions, sources, names = publicNames) {
  const results = /** @type {Record<string, Source>} */ (processDataRequest({
    operation: 'execute-dashboard-queries', queries: definitions, sources, sourceNames: names
  }));
  return Object.fromEntries(names.map((name) => [name, {
    rows: results[name].rows, metadata: results[name].metadata
  }]));
}

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-24T00:00:00Z'));
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
});

afterEach(() => vi.restoreAllMocks());

describe('repository activity query optimization', () => {
  it('preserves every existing repository output and metadata through canonical ingestion and the worker boundary', async () => {
    const sources = await canonicalSources();
    const optimized = workerQuery(queries, sources);
    expect(optimized).toEqual(workerQuery(baseline, sources));
    expect(optimized['repository-run-totals'].rows).toContainEqual({
      organization: 'org', repository: 'alpha', runs: 6, failed: 3, 'action-required': 1, 'imported-runs': 4
    });
    const rows = optimized['repository-activity'].rows;
    expect(rows.map((row) => row.repository)).toEqual([
      'org/alpha', 'org/approval', 'org/reported', 'org/running', 'other/alpha', 'org/disabled', 'org/empty'
    ]);
    expect(rows[0]).toMatchObject({
      repository: 'org/alpha', 'repository-name': 'alpha', workflows: 1, runs: 6,
      reports: 1, failed: 3, aic: 41, ingestion: '66.7%', 'failure-summary': '50% · 3 failed',
      status: 'Needs attention',
      'repository-link': {
        href: 'https://github.com/org/alpha',
        'dashboard-href': '#page-repository-detail?repository=org%2Falpha',
        'dashboard-label': 'View org/alpha repository dashboard'
      }
    });
    expect(rows.map((row) => row.status)).toEqual([
      'Needs attention', 'Approval required', 'No failures observed', 'No failures observed',
      'No failures observed', 'Disabled workflows', 'No recent activity'
    ]);
    expect(rows.at(-1)).toMatchObject({
      workflows: 0, runs: 0, reports: null, aic: 0, ingestion: null, 'failure-summary': '—'
    });
  });

  it('preserves weakest quality and oldest provenance for optional imported evidence', async () => {
    const sources = await canonicalSources();
    sources.audits.metadata = {
      ...sources.audits.metadata, completeness: 'partial', freshness: 'stale',
      'as-of': '2026-09-01T00:00:00Z', 'retrieved-at': '2026-09-02T00:00:00Z'
    };
    const result = workerQuery(queries, sources);
    expect(result).toEqual(workerQuery(baseline, sources));
    expect(result['repository-activity'].metadata).toMatchObject({
      completeness: 'partial', freshness: 'stale',
      'as-of': '2026-09-01T00:00:00Z', 'retrieved-at': '2026-09-02T00:00:00Z'
    });
  });

  it.each(canonicalNames)('preserves rows and quality when canonical %s is unavailable or missing', async (name) => {
    const sources = await canonicalSources();
    sources[name] = {
      ...sources[name], rows: [],
      metadata: { ...sources[name].metadata, availability: 'unavailable', completeness: 'unknown' }
    };
    for (const missing of [false, true]) {
      if (missing) delete sources[name];
      const optimized = workerQuery(queries, sources, ['repository-activity'])['repository-activity'];
      const original = workerQuery(baseline, sources, ['repository-activity'])['repository-activity'];
      expect(optimized.rows).toEqual(original.rows);
      expect(optimized.metadata).toEqual(original.metadata);
    }
  });

  it('retains AIC and explicit partial quality when every import branch is unavailable', async () => {
    const sources = await canonicalSources();
    for (const name of ['audits', 'domains', 'tools', 'issues']) {
      sources[name] = {
        ...sources[name], rows: [],
        metadata: { ...sources[name].metadata, availability: 'unavailable' }
      };
    }
    const result = workerQuery(queries, sources);
    expect(result).toEqual(workerQuery(baseline, sources));
    expect(result['repository-activity'].rows[0]).toMatchObject({ aic: 41, ingestion: '0%' });
    expect(result['repository-activity'].metadata).toMatchObject({ availability: 'available', completeness: 'partial' });
  });

  it('preserves an empty canonical inventory without claiming availability', async () => {
    const inputs = Object.fromEntries(Object.entries(fixture()).map(([name]) => [name, source(name, [])]));
    const sources = await canonicalSources(inputs);
    const result = workerQuery(queries, sources);
    expect(result).toEqual(workerQuery(baseline, sources));
    expect(result['repository-activity']).toMatchObject({ rows: [], metadata: { availability: 'empty' } });
  });

  it.each(contexts)('preserves scoped view payloads for %j', async (queryContext) => {
    const sources = await canonicalSources();
    const page = { views: [{ id: 'activity', mark: 'table', data: { source: 'repository-activity' } }] };
    /** @param {Query[]} definitions */
    const scoped = (definitions) => {
      const payload = compileDashboardViewPayloadQueries(page, 'repositories', {
        queries: definitions, queryContext, evaluatedAt: '2026-09-24T00:00:00Z'
      });
      return workerQuery(payload.queries, sources, payload.aliases);
    };
    const result = scoped(queries);
    expect(result).toEqual(scoped(baseline));
    for (const value of Object.values(result)) expect(value.metadata.availability).not.toBe('unavailable');
    if (queryContext.filters?.organization?.[0] === 'other') {
      expect(Object.values(result)[0].rows.map((row) => row.repository)).toEqual(['other/alpha']);
    }
    if (queryContext.timeWindow?.start === '2026-09-20T00:00:00Z'
        && queryContext.timeWindow.end === '2026-09-24T00:00:00Z') {
      expect(Object.values(result)[0].rows).toContainEqual(expect.objectContaining({
        repository: 'org/reported', runs: 0, reports: 1, status: 'Outcomes observed'
      }));
    }
  });

  it('reduces the complete dependency graph and measured row work without narrowing canonical evidence', async () => {
    const sources = await canonicalSources();
    const originalInputs = resolveDashboardQuerySources(baseline, ['repository-activity']).filter((name) => canonicalNames.includes(name));
    const optimizedInputs = resolveDashboardQuerySources(queries, ['repository-activity']).filter((name) => canonicalNames.includes(name));
    expect(optimizedInputs.toSorted()).toEqual(originalInputs.toSorted());
    /** @param {Query[]} definitions */
    const measure = (definitions) => {
      const budget = createDashboardQueryBudget();
      const result = executeDashboardQueries(definitions, sources, ['repository-activity'], { budget })['repository-activity'];
      return { rows: result.rows, operations: budget.operations };
    };
    const original = measure(baseline);
    const optimized = measure(queries);
    expect(optimized.rows).toEqual(original.rows);
    expect(original.operations - optimized.operations).toBe(sources.runs.rows.length);

    const estimates = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { readFileSync } from 'node:fs';
      import { analyzeDashboardComplexity } from '../../activity/dashboard-complexity.mjs';
      const definitions = JSON.parse(readFileSync(0, 'utf8'));
      console.log(JSON.stringify(definitions.map((queries) =>
        analyzeDashboardComplexity({ dashboard: { queries } }).inventory.find((query) => query.name === 'repository-activity')
      )));
    `], { input: JSON.stringify([baseline, queries]), encoding: 'utf8' }));
    expect(estimates[0]).toMatchObject({ 'total-row-read-units': 53, 'total-materialized-field-units': 155 });
    expect(estimates[1]).toMatchObject({ 'total-row-read-units': 52, 'total-materialized-field-units': 93 });
  });
});
