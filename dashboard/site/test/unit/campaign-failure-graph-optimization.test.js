import 'fake-indexeddb/auto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { processDataRequest } from '../../src/data-worker.js';
import {
  createDashboardQueryBudget,
  executeDashboardQueries,
  resolveDashboardQuerySources
} from '../../src/data/queries/declarative.js';
import { compileDashboardViewPayloadQueries } from '../../src/data/queries/view-payload-compiler.js';
import { DATABASE_NAME } from '../../src/data/storage/indexeddb.js';
import { TABLE_FIELDS } from '../../src/specification.js';
import { authoritativeDashboard } from '../authoritative-dashboard.js';

/** @typedef {import('../../src/data/queries/declarative.js').DashboardQuery} Query */
/** @typedef {import('../../src/presenter.js').LogicalSourceInput} Source */
/** @typedef {import('../../src/presenter.js').SourceMetadata} Metadata */
/** @typedef {Omit<Source, 'metadata'> & { metadata?: Metadata }} Input */

const names = [
  'campaign-problem-tab-counts', 'campaign-problem-items',
  'campaign-current-problem-error-groups', 'campaign-problem-error-groups',
  'campaign-problem-latest-target-runs', 'campaign-problem-run-evidence'
];
/** @type {Query[]} */
const queries = authoritativeDashboard.dashboard.queries;

// Frozen a5f8c356b declaration, not the pre-first-pass graph.
const originalRuns = {
  name: 'campaign-runtime-health-runs', from: 'overview-runs',
  compute: [
    { as: 'status', function: 'coalesce', args: [{ field: 'run-conclusion' }, { field: 'run-status' }, { value: 'unknown' }] },
    { as: 'runtime-repository', function: 'concat', args: [{ field: 'organization' }, { value: '/' }, { field: 'repository' }] },
    { as: 'is-worker', function: 'equals-any', args: [{ field: 'workflow-role' }, { value: 'worker' }] },
    { as: 'is-orchestrator', function: 'equals-any', args: [{ field: 'workflow-role' }, { value: 'orchestrator' }] },
    { as: 'root-dispatch-type', function: 'if', args: [{ field: 'is-orchestrator' }, { value: 'Campaign orchestrator' }, { value: 'Standalone workflow' }] },
    { as: 'dispatch-type', function: 'if', args: [{ field: 'is-worker' }, { value: 'Campaign worker' }, { field: 'root-dispatch-type' }] }
  ],
  select: [
    'started-at', 'campaign', 'campaign-name', 'workflow', 'workflow-name', 'workflow-role',
    'dispatch-type', 'runtime-repository', 'run', 'run-status', 'status'
  ].map((field) => ({ field }))
};
const originalGroups = {
  name: 'campaign-runtime-health-groups',
  from: 'campaign-runtime-health-runs',
  filter: { predicates: [{ field: 'run-status', equals: 'completed' }] },
  compute: [
    {
      as: 'is-runtime-failure', function: 'equals-any',
      args: [
        { field: 'status' }, { value: 'failure' }, { value: 'startup-failure' },
        { value: 'stale' }, { value: 'timed-out' }
      ]
    },
    {
      as: 'runtime-failure-streak-point', function: 'failure-streak-point',
      args: [{ field: 'started-at' }, { field: 'run' }, { field: 'is-runtime-failure' }]
    }
  ],
  aggregate: {
    by: [
      'campaign', 'campaign-name', 'workflow', 'workflow-name',
      'workflow-role', 'dispatch-type', 'runtime-repository'
    ],
    values: [{ field: 'runtime-failure-streak-point', as: 'failure-count', reducer: 'latest-failure-streak' }]
  }
};
const baseline = queries.map((query) => query.name === 'campaign-runtime-streak-groups' ? originalRuns : query)
  .map((query) => query.name === originalGroups.name ? originalGroups : query);
const publicNames = [
  ...names, 'campaign-runs', 'campaign-problem-runs',
  'campaign-runtime-health-groups', 'campaign-runtime-problem-candidates',
  'campaign-current-runtime-failures', 'campaign-runtime-problems',
  'campaign-unobserved-orchestrators', 'workflow-run-observation-counts'
];

/** @param {string} name @param {Partial<Metadata>} [overrides] @returns {Metadata} */
function metadata(name, overrides = {}) {
  return {
    'source-id': name, 'source-kind': 'fixture',
    'as-of': '2026-09-30T12:00:00Z', 'retrieved-at': '2026-09-30T12:05:00Z',
    availability: 'available', completeness: 'complete', freshness: 'fresh', ...overrides
  };
}

/** @param {string} name @param {Record<string, unknown>[]} rows @returns {Source} */
function source(name, rows) {
  return { source: name, rows, metadata: metadata(name) };
}

/** @param {number} [size] */
function evidence(size = 32) {
  const workflows = ['alpha', 'beta'].flatMap((campaign, index) => [
    ['worker', 'worker', 'true'], ['healthy', 'worker', 'true'],
    ['observed', 'orchestrator', 'true'], ['missing', 'orchestrator', 'true'],
    ['disabled', 'orchestrator', 'false'], ['standalone', 'standalone', 'true'],
    ['roleless', '', 'true']
  ].map(([workflow, role, active]) => ({
    organization: 'octo', repository: `control-${index}`, workflow, campaign,
    'campaign-name': campaign, 'workflow-name': `${campaign} ${workflow}`,
    'workflow-role': role, 'workflow-active': active, 'rollout-mode': index ? 'live' : 'review'
  })));
  const runs = workflows.filter((workflow) => !['missing', 'disabled'].includes(workflow.workflow))
    .flatMap((workflow, index) => Array.from({ length: size }, (_, attempt) => ({
      ...workflow, run: String(1000 + index * 100 + attempt), 'run-attempt': 1,
      'run-status': attempt >= size - 4 ? 'in-progress' : 'completed',
      'run-conclusion': attempt >= size - 4 ? ''
        : workflow.workflow === 'healthy' && attempt === size - 5 ? 'success'
          : ['failure', 'startup-failure', 'stale', 'timed-out'][attempt % 4],
      'started-at': `2026-09-${attempt < size / 2 ? '20' : '29'}T${String(attempt % Math.min(20, size / 2)).padStart(2, '0')}:00:00Z`,
      'target-repository': `octo/target-${attempt % 3}`,
      'failure-kind': attempt % 3 ? 'agent_logic' : 'driver_exit',
      'failure-message': `Retained failure ${attempt}`, 'failure-step': 'agent',
      'failure-job': 'agent', 'failure-log': 'Retained diagnostic log',
      engine: 'copilot', 'engine-version': '1.2.3', 'gh-aw-version': 'v0.89.4',
      'requested-model': 'requested', 'resolved-model': 'resolved',
      'aic-total': attempt % 5 ? 0.25 : null, 'safe-items-count': attempt % 5 ? 0 : null,
      event: 'workflow_dispatch',
      'run-link': { relation: 'run', href: `https://github.com/octo/${workflow.repository}/actions/runs/${1000 + index * 100 + attempt}` }
    })));
  const audits = [{
    ...runs[size - 7], event: 'incomplete-report', 'event-timestamp': runs[size - 7]['started-at'],
    'event-source': 'mcp', 'event-type': 'safe_output.created',
    'safe-output-type': 'report_incomplete', 'event-summary': 'Required target evidence is unavailable.'
  }];
  return {
    campaigns: source('campaigns', ['alpha', 'beta'].map((campaign) => ({ campaign, 'campaign-name': campaign }))),
    repositories: source('repositories', [0, 1].map((index) => ({ organization: 'octo', repository: `control-${index}` }))),
    workflows: source('workflows', workflows), runs: source('runs', runs),
    audits: source('audits', audits), tools: source('tools', []),
    domains: source('domains', []), issues: source('issues', [])
  };
}

/** @param {ReturnType<typeof evidence>} [input] @returns {Promise<Record<string, Source>>} */
async function canonicalSources(input = evidence()) {
  return /** @type {Record<string, Source>} */ (await processDataRequest({
    operation: 'load-dashboard-query-sources', sources: input, ingest: true, queries: [],
    sourceNames: resolveDashboardQuerySources(baseline, publicNames).filter((name) => Object.hasOwn(TABLE_FIELDS, name))
  }));
}

/** @param {unknown[]} definitions @param {Record<string, Input>} sources @param {string[]} [requested] */
function workerResults(definitions, sources, requested = names) {
  const lazy = /** @type {Record<string, Source>} */ (processDataRequest({
    operation: 'execute-dashboard-queries', queries: definitions, sources, sourceNames: requested
  }));
  return Object.fromEntries(requested.map((name) => [
    name, { source: lazy[name].source, rows: lazy[name].rows, metadata: lazy[name].metadata }
  ]));
}

/** @param {Record<string, Input>} sources @param {string[]} [requested] */
function parity(sources, requested = names) {
  const before = workerResults(baseline, sources, requested);
  const after = workerResults(queries, sources, requested);
  expect(after).toStrictEqual(before);
  return after;
}

beforeEach(async () => {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
});

describe('second-pass campaign failure graph', () => {
  it('preserves complete canonical worker outputs, public consumers, diagnoses, links, roles and row ordering', async () => {
    const sources = await canonicalSources();
    const results = parity(sources, publicNames);
    for (const name of names) {
      expect(results[name].rows.length).toBeGreaterThan(0);
      expect(results[name].metadata.availability).toBe('available');
    }
    expect(results['campaign-problem-items'].rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        'error-signature': 'incomplete_evidence', 'status-detail': 'Required target evidence is unavailable.',
        'run-link': expect.objectContaining({ relation: 'run' })
      })
    ]));
    expect(results['campaign-unobserved-orchestrators'].rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ 'problem-kind': 'not-observed', workflow: 'missing', 'failure-count': 0 })
    ]));
    // The union precedes the representative-run inner join, even for unobserved declarations.
    expect(results['campaign-problem-items'].rows.some((row) => row.workflow === 'missing')).toBe(false);
    expect(results['campaign-runtime-health-groups'].rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ 'workflow-role': 'worker', 'dispatch-type': 'Campaign worker' }),
      expect.objectContaining({ 'workflow-role': 'orchestrator', 'dispatch-type': 'Campaign orchestrator' }),
      expect.objectContaining({ 'workflow-role': 'standalone', 'dispatch-type': 'Standalone workflow' })
    ]));
    expect(results['campaign-problem-items'].rows.some((row) => row.workflow === 'disabled')).toBe(false);
  });

  it.each(['overview-runs', 'runs', 'workflows', 'audits'])('preserves missing, unavailable, unknown and oldest stale %s evidence', async (name) => {
    const sources = await canonicalSources();
    const absent = { ...sources };
    delete absent[name];
    parity(absent);
    parity({
      ...sources,
      [name]: { ...sources[name], rows: [], metadata: metadata(name, { availability: 'unavailable' }) }
    });
    parity({ ...sources, [name]: { ...sources[name], metadata: undefined } });
    const dated = Object.fromEntries(Object.entries(sources).map(([id, value]) => [
      id, { ...value, metadata: metadata(id) }
    ]));
    const stale = parity({
      ...dated,
      [name]: {
        ...sources[name],
        metadata: metadata(name, {
          completeness: 'partial', freshness: 'stale',
          'as-of': '2026-08-01T00:00:00Z', 'retrieved-at': '2026-08-01T01:00:00Z'
        })
      }
    });
    for (const query of names) expect(stale[query].metadata).toMatchObject({
      completeness: 'partial', freshness: 'stale',
      'as-of': '2026-08-01T00:00:00Z', 'retrieved-at': '2026-08-01T01:00:00Z'
    });
  });

  it('preserves empty evidence and an all-in-flight horizon without treating either as health', async () => {
    const input = evidence();
    input.runs.rows = [];
    input.audits.rows = [];
    const results = parity(await canonicalSources(input), publicNames);
    expect(results['campaign-runtime-health-groups'].rows).toEqual([]);
    expect(results['campaign-problem-items'].rows.every((row) => row['problem-kind'] === 'not-observed')).toBe(true);
    const sources = await canonicalSources(evidence());
    const inFlight = {
      ...sources,
      'overview-runs': {
        ...sources['overview-runs'],
        rows: sources['overview-runs'].rows.map((row) => ({ ...row, 'run-status': 'in-progress' }))
      }
    };
    expect(parity(inFlight, publicNames)['campaign-runtime-health-groups'].rows).toEqual([]);
    const empty = Object.fromEntries(Object.entries(sources).map(([name, value]) => [
      name, { ...value, rows: [], metadata: metadata(name, { availability: 'empty' }) }
    ]));
    for (const result of Object.values(parity(empty))) {
      expect(result.rows).toEqual([]);
      expect(result.metadata.availability).toBe('empty');
    }
  });

  it.each(['run-attempt', 'incomplete-outcome', 'workflow'])('preserves duplicate %s rejection and machine-readable diagnostic metadata', async (kind) => {
    const input = evidence();
    if (kind === 'run-attempt') {
      input.runs.rows.push({ ...input.runs.rows[0], 'run-attempt': 2 });
    }
    if (kind === 'incomplete-outcome') {
      input.audits.rows.push({ ...input.audits.rows[0], event: 'another-incomplete-report' });
    }
    const sources = await canonicalSources(input);
    const name = kind === 'incomplete-outcome' ? 'audits' : kind === 'workflow' ? 'workflows' : 'runs';
    const first = sources[name].rows[0];
    if (kind === 'run-attempt') {
      expect(parity(sources)['campaign-problem-run-evidence'].rows.length).toBeGreaterThan(0);
    }
    const results = parity(kind === 'run-attempt'
      ? { ...sources, runs: { ...sources.runs, rows: [...sources.runs.rows, { ...first, 'run-attempt': 3 }] } }
      : kind === 'workflow'
      ? { ...sources, workflows: { ...sources.workflows, rows: [...sources.workflows.rows, { ...first }] } }
      : sources);
    if (kind === 'run-attempt' || kind === 'workflow') {
      expect(results['campaign-problem-items'].rows).toEqual([]);
      expect(results['campaign-problem-items'].metadata).toMatchObject({ availability: 'unavailable' });
      expect(results['campaign-problem-items'].metadata['query-diagnostic']).toBeDefined();
      if (kind === 'workflow') expect(results['campaign-problem-items'].metadata['query-error']).toBeDefined();
      else expect(results['campaign-problem-items'].metadata['query-diagnostic']).toContain('more than one row per join key');
    }
    if (kind === 'incomplete-outcome') {
      expect(results['campaign-problem-run-evidence'].rows).toEqual([]);
      expect(results['campaign-problem-run-evidence'].metadata['query-error']).toEqual({
        code: 'input-unavailable', source: 'campaign-runs'
      });
    }
  });

  it('preserves scoped horizons, dimension filters, search, route arguments and missing route failure', async () => {
    const sources = await canonicalSources();
    const page = {
      id: 'failure-contract',
      views: names.map((name) => ({
        id: name, mark: 'table',
        data: { source: name, arguments: [{ name: 'campaign', field: 'campaign' }] }
      }))
    };
    for (const [index, context] of [
      { routeParameters: { campaign: 'alpha' }, queryContext: { filters: { campaign: ['alpha'] }, timeWindow: { start: '2026-09-29T00:00:00Z', end: '2026-09-30T00:00:00Z' } } },
      { routeParameters: { campaign: 'beta' }, queryContext: { search: { fields: ['workflow'], query: 'worker' } } },
      { routeParameters: { campaign: 'alpha' }, queryContext: { timeWindow: { start: '2026-09-01T00:00:00Z', end: '2026-09-02T00:00:00Z' } } },
      {}
    ].entries()) {
      const before = compileDashboardViewPayloadQueries(page, page.id, { ...context, queries: baseline });
      const after = compileDashboardViewPayloadQueries(page, page.id, { ...context, queries });
      expect(after.aliases).toEqual(before.aliases);
      const optimized = workerResults(/** @type {Query[]} */ (after.queries), sources, after.aliases);
      expect(optimized).toStrictEqual(workerResults(/** @type {Query[]} */ (before.queries), sources, before.aliases));
      if (index === 0) {
        for (const result of Object.values(optimized)) {
          expect(result.rows.length).toBeGreaterThan(0);
          expect(result.rows.every((row) => row.campaign === 'alpha')).toBe(true);
        }
      }
      if (index >= 2) {
        for (const result of Object.values(optimized)) expect(result.rows).toEqual([]);
      }
    }
  });

  it('charges complete populated standalone graphs and the shared selected batch against the frozen baseline', async () => {
    const sources = await canonicalSources(evidence(64));
    const require = createRequire(resolve('package.json'));
    /** @type {{ analyzeDashboardComplexity: (document: unknown) => { inventory: Array<{ name: string, 'total-row-read-units': number, 'total-materialized-field-units': number }> } }} */
    const { analyzeDashboardComplexity } = require(resolve('../../activity/dashboard-complexity.mjs'));
    const beforeAnalysis = analyzeDashboardComplexity({ dashboard: { queries: baseline } });
    const afterAnalysis = analyzeDashboardComplexity({ dashboard: { queries } });
    const fields = [322, 318, 234, 214, 205, 200];
    const reads = [64, 60, 51, 46, 46, 44];
    for (const [index, name] of names.entries()) {
      const before = beforeAnalysis.inventory.find((query) => query.name === name);
      const after = afterAnalysis.inventory.find((query) => query.name === name);
      expect(before?.['total-row-read-units']).toBe(reads[index]);
      expect(before?.['total-materialized-field-units']).toBe(fields[index]);
      expect(after?.['total-materialized-field-units']).toBe(fields[index] - 4);
    }
    for (const requested of [...names.map((name) => [name]), names]) {
      const beforeBudget = createDashboardQueryBudget();
      const afterBudget = createDashboardQueryBudget();
      const original = executeDashboardQueries(baseline, sources, requested, { budget: beforeBudget });
      const optimized = executeDashboardQueries(queries, sources, requested, { budget: afterBudget });
      for (const name of requested) {
        expect(optimized[name].rows).toStrictEqual(original[name].rows);
        expect(optimized[name].metadata).toStrictEqual(original[name].metadata);
        expect(optimized[name].rows.length).toBeGreaterThan(0);
      }
      console.info('Second-pass complete campaign graph', {
        requested, rows: requested.map((name) => optimized[name].rows.length),
        before: beforeBudget.operations, after: afterBudget.operations
      });
      expect(afterBudget.operations).toBeLessThan(beforeBudget.operations * 0.95);
    }
  }, 30000);
});
