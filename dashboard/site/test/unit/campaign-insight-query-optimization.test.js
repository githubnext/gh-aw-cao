import 'fake-indexeddb/auto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { processDataRequest } from '../../src/data-worker.js';
import {
  ingestDashboardSources,
  ingestNormalizedJsonl,
  NORMALIZED_JSONL_INGESTION_VERSION
} from '../../src/data/ingest/coordinator.js';
import { operationalValueId, repositoryCoordinateId } from '../../src/data/model/ids.js';
import { CANONICAL_SCHEMA_VERSION } from '../../src/data/model/schema.js';
import {
  createDashboardQueryBudget,
  dashboardQueryOutputFields,
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
/** @typedef {Omit<Source, 'metadata'> & { metadata?: Metadata }} InputSource */

const names = ['campaign-insight-tab-counts', 'campaign-insight-plot-inventory'];
/** @type {Query[]} */
const queries = authoritativeDashboard.dashboard.queries;

// Frozen executable graph at a5f8c356bfbd9e5863a187420c641d69187a3e52.
/** @type {Query[]} */
const originalGraph = [
  {
    name: 'audit-event-summary-buckets',
    from: 'audits',
    union: ['tools'],
    filter: { predicates: [
      { field: 'event-type', in: [
        'audit.finding', 'audit.observability', 'audit.recommendation', 'audit.missing_tool',
        'audit.missing_data', 'audit.noop', 'audit.mcp_failure', 'audit.skill_activation'
      ] },
      { field: 'event-status', in: ['high', 'medium'] }
    ] },
    joins: [{
      source: 'workflows', type: 'left',
      on: [
        { left: 'organization', right: 'organization' },
        { left: 'repository', right: 'repository' },
        { left: 'workflow', right: 'workflow' }
      ],
      fields: [{ field: 'campaign', as: 'campaign' }]
    }],
    aggregate: {
      by: ['campaign', 'event-status', 'workflow', 'event-summary'],
      values: [{ field: 'event', as: 'events', reducer: 'count' }]
    },
    select: [
      { field: 'campaign' }, { field: 'event-status' }, { field: 'workflow' },
      { field: 'event-summary' }, { field: 'events' }
    ],
    'order-by': [
      { field: 'event-status', direction: 'asc' },
      { field: 'events', direction: 'desc' },
      { field: 'workflow', direction: 'asc' },
      { field: 'event-summary', direction: 'asc' }
    ]
  },
  {
    name: 'campaign-operational-value-primary-series',
    from: 'operational-values',
    'temporal-series': {
      time: 'observed-at', series: 'repository', shape: 'groups',
      carry: [
        'campaign', 'repository', 'operational-value-role', 'operational-value-name',
        'operational-value-unit', 'operational-value-direction', 'adoption-at',
        'evaluation-mode', 'workflow-slug', 'workflow-name'
      ],
      measures: [{ field: 'operational-value', key: 'operational-value-definition', kind: 'primary' }],
      trend: { direction: 'operational-value-direction' }
    }
  },
  {
    name: 'campaign-operational-value-plot-inventory',
    from: 'campaign-operational-value-primary-series'
  },
  {
    name: 'campaign-audit-summary-plot-inventory',
    from: 'audit-event-summary-buckets',
    aggregate: {
      by: ['campaign'],
      values: [{ field: 'event-summary', as: 'buckets', reducer: 'count' }]
    }
  },
  {
    name: 'campaign-insight-plot-inventory',
    from: 'campaign-operational-value-plot-inventory',
    union: ['campaign-audit-summary-plot-inventory']
  },
  {
    name: 'campaign-insight-tab-counts',
    from: 'campaign-insight-plot-inventory',
    aggregate: {
      by: ['campaign'],
      values: [{ field: 'campaign', as: 'items', reducer: 'count' }]
    }
  }
];
const originalIndex = new Map(originalGraph.map((query) => [query.name, query]));
const baseline = queries.flatMap((query) => query.name === 'campaign-operational-value-primary-series'
  ? [originalGraph[1], originalGraph[2]]
  : [originalIndex.get(query.name) ?? query]);
const graphNames = originalGraph.map((query) => query.name)
  .filter((name) => name !== 'campaign-operational-value-plot-inventory');
/** @type {Record<string, string[]>} */
const tableFields = TABLE_FIELDS;
const canonicalNames = resolveDashboardQuerySources(baseline, names)
  .filter((name) => Object.hasOwn(tableFields, name));
/** @type {{ analyzeDashboardComplexity: (document: unknown) => { inventory: Array<{ name: string, 'total-row-read-units': number, 'total-materialized-field-units': number }> } }} */
const { analyzeDashboardComplexity } = createRequire(resolve('package.json'))(
  resolve('../../activity/dashboard-complexity.mjs')
);

/** @param {string} name @param {Partial<Metadata>} [overrides] @returns {Metadata} */
function metadata(name, overrides = {}) {
  return {
    'source-id': name, 'source-kind': 'fixture',
    'as-of': '2026-09-22T12:00:00Z', 'retrieved-at': '2026-09-22T12:05:00Z',
    availability: 'available', completeness: 'complete', freshness: 'fresh',
    ...overrides
  };
}

/** @param {string} name @param {Record<string, unknown>[]} rows @returns {Source} */
function source(name, rows) {
  return { source: name, rows, metadata: metadata(name, { availability: rows.length ? 'available' : 'empty' }) };
}

/** @param {number} [buckets] @param {number} [observations] */
function evidence(buckets = 12, observations = 489) {
  const declarations = [
    { campaign: 'alpha', repository: 'control', workflow: 'audit.md' },
    { campaign: 'alpha', repository: 'other', workflow: 'audit.md' },
    { campaign: 'beta', repository: 'other', workflow: 'review.md' },
    { campaign: 'audit-only', repository: 'control', workflow: 'audit-only.md' }
  ].map((row) => ({ organization: 'example', 'workflow-role': 'worker', 'workflow-active': 'true', ...row }));
  const runs = declarations.map((row, index) => ({
    ...row, run: String(index + 1), 'run-attempt': 1,
    'run-status': 'completed', 'run-conclusion': 'success',
    'started-at': '2026-09-15T12:00:00Z'
  }));
  const inputs = {
    campaigns: source('campaigns', ['alpha', 'beta', 'audit-only', 'null-only', 'empty'].map((campaign) => ({
      campaign, 'campaign-name': campaign, 'campaign-enabled': true, 'campaign-mode': 'review'
    }))),
    repositories: source('repositories', ['control', 'other'].map((repository) => ({
      organization: 'example', repository
    }))),
    workflows: source('workflows', declarations),
    runs: source('runs', runs),
    audits: source('audits', runs.flatMap((run) => Array.from({ length: buckets }, (_, index) => ({
      ...run, event: `audit-${run.run}-${index}`, 'event-source': 'fixture',
      'event-type': index % 5 === 0 ? 'tool.call' : 'audit.finding',
      'event-status': index % 3 === 0 ? 'info' : index % 2 ? 'medium' : 'high',
      'event-summary': index % 7 === 0 ? '' : `Finding ${index}`,
      'event-timestamp': index % 2 ? '2026-09-15T12:00:00Z' : '2026-09-01T12:00:00Z'
    })))),
    tools: source('tools', runs.flatMap((run) => Array.from({ length: buckets }, (_, index) => ({
      ...run, event: `tool-${run.run}-${index}`, 'event-source': 'fixture',
      'event-type': index % 3 === 0 ? 'tool.call' : 'audit.skill_activation',
      'event-status': index % 2 ? 'medium' : 'high',
      'event-summary': index % 7 === 0 ? '' : `Finding ${index}`,
      'event-timestamp': index % 2 ? '2026-09-15T12:00:00Z' : '2026-09-01T12:00:00Z'
    })))),
    'operational-values': source('operational-values', [])
  };
  const values = Array.from({ length: observations }, (_, index) => {
    const campaign = index % 3 === 0 ? 'beta' : 'alpha';
    const repository = Math.floor(index / 4) % 2 ? 'other' : 'control';
    const definition = ['native.cost', 'native.accepted', 'native.stability', 'native.target'][index % 4];
    const timestamp = new Date(Date.parse('2026-09-01T12:00:00Z') + index * 3600000).toISOString();
    return {
      id: operationalValueId({ campaign, repository: `example/${repository}`, valueId: definition, observedAt: timestamp }),
      repositoryId: repositoryCoordinateId('example', repository),
      repository: `example/${repository}`, campaign, valueId: definition,
      value: index % 13 === 0 ? null : index % 11 === 0 ? 0 : index / 4 - 5,
      timestamp, observedAt: timestamp,
      'operational-value-role': 'primary', 'operational-value-name': definition,
      'operational-value-unit': index % 4 === 0 ? 'AIC' : 'native units',
      'operational-value-direction': ['decrease', 'increase', 'maintain', 'target'][index % 4],
      'maturity-status': index % 2 ? 'interim' : 'matured',
      'adoption-at': '2026-09-05T00:00:00Z',
      'evaluation-mode': index % 3 ? 'baseline-comparable' : 'attainment-only',
      'workflow-slug': index % 9 ? 'audit' : 'alternate',
      'workflow-name': index % 9 ? 'Audit' : 'Alternate'
    };
  });
  if (observations) {
    const timestamp = '2026-09-16T12:00:00Z';
    values.push({
      ...values[0], campaign: 'null-only', value: null, timestamp, observedAt: timestamp,
      id: operationalValueId({ campaign: 'null-only', repository: 'example/control', valueId: 'native.cost', observedAt: timestamp })
    });
  }
  return { inputs, values };
}

/** @param {ReturnType<typeof evidence>} [input] @returns {Promise<Record<string, Source>>} */
async function canonicalSources(input = evidence()) {
  const now = Date.parse('2026-09-22T12:00:00Z');
  await ingestDashboardSources(indexedDB, input.inputs, { now });
  const header = {
    kind: 'metadata', schemaVersion: CANONICAL_SCHEMA_VERSION,
    ingestionVersion: NORMALIZED_JSONL_INGESTION_VERSION, phase: 'records', records: input.values.length
  };
  await ingestNormalizedJsonl(indexedDB, (async function* () {
    yield `${JSON.stringify(header)}\n`;
    for (const record of input.values) {
      yield `${JSON.stringify({ kind: 'record', collection: 'operationalValues', record })}\n`;
    }
  })(), { now, payloadIdentity: 'campaign-insight-fixture', payloadScope: 'campaign-insight-fixture' });
  return /** @type {Record<string, Source>} */ (await processDataRequest({
    operation: 'load-dashboard-query-sources', sources: input.inputs,
    queries: [], sourceNames: canonicalNames
  }));
}

/** @param {Query[]} definitions @param {Record<string, InputSource>} sources @param {string[]} [requested] */
function workerResults(definitions, sources, requested = names) {
  const lazy = /** @type {Record<string, Source>} */ (processDataRequest({
    operation: 'execute-dashboard-queries', queries: definitions, sources, sourceNames: requested
  }));
  return Object.fromEntries(requested.map((name) => [
    name, { source: lazy[name].source, rows: lazy[name].rows, metadata: lazy[name].metadata }
  ]));
}

/** @param {Record<string, InputSource>} sources @param {string[]} [requested] */
function parity(sources, requested = names) {
  const original = workerResults(baseline, sources, requested);
  const optimized = workerResults(queries, sources, requested);
  for (const name of requested) {
    const expected = original[name];
    if (name === 'campaign-insight-plot-inventory' && expected.metadata.availability === 'unavailable') {
      // The authorized alias removal changes only the diagnostic's immediate input layer.
      expect(expected.metadata['query-diagnostic']).toBe(
        '$.dashboard.queries[campaign-insight-plot-inventory]: input source "campaign-operational-value-plot-inventory" is unavailable.'
      );
      expect(optimized[name]).toStrictEqual({
        ...expected,
        metadata: {
          ...expected.metadata,
          'query-diagnostic': '$.dashboard.queries[campaign-insight-plot-inventory]: input source "campaign-operational-value-primary-series" is unavailable.'
        }
      });
    } else {
      expect(optimized[name]).toStrictEqual(expected);
    }
  }
  return optimized;
}

beforeEach(async () => {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
});

describe('campaign insight query optimization', () => {
  it('preserves the complete grouped series, native units, trends, carry tuples and ordered audit union', async () => {
    const sources = await canonicalSources();
    expect(sources['operational-values'].rows).toHaveLength(490);
    expect(new Set(sources['operational-values'].rows.map((row) => row['maturity-status'])))
      .toEqual(new Set(['matured', 'interim']));
    const result = parity(sources, graphNames);
    const primary = result['campaign-operational-value-primary-series'].rows;
    expect(primary.length).toBeGreaterThan(20);
    expect(primary.every((row) => Array.isArray(row.points) && row.points.length > 0)).toBe(true);
    expect(primary.some((row) => row.campaign === 'null-only')).toBe(false);
    expect(new Set(primary.map((row) => row['operational-value-direction'])))
      .toEqual(new Set(['increase', 'decrease', 'maintain', 'target']));
    expect(primary).toEqual(expect.arrayContaining([
      expect.objectContaining({
        'operational-value-unit': 'AIC', 'operational-value-direction': 'decrease',
        'trend-assessment': 'worsening', 'trend-observation-count': expect.any(Number),
        'workflow-slug': 'audit', 'adoption-at': '2026-09-05T00:00:00Z'
      })
    ]));
    const plotRows = result['campaign-insight-plot-inventory'].rows;
    expect(plotRows.slice(0, primary.length)).toStrictEqual(primary);
    expect(plotRows.slice(primary.length)).toStrictEqual(result['campaign-audit-summary-plot-inventory'].rows);
    expect(result['audit-event-summary-buckets'].rows.every((row) => (
      Object.keys(row).join(',') === 'campaign,event-status,workflow,event-summary,events'
    ))).toBe(true);
    expect(result['campaign-insight-tab-counts'].rows.find((row) => row.campaign === 'audit-only'))
      .toStrictEqual({ campaign: 'audit-only', items: 1 });
    for (const row of result['campaign-insight-tab-counts'].rows) {
      expect(row.items).toBe(plotRows.filter((plot) => plot.campaign === row.campaign).length);
    }
    for (const name of graphNames) expect(result[name].metadata.availability).toBe('available');
  });

  it('keeps null-only observations and empty canonical collections honestly empty', async () => {
    const input = evidence(0, 0);
    const sources = await canonicalSources(input);
    const empty = parity(sources, graphNames);
    for (const name of graphNames) {
      expect(empty[name].rows).toStrictEqual([]);
      expect(empty[name].metadata.availability).toBe('empty');
    }
  });

  it('preserves absent audit-summary own properties and counts plots rather than guessing from bucket counts', async () => {
    const input = evidence(4);
    for (const name of ['audits', 'tools']) {
      for (const row of input.inputs[/** @type {'audits'|'tools'} */ (name)].rows) {
        delete row['event-summary'];
      }
    }
    const sources = await canonicalSources(input);
    const results = parity(sources, graphNames);
    expect(results['audit-event-summary-buckets'].rows.length).toBeGreaterThan(0);
    for (const row of results['audit-event-summary-buckets'].rows) {
      expect(Object.hasOwn(row, 'event-summary')).toBe(false);
    }
    expect(results['campaign-audit-summary-plot-inventory'].rows)
      .toContainEqual({ campaign: 'audit-only', buckets: 0 });
    expect(results['campaign-insight-tab-counts'].rows)
      .toContainEqual({ campaign: 'audit-only', items: 1 });
  });

  it('preserves sparse single-point trends and every carried-field grouping boundary', async () => {
    const input = evidence(1, 1);
    input.values[0].value = 0;
    const results = parity(await canonicalSources(input), graphNames);
    expect(results['campaign-operational-value-primary-series'].rows).toStrictEqual([
      expect.objectContaining({
        campaign: 'beta', 'operational-value-unit': 'AIC',
        'trend-observation-count': 1, 'trend-assessment': 'insufficient',
        points: [expect.objectContaining({ y: 0 })]
      })
    ]);
  });

  it('does not turn null-only or invalid-time value observations into plots', async () => {
    const input = evidence(0, 4);
    for (const row of input.values) row.value = null;
    const sources = await canonicalSources(input);
    for (const result of Object.values(parity(sources, graphNames))) {
      expect(result.rows).toStrictEqual([]);
      expect(result.metadata.availability).toBe('empty');
    }
    const invalidTime = {
      ...sources,
      'operational-values': {
        ...sources['operational-values'],
        rows: sources['operational-values'].rows.map((row) => ({
          ...row, 'operational-value': 2, 'observed-at': 'invalid'
        }))
      }
    };
    for (const result of Object.values(parity(invalidTime, graphNames))) {
      expect(result.rows).toStrictEqual([]);
      expect(result.metadata.availability).toBe('empty');
    }
  });

  it('retains oldest and weakest evidence even when a union branch has no matching chart rows', async () => {
    const sources = await canonicalSources();
    const results = parity({
      ...sources,
      tools: {
        ...sources.tools,
        rows: sources.tools.rows.map((row) => ({ ...row, 'event-type': 'tool.call' })),
        metadata: metadata('tools', {
          'as-of': '2026-07-01T00:00:00Z', 'retrieved-at': '2026-07-01T01:00:00Z',
          freshness: 'stale', completeness: 'partial'
        })
      }
    });
    for (const name of names) {
      expect(results[name].rows.length).toBeGreaterThan(0);
      expect(results[name].metadata).toMatchObject({
        'as-of': '2026-07-01T00:00:00Z', 'retrieved-at': '2026-07-01T01:00:00Z',
        freshness: 'stale', completeness: 'partial'
      });
    }
  });

  it.each(canonicalNames)('preserves missing, unavailable, partial, stale and unknown %s evidence', async (name) => {
    const sources = await canonicalSources();
    const missing = { ...sources };
    delete missing[name];
    const missingResult = parity(missing, graphNames);
    const unavailable = parity({
      ...sources, [name]: { ...sources[name], metadata: metadata(name, { availability: 'unavailable' }) }
    }, graphNames);
    const stale = parity({
      ...sources,
      [name]: {
        ...sources[name], metadata: metadata(name, {
          freshness: 'stale', completeness: 'partial',
          'as-of': '2026-08-01T00:00:00Z', 'retrieved-at': '2026-08-01T01:00:00Z'
        })
      }
    });
    for (const selected of names) {
      expect(stale[selected].metadata).toMatchObject({
        freshness: 'stale', completeness: 'partial',
        'as-of': '2026-08-01T00:00:00Z', 'retrieved-at': '2026-08-01T01:00:00Z'
      });
      if (name === 'operational-values') {
        for (const result of [missingResult, unavailable]) {
          expect(result[selected].rows).toStrictEqual([]);
          expect(result[selected].metadata).toMatchObject({
            availability: 'unavailable',
            'query-error': { code: 'input-unavailable', source: 'operational-values' }
          });
        }
      } else {
        for (const result of [missingResult, unavailable]) {
          expect(result[selected].rows.length).toBeGreaterThan(0);
          expect(result[selected].metadata.completeness).toBe('partial');
        }
      }
    }
    parity({ ...sources, [name]: { ...sources[name], metadata: undefined } });
    parity({
      ...sources, [name]: { ...sources[name], rows: [], metadata: metadata(name, { availability: 'empty' }) }
    }, graphNames);
  });

  it('retains fail-closed duplicate workflow keys even for non-matching audit rows', async () => {
    const sources = await canonicalSources();
    const duplicate = { ...sources, workflows: {
      ...sources.workflows, rows: [...sources.workflows.rows, { ...sources.workflows.rows[0] }]
    } };
    const results = parity(duplicate, graphNames);
    expect(results['audit-event-summary-buckets'].metadata).toMatchObject({
      availability: 'unavailable',
      'query-diagnostic': '$.dashboard.queries[audit-event-summary-buckets]: joined source "workflows" contains more than one row per join key.'
    });
    for (const selected of names) expect(results[selected].metadata.completeness).toBe('partial');
    const nonMatching = {
      ...duplicate,
      audits: { ...sources.audits, rows: sources.audits.rows.map((row) => ({ ...row, 'event-type': 'tool.call' })) },
      tools: { ...sources.tools, rows: [] }
    };
    expect(parity(nonMatching, graphNames)['audit-event-summary-buckets'].metadata.availability).toBe('unavailable');
  });

  it('preserves raw objects and metadata under horizon, dimension, search and route compilation', async () => {
    const sources = await canonicalSources();
    const cases = [
      { routeParameters: { campaign: 'alpha' } },
      { routeParameters: { campaign: 'missing-campaign' } },
      { routeParameters: { campaign: 'alpha' }, queryContext: {
        timeWindow: { start: '2026-09-10T00:00:00Z', end: '2026-09-16T00:00:00Z' }
      } },
      { routeParameters: { campaign: 'alpha' }, queryContext: {
        filters: { repository: ['example/other'] }
      } },
      { routeParameters: { campaign: 'beta' }, queryContext: {
        search: { fields: ['campaign'], query: 'beta' }
      } },
      { routeParameters: { campaign: 'alpha' }, queryContext: {
        search: { fields: ['campaign'], query: 'no-match' }
      } }
    ];
    for (const name of names) {
      const page = {
        route: { 'hash-query-parameter': 'campaign' },
        views: [{ id: 'insight', mark: 'table', data: { source: name, 'route-field': 'campaign' } }]
      };
      for (const options of cases) {
        const original = compileDashboardViewPayloadQueries(page, 'campaign-insights', { ...options, queries: baseline });
        const optimized = compileDashboardViewPayloadQueries(page, 'campaign-insights', { ...options, queries });
        expect(optimized.aliases).toStrictEqual(original.aliases);
        const before = workerResults(/** @type {Query[]} */ (original.queries), sources, original.aliases);
        const after = workerResults(/** @type {Query[]} */ (optimized.queries), sources, optimized.aliases);
        expect(after).toStrictEqual(before);
        const rows = after[optimized.aliases[0]].rows;
        if (options.routeParameters.campaign === 'missing-campaign'
            || options.queryContext?.search?.query === 'no-match') {
          expect(rows).toStrictEqual([]);
        } else {
          expect(rows.length).toBeGreaterThan(0);
          expect(rows.every((row) => row.campaign === options.routeParameters.campaign)).toBe(true);
        }
      }
    }
  });

  it('removes only the unused identity alias while preserving audit projection and nested series', () => {
    const audit = queries.find((query) => query.name === 'audit-event-summary-buckets');
    expect(audit).toEqual(expect.objectContaining(originalGraph[0]));
    expect(audit && dashboardQueryOutputFields(audit, (name) => tableFields[name])).toStrictEqual([
      'campaign', 'event-status', 'workflow', 'event-summary', 'events'
    ]);
    expect(queries.some((query) => query.name === 'campaign-operational-value-plot-inventory')).toBe(false);
    for (const original of originalGraph.filter((query) => ![
      'campaign-insight-plot-inventory', 'campaign-operational-value-plot-inventory'
    ].includes(query.name))) {
      const current = queries.find((query) => query.name === original.name);
      expect(current).toEqual(expect.objectContaining(original));
    }
    for (const name of names) {
      const dependencies = resolveDashboardQuerySources(queries, [name]);
      expect(dependencies).toContain('campaign-operational-value-primary-series');
      expect(dependencies).not.toContain('campaign-operational-value-plot-inventory');
      expect(dependencies.filter((source) => Object.hasOwn(tableFields, source)))
        .toStrictEqual(canonicalNames);
    }
  });

  it('reduces actual complete-graph operations for both standalone requests and their shared batch', async () => {
    const sources = await canonicalSources(evidence(180, 489));
    const beforeAnalysis = analyzeDashboardComplexity({ dashboard: { queries: baseline } });
    const afterAnalysis = analyzeDashboardComplexity({ dashboard: { queries } });
    const expected = {
      'campaign-insight-tab-counts': [29, 138, 28, 115],
      'campaign-insight-plot-inventory': [23, 132, 22, 109]
    };
    for (const name of names) {
      const before = beforeAnalysis.inventory.find((query) => query.name === name);
      const after = afterAnalysis.inventory.find((query) => query.name === name);
      expect([
        before?.['total-row-read-units'], before?.['total-materialized-field-units'],
        after?.['total-row-read-units'], after?.['total-materialized-field-units']
      ]).toStrictEqual(expected[/** @type {keyof typeof expected} */ (name)]);
    }
    const mixedPage = [
      ...names, 'audit-event-summary-buckets', 'campaign-operational-value-primary-series'
    ];
    for (const requested of [...names.map((name) => [name]), names, mixedPage]) {
      const beforeBudget = createDashboardQueryBudget();
      const afterBudget = createDashboardQueryBudget();
      const original = executeDashboardQueries(baseline, sources, requested, { budget: beforeBudget });
      const optimized = executeDashboardQueries(queries, sources, requested, { budget: afterBudget });
      for (const name of requested) {
        expect(optimized[name].rows).toStrictEqual(original[name].rows);
        expect(optimized[name].metadata).toStrictEqual(original[name].metadata);
        expect(optimized[name].rows.length).toBeGreaterThan(0);
        expect(workerResults(queries, sources, [name])[name].rows).toStrictEqual(optimized[name].rows);
      }
      const graph = workerResults(baseline, sources, [
        'campaign-operational-value-primary-series', 'audit-event-summary-buckets'
      ]);
      const groups = graph['campaign-operational-value-primary-series'].rows;
      expect(groups.length).toBeGreaterThan(20);
      expect(graph['audit-event-summary-buckets'].rows.length).toBeGreaterThan(100);
      expect(beforeBudget.operations - afterBudget.operations).toBe(groups.length);
      expect(afterBudget.operations).toBeLessThan(beforeBudget.operations);
      process.stdout.write(`Campaign insight complete-graph operation reduction ${JSON.stringify({
        requested, before: beforeBudget.operations, after: afterBudget.operations,
        valueGroups: groups.length,
        removedShallowCopiedProperties: groups.reduce((total, row) => total + Object.keys(row).length, 0)
      })}\n`);
    }
  }, 30000);
});
