import 'fake-indexeddb/auto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processDataRequest } from '../../src/data-worker.js';
import {
  createDashboardQueryBudget, executeDashboardQueries, resolveDashboardQuerySources
} from '../../src/data/queries/declarative.js';
import { compileDashboardViewPayloadQueries } from '../../src/data/queries/view-payload-compiler.js';
import { DATABASE_NAME, openCanonicalDatabase } from '../../src/data/storage/indexeddb.js';
import { authoritativeDashboard } from '../authoritative-dashboard.js';

/** @typedef {import('../../src/data/queries/declarative.js').DashboardQuery} Query */
/** @typedef {import('../../src/presenter.js').LogicalSourceInput} Source */
/** @typedef {import('../../src/presenter.js').SourceMetadata} Metadata */

/** @type {Query[]} */
const queries = authoritativeDashboard.dashboard.queries;
const selected = ['workflow-inventory', 'entity-events'];
const canonicalNames = ['workflows', 'runs', 'audits', 'domains', 'tools', 'issues'];
const eventNames = canonicalNames.slice(2);
/** @type {Query} */
const originalEventBase = {
  name: 'event-base', from: 'audits', union: ['domains', 'tools', 'issues'],
  select: [
    'organization', 'repository', 'workflow', 'run', 'run-attempt', 'event', 'event-source',
    'event-type', 'event-summary', 'event-status', 'github-entity-type', 'safe-output-type',
    'safe-output-url', 'correlation-id', 'implementation-pull-request-url', 'event-timestamp', 'run-link'
  ].map((field) => ({ field }))
};
/** @type {Query} */
const originalImportStatus = {
  name: 'run-import-status', from: 'runs',
  joins: [{
    source: 'event-runs', type: 'left',
    on: ['organization', 'repository', 'workflow', 'run', 'run-attempt'].map((field) => ({ left: field, right: field })),
    fields: [{ field: 'events', as: 'imported-events' }]
  }],
  compute: [
    { as: 'imported-event-count', function: 'coalesce', args: [{ field: 'imported-events' }, { value: 0 }] },
    { as: 'imported', function: 'greater-than', args: [{ field: 'imported-event-count' }, { value: 0 }] }
  ]
};
/** @type {Query} */
const originalWorkflowTotals = {
  name: 'workflow-run-totals', from: 'run-import-status',
  compute: [{ as: 'run-attempt-identity', function: 'concat', args: [{ field: 'run' }, { value: ':' }, { field: 'run-attempt' }] }],
  aggregate: {
    by: ['organization', 'repository', 'workflow'],
    values: [
      { field: 'run-attempt-identity', as: 'runs', reducer: 'distinct-count' },
      {
        field: 'run-conclusion', as: 'successful-runs', reducer: 'count',
        filter: { predicates: [{ field: 'run-conclusion', equals: 'success' }] }
      },
      {
        field: 'run-conclusion', as: 'failed-runs', reducer: 'count',
        filter: { predicates: [{ field: 'run-conclusion', in: ['failure', 'startup-failure', 'stale', 'timed-out'] }] }
      },
      { field: 'imported', as: 'imported-runs', reducer: 'sum' }
    ]
  }
};
/** @type {Query[]} */
const baseline = [originalEventBase, ...queries.flatMap((query) => {
  if (query.name === 'event-runs') return [query, originalImportStatus, originalWorkflowTotals];
  if (['workflow-inventory-run-totals', 'entity-event-records'].includes(query.name)) return [];
  if (query.name === 'entity-events') return {
    ...query, from: 'event-base',
    compute: [{
      as: 'event-url', function: /** @type {const} */ ('coalesce'),
      args: [{ field: 'safe-output-url' }, { field: 'correlation-id' }, { field: 'implementation-pull-request-url' }]
    }],
    select: [
      'organization', 'repository', 'workflow', 'run', 'run-attempt', 'event', 'event-source',
      'event-type', 'event-summary', 'event-status', 'github-entity-type', 'safe-output-type',
      'event-url', 'event-timestamp', 'run-link'
    ].map((field) => field === 'event-timestamp' ? { field, as: 'observed-at' } : { field })
  };
  if (query.name !== 'workflow-inventory') return query;
  return {
    ...query,
    joins: query.joins?.map((join) => ({
      ...join, source: join.source === 'workflow-inventory-run-totals' ? 'workflow-run-totals' : join.source
    }))
  };
})];

/** @param {string} name @param {Record<string, unknown>[]} rows @returns {Source} */
function source(name, rows) {
  return {
    source: name, rows,
    metadata: {
      'source-id': name, 'source-kind': 'fixture',
      'as-of': '2026-09-30T12:00:00Z', 'retrieved-at': '2026-09-30T13:00:00Z',
      availability: rows.length ? 'available' : 'empty', completeness: 'complete', freshness: 'fresh'
    }
  };
}

/** @param {number} [scale] @returns {Record<string, Source>} */
function evidence(scale = 1) {
  const workflows = [
    { organization: 'org', repository: 'control', workflow: 'alpha.md', campaign: 'alpha', 'workflow-role': 'worker', 'workflow-active': 'true' },
    { organization: 'org', repository: 'control', workflow: 'inactive.md', campaign: 'alpha', 'workflow-role': 'orchestrator', 'workflow-active': 'false' },
    { organization: 'other', repository: 'control', workflow: 'alpha.md', 'workflow-role': 'standalone', 'workflow-active': 'unknown' },
    { organization: 'org', repository: 'empty', workflow: 'unobserved.md', 'workflow-role': '', 'workflow-active': 'false' }
  ].map((row) => ({
    ...row, 'rollout-mode': 'review',
    'repository-link': { relation: 'repository', href: `https://github.com/${row.organization}/${row.repository}` },
    'workflow-link': { relation: 'workflow', href: `https://github.com/${row.organization}/${row.repository}/actions/workflows/${row.workflow}` }
  }));
  const conclusions = ['success', 'failure', 'startup-failure', 'stale', 'timed-out', 'cancelled', 'action-required', 'success'];
  const runs = workflows.slice(0, 3).flatMap((row, workflow) => Array.from({ length: 8 * scale }, (_, index) => ({
    ...row, run: String(workflow * 10000 + Math.floor(index / 2) + 100),
    'run-attempt': index % 2 + 1, 'run-status': 'completed', 'run-conclusion': conclusions[index % 8],
    'aic-total': index % 3 ? 0.5 : null,
    'started-at': index % 2 ? '2026-09-30T11:00:00Z' : '2026-09-01T11:00:00Z'
  })));
  return {
    repositories: source('repositories', [
      { organization: 'org', repository: 'control' },
      { organization: 'other', repository: 'control' },
      { organization: 'org', repository: 'empty' }
    ]),
    workflows: source('workflows', workflows),
    runs: source('runs', runs),
    ...Object.fromEntries(eventNames.map((name, kind) => [
      name, source(name, runs.filter((_, index) => index % 8 < 4).flatMap((run, index) => (
        Array.from({ length: scale === 1 ? 1 : 5 }, (_, record) => ({
          organization: run.organization, repository: run.repository, workflow: run.workflow,
          run: run.run, 'run-attempt': run['run-attempt'],
          event: `${name}-${index}-${record}`, 'event-source': name,
          'event-type': name === 'issues' ? 'safe_output.created' : 'tool.call',
          'event-summary': `Retained ${name} evidence`, 'event-status': index % 2 ? 'success' : 'unknown',
          'safe-output-type': name === 'issues' ? 'create_issue' : '',
          'safe-output-url': kind === 3 ? `https://github.com/org/evidence/issues/${index * 5 + record + 1}`
            : kind === 0 && index !== 0 ? `https://example.com/safe/${index}/${record}` : '',
          'correlation-id': kind < 2 && (kind === 0 || index !== 0) ? `https://example.com/correlation/${index}/${record}` : '',
          'implementation-pull-request-url': kind < 3 && (kind !== 2 || index !== 0) ? `https://example.com/implementation/${index}/${record}` : '',
          'event-timestamp': run['started-at']
        }))
      )))
    ]))
  };
}

/** @param {ReturnType<typeof evidence>} [input] @returns {Promise<Record<string, Source>>} */
async function canonicalSources(input = evidence()) {
  return /** @type {Record<string, Source>} */ (await processDataRequest({
    operation: 'load-dashboard-query-sources', sources: input, ingest: true,
    queries: [], sourceNames: canonicalNames
  }));
}

/** @param {Query[] | Record<string, unknown>[]} definitions @param {Record<string, Source>} sources @param {string[]} [names] */
function worker(definitions, sources, names = selected) {
  const lazy = /** @type {Record<string, Source>} */ (processDataRequest({
    operation: 'execute-dashboard-queries', queries: definitions, sources, sourceNames: names
  }));
  return Object.fromEntries(names.map((name) => [
    name, { source: lazy[name].source, rows: lazy[name].rows, metadata: lazy[name].metadata }
  ]));
}

/** @param {Record<string, Source>} sources */
function parity(sources) {
  const before = worker(baseline, sources);
  const after = worker(queries, sources);
  expect(after).toEqual(before);
  return after;
}

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-30T14:00:00Z'));
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
});
afterEach(() => vi.restoreAllMocks());

describe('workflow and event inventory graph optimization', () => {
  it('preserves populated canonical rows, attempt/conclusion/import/AIC counts, inactive workflows and links', async () => {
    const sources = await canonicalSources();
    const results = parity(sources);
    expect(results['workflow-inventory'].rows).toHaveLength(4);
    expect(results['workflow-inventory'].rows[0]).toMatchObject({
      repository: 'org/control', workflow: 'alpha.md', runs: 4, aic: 1.5,
      'successful-runs': 1, 'failed-runs': 2, ingestion: '50%', 'aic-per-run': 0.375,
      'campaign-link': { 'dashboard-href': '#page-campaign-insights?campaign=alpha' },
      'repository-link': { 'dashboard-href': '#page-repository-detail?repository=org%2Fcontrol' },
      'workflow-link': { 'dashboard-href': '#page-workflow-runtime?workflow=org%2Fcontrol%3Aalpha.md' }
    });
    expect(results['workflow-inventory'].rows[1]['workflow-active']).toBe('false');
    expect(results['workflow-inventory'].rows[2]).toMatchObject({ runs: 0, aic: 0, ingestion: null });
    expect(results['entity-events'].rows).toHaveLength(48);
    for (const row of results['entity-events'].rows) {
      const first = String(row.event).includes('-0-');
      const segment = row['event-source'] === 'audits' ? first ? 'correlation' : 'safe'
        : row['event-source'] === 'domains' ? first ? 'implementation' : 'correlation'
        : row['event-source'] === 'tools' ? first ? null : 'implementation' : 'issues';
      expect(row['event-url']).toEqual(segment ? expect.stringContaining(`/${segment}/`) : null);
    }
    for (const result of Object.values(results)) expect(result.metadata.availability).toBe('available');
  });

  it('preserves still-consumed shared event/first-pass campaign and repository helpers', async () => {
    const sources = await canonicalSources();
    const names = [
      'event-runs', 'workflow-aic-totals',
      'campaign-workflow-inventory', 'campaign-workflow-execution-totals',
      'repository-run-totals', 'repository-execution-totals'
    ].filter((name) => queries.some((query) => query.name === name));
    expect(worker(queries, sources, names)).toEqual(worker(baseline, sources, names));
    expect(resolveDashboardQuerySources(queries, ['workflow-inventory'])).not.toContain('run-import-status');
    expect(resolveDashboardQuerySources(queries, ['entity-events'])).not.toContain('event-base');
  });

  it.each(eventNames)('composes oldest provenance and weakest partial/stale %s evidence exactly', async (name) => {
    const sources = await canonicalSources();
    sources[name].metadata = {
      ...sources[name].metadata, completeness: 'partial', freshness: 'stale',
      'as-of': '2026-08-01T00:00:00Z', 'retrieved-at': '2026-08-02T00:00:00Z'
    };
    for (const result of Object.values(parity(sources))) {
      expect(result.metadata).toMatchObject({
        completeness: 'partial', freshness: 'stale',
        'as-of': '2026-08-01T00:00:00Z', 'retrieved-at': '2026-08-02T00:00:00Z'
      });
    }
  });

  it.each(canonicalNames)('preserves absent and unavailable %s semantics and exact machine errors', async (name) => {
    const sources = await canonicalSources();
    for (const absent of [false, true]) {
      const inputs = { ...sources };
      if (absent) delete inputs[name];
      else inputs[name] = { ...sources[name], rows: [], metadata: { ...sources[name].metadata, availability: 'unavailable' } };
      const before = worker(baseline, inputs);
      const after = worker(queries, inputs);
      if (name !== 'audits') expect(after).toEqual(before);
      else {
        expect(after['workflow-inventory']).toEqual(before['workflow-inventory']);
        const original = before['entity-events'];
        const optimized = after['entity-events'];
        expect(optimized.rows).toEqual([]);
        expect(original.metadata['query-diagnostic']).toBe('$.dashboard.queries[entity-events]: input source "event-base" is unavailable.');
        expect(optimized.metadata['query-diagnostic']).toBe('$.dashboard.queries[entity-events]: input source "entity-event-records" is unavailable.');
        expect(optimized.metadata).toEqual({
          ...original.metadata, 'query-diagnostic': optimized.metadata['query-diagnostic']
        });
        expect(optimized.metadata['query-error']).toEqual({ code: 'input-unavailable', source: 'audits' });
      }
    }
  });

  it('preserves empty, all-optional-unavailable and unknown-metadata evidence without implying coverage', async () => {
    const sources = await canonicalSources();
    const empty = Object.fromEntries(Object.entries(sources).map(([name, value]) => [
      name, { ...value, rows: [], metadata: { ...value.metadata, availability: /** @type {const} */ ('empty') } }
    ]));
    for (const value of Object.values(parity(empty))) {
      expect(value.rows).toEqual([]);
      expect(value.metadata.availability).toBe('empty');
    }
    for (const name of eventNames.slice(1)) {
      sources[name] = { ...sources[name], rows: [], metadata: { ...sources[name].metadata, availability: 'unavailable' } };
    }
    for (const value of Object.values(parity(sources))) expect(value.metadata.completeness).toBe('partial');
    for (const name of eventNames) {
      const input = await canonicalSources();
      input[name] = { ...input[name], metadata: /** @type {Metadata} */ ({}) };
      for (const value of Object.values(parity(input))) expect(value.metadata.completeness).toBe('unknown');
    }
  });

  it.each(selected)('preserves %s horizon, filters, search, route arguments and sorting at the view boundary', async (name) => {
    const sources = await canonicalSources();
    const view = { id: 'contract', mark: 'table', data: {
      source: name, arguments: name === 'entity-events' ? [{ name: 'run', field: 'run' }] : []
    } };
    /** @type {import('../../src/data/queries/view-payload-compiler.js').GlobalQueryContext[]} */
    const contexts = [
      { timeWindow: { start: '2026-09-20T00:00:00Z', end: '2026-10-01T00:00:00Z' } },
      { timeWindow: { start: '2026-09-30T11:00:00Z', end: '2026-09-30T11:00:00Z' } },
      { filters: { organization: ['org'], repository: [name === 'entity-events' ? 'control' : 'org/control'] } },
      { search: { fields: ['workflow'], query: 'alpha' } },
      { search: { fields: name === 'entity-events' ? ['event-url'] : ['campaign-name'], query: name === 'entity-events' ? 'safe' : 'alpha' } },
      { orderBy: [{ field: 'workflow', direction: 'desc' }] }
    ];
    for (const queryContext of contexts) {
      const options = { queryContext, routeParameters: { run: '100' } };
      const before = compileDashboardViewPayloadQueries({ views: [view] }, 'contract', { ...options, queries: baseline });
      const after = compileDashboardViewPayloadQueries({ views: [view] }, 'contract', { ...options, queries });
      const result = worker(after.queries, sources, after.aliases);
      expect(result).toEqual(worker(before.queries, sources, before.aliases));
      if (!queryContext.timeWindow || queryContext.timeWindow.start !== queryContext.timeWindow.end) {
        expect(result[after.aliases[0]].rows.length).toBeGreaterThan(0);
      }
    }
    if (name === 'entity-events') {
      /** @type {Record<string, string>[]} */
      const routes = [{}, { run: 'unretained-run' }];
      for (const routeParameters of routes) {
        const before = compileDashboardViewPayloadQueries({ views: [view] }, 'contract', { routeParameters, queries: baseline });
        const after = compileDashboardViewPayloadQueries({ views: [view] }, 'contract', { routeParameters, queries });
        const result = worker(after.queries, sources, after.aliases);
        expect(result).toEqual(worker(before.queries, sources, before.aliases));
        expect(result[after.aliases[0]].rows).toEqual([]);
      }
    }
  });

  it('rejects duplicate normalized event join keys without losing independent inventory AIC', async () => {
    const input = evidence();
    await canonicalSources(input);
    const database = await openCanonicalDatabase(indexedDB);
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(['runs', 'audits'], 'readwrite');
      const store = transaction.objectStore('runs');
      const request = store.getAll();
      request.onsuccess = () => {
        const run = request.result[0];
        const duplicateId = `${run.id}:duplicate`;
        store.put({ ...run, id: duplicateId, attempt: `${run.attempt} ` });
        const audits = transaction.objectStore('audits');
        const records = audits.getAll();
        records.onsuccess = () => {
          const audit = records.result.find((/** @type {{ runId: string }} */ row) => row.runId === run.id);
          if (!audit) throw new Error('The duplicate identity fixture requires retained audit evidence.');
          audits.put({ ...audit, id: `${audit.id}:duplicate`, runId: duplicateId });
        };
      };
      transaction.oncomplete = () => resolve(undefined);
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
    const sources = /** @type {Record<string, Source>} */ (await processDataRequest({
      operation: 'load-dashboard-query-sources', sources: input, queries: [], sourceNames: canonicalNames
    }));
    for (const name of eventNames) expect(sources[name].metadata.availability).toBe('available');
    const before = worker(baseline, sources);
    const after = worker(queries, sources);
    expect(after['workflow-inventory']).toEqual(before['workflow-inventory']);
    expect(after['workflow-inventory'].rows[0].aic).toBeGreaterThan(0);
    expect(after['workflow-inventory'].metadata.completeness).toBe('partial');
    expect(after['entity-events']).toEqual(before['entity-events']);
    expect(after['workflow-inventory'].rows[0]).toMatchObject({ runs: 0, 'successful-runs': 0, 'failed-runs': 0 });
    const helper = worker(queries, sources, ['workflow-inventory-run-totals'])['workflow-inventory-run-totals'];
    expect(helper.rows).toEqual([]);
    expect(helper.metadata).toMatchObject({ availability: 'unavailable', completeness: 'unknown', freshness: 'unknown' });
    expect(helper.metadata['query-diagnostic']).toBe('$.dashboard.queries[workflow-inventory-run-totals]: joined source "event-runs" contains more than one row per join key.');
  });

  it('reduces full-graph operations standalone and batched on identical populated canonical evidence', async () => {
    const sources = await canonicalSources(evidence(24));
    for (const names of [[selected[0]], [selected[1]], selected]) {
      const beforeBudget = createDashboardQueryBudget();
      const afterBudget = createDashboardQueryBudget();
      const before = executeDashboardQueries(baseline, sources, names, { budget: beforeBudget });
      const after = executeDashboardQueries(queries, sources, names, { budget: afterBudget });
      for (const name of names) {
        expect(after[name].rows).toEqual(before[name].rows);
        expect(after[name].metadata).toEqual(before[name].metadata);
        expect(after[name].rows.length).toBeGreaterThan(0);
        expect(worker(queries, sources, [name])[name].rows).toEqual(after[name].rows);
      }
      console.info('workflow/event full graph operations', { names, before: beforeBudget.operations, after: afterBudget.operations });
      expect(afterBudget.operations).toBeLessThan(beforeBudget.operations);
    }
    const module = resolve('../../activity/dashboard-complexity.mjs');
    /** @type {{ analyzeDashboardComplexity: (document: unknown) => { inventory: Array<{ name: string, 'total-row-read-units': number, 'total-materialized-field-units': number }> } }} */
    const { analyzeDashboardComplexity } = createRequire(resolve('package.json'))(module);
    const before = analyzeDashboardComplexity({ dashboard: { queries: baseline } }).inventory;
    const after = analyzeDashboardComplexity({ dashboard: { queries } }).inventory;
    for (const name of selected) {
      const original = before.find((query) => query.name === name);
      const optimized = after.find((query) => query.name === name);
      expect(optimized?.['total-row-read-units']).toBeLessThan(Number(original?.['total-row-read-units']));
      expect(optimized?.['total-materialized-field-units']).toBeLessThan(Number(original?.['total-materialized-field-units']));
    }
  }, 30000);

  it('retains the canonical audit projection output limit and root failure rather than truncating evidence', async () => {
    const input = evidence();
    const record = input.audits.rows[0];
    input.audits.rows = Array.from({ length: 100001 }, (_, index) => ({ ...record, event: `audit-limit-${index}` }));
    const sources = await canonicalSources(input);
    expect(sources.audits.rows).toEqual([]);
    expect(sources.audits.metadata.availability).toBe('unavailable');
    expect(sources.audits.metadata['query-diagnostic']).toContain('max-output-rows limit of 100000');
    const before = worker(baseline, sources);
    const after = worker(queries, sources);
    expect(after['workflow-inventory']).toEqual(before['workflow-inventory']);
    expect(after['entity-events'].rows).toEqual([]);
    expect(after['entity-events'].metadata).toEqual({
      ...before['entity-events'].metadata,
      'query-diagnostic': '$.dashboard.queries[entity-events]: input source "entity-event-records" is unavailable.'
    });
    expect(after['entity-events'].metadata['query-error']).toEqual({ code: 'input-unavailable', source: 'audits' });
  }, 120000);
});
