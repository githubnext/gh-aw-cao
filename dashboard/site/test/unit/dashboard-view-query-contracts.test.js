import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { processDataRequest } from '../../src/data-worker.js';
import { dashboardQueryDefects } from '../../src/data/queries/declarative.js';
import { SOURCE_FIELDS } from '../../src/specification.js';

const document = JSON.parse(readFileSync(`${process.cwd()}/dashboard.json`, 'utf8'));
const dashboard = document.dashboard;
const queries = dashboard.queries;
const queryNames = new Set(queries.map((/** @type {{ name: string }} */ query) => query.name));
const canonicalNames = new Set(Object.keys(SOURCE_FIELDS));

/** @type {import('../../src/presenter.js').SourceMetadata} */
const metadata = {
  'source-id': 'contract-fixture',
  'source-kind': 'fixture',
  'as-of': '2026-09-14T00:00:00Z',
  'retrieved-at': '2026-09-14T00:00:00Z',
  completeness: 'complete',
  freshness: 'fresh',
  availability: 'empty'
};

const canonicalSources = Object.fromEntries([...canonicalNames].map((name) => [name, {
  source: name,
  rows: [],
  metadata
}]));

/**
 * @param {unknown} page
 * @returns {Array<Record<string, unknown>>}
 */
function viewsOf(page) {
  if (!page || typeof page !== 'object' || Array.isArray(page)) return [];
  const configured = /** @type {Record<string, unknown>} */ (page);
  const body = configured.kind === 'built-in' && configured.definition && typeof configured.definition === 'object'
    ? /** @type {Record<string, unknown>} */ (configured.definition)
    : configured;
  return [
    ...(Array.isArray(body.views) ? body.views : []),
    ...(Array.isArray(body.sections) ? body.sections.flatMap((/** @type {unknown} */ section) => viewsOf(section)) : [])
  ];
}

/**
 * @param {unknown} view
 * @returns {string[]}
 */
function sourceNamesOf(view) {
  if (!view || typeof view !== 'object' || Array.isArray(view)) return [];
  const data = /** @type {Record<string, unknown>} */ (view).data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const configured = /** @type {Record<string, unknown>} */ (data);
  if (Array.isArray(configured.sources)) return configured.sources.filter((/** @type {unknown} */ name) => typeof name === 'string');
  return typeof configured.source === 'string' ? [configured.source] : [];
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function declaredQueryReferences(value) {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(declaredQueryReferences);
  const configured = /** @type {Record<string, unknown>} */ (value);
  return Object.entries(configured).flatMap(([key, nested]) => {
    if ((key === 'from' || key === 'source' || key === 'query') && typeof nested === 'string' && queryNames.has(nested)) {
      return [nested];
    }
    if ((key === 'sources' || key === 'union') && Array.isArray(nested)) {
      return nested.filter((name) => typeof name === 'string' && queryNames.has(name));
    }
    return declaredQueryReferences(nested);
  });
}

describe('dashboard view query contracts', () => {
  it('does not retain core experimental navigation sections', () => {
    expect(dashboard.navigation.filter(
      (/** @type {{ experimental?: boolean }} */ section) => section.experimental === true
    )).toEqual([]);
  });

  it('keeps assessment-sensitive high-cardinality views declaratively bounded', () => {
    const pagesById = new Map(dashboard.pages.map((/** @type {Record<string, unknown>} */ page) => [page.id, page]));
    const boundedViews = [
      ['workflows', 'top-workflow-runs', 250],
      ['runs', 'runs-last-week', 250],
      ['graders', 'graders-graders-source', 100],
      ['graders', 'graders-observations-source', 100],
      ['usage', 'usage-usage-source', 100],
      ['findings', 'findings-source', 100]
    ];

    for (const [pageId, viewId, limit] of boundedViews) {
      const view = viewsOf(pagesById.get(pageId)).find((candidate) => candidate.id === viewId);
      const data = /** @type {Record<string, unknown> | undefined} */ (view?.data);

      expect(data?.limit, `${pageId}/${viewId} should bound rendered source rows`).toBe(limit);
      expect(data?.['order-by'], `${pageId}/${viewId} should choose deterministic retained rows`).toEqual(expect.any(Array));
    }
  });

  it('keeps campaign run navigation first and failure views scoped to dispatches', () => {
    const page = dashboard.pages.find((/** @type {Record<string, unknown>} */ candidate) => candidate.id === 'campaign-runs');
    const views = viewsOf(page);

    expect(views[0]?.id).toBe('campaign-run-navigation');
    for (const viewId of ['campaign-failure-reason-distribution', 'campaign-failed-dispatch-table']) {
      const view = views.find((candidate) => candidate.id === viewId);
      expect(/** @type {Record<string, unknown> | undefined} */ (view?.data)?.source).toBe('dispatches');
    }
  });

  it('defaults repositories to bounded worker-computed pie charts', () => {
    const page = dashboard.pages.find((/** @type {Record<string, unknown>} */ candidate) => candidate.id === 'repositories');
    const views = viewsOf(page);

    expect(views.slice(0, 2)).toMatchObject([
      {
        id: 'repositories-value-created',
        data: { source: 'repository-value-created-top' },
        mark: 'chart',
        chart: 'pie'
      },
      {
        id: 'repositories-audit-issues',
        data: { source: 'repository-audit-issues-top' },
        mark: 'chart',
        chart: 'pie'
      }
    ]);
    for (const name of ['repository-value-created-top', 'repository-audit-issues-top']) {
      expect(queries.find((/** @type {{ name: string }} */ query) => query.name === name)).toMatchObject({
        limit: 10,
        aggregate: { by: ['repository-coordinate'] }
      });
    }
    expect(queries.find((/** @type {{ name: string }} */ query) => query.name === 'repository-value-created-top'))
      .toMatchObject({
        from: 'operational-values',
        aggregate: { values: [{ field: 'operational-value', as: 'value-created', reducer: 'count' }] }
      });
    expect(queries.find((/** @type {{ name: string }} */ query) => query.name === 'repository-audit-issues-top'))
      .toMatchObject({
        from: 'findings',
        aggregate: { values: [{ field: 'finding', as: 'audit-issues', reducer: 'count' }] }
      });
    expect(dashboard.views.find((/** @type {{ id: string }} */ view) => view.id === 'entity-repositories'))
      .toMatchObject({ data: { source: 'repositories' } });
  });

  it('renders issues as a top-repository chart with a full-view table and cards', () => {
    const page = dashboard.pages.find((/** @type {Record<string, unknown>} */ candidate) => candidate.id === 'issues');
    const views = viewsOf(page);

    expect(page).toMatchObject({
      kind: 'built-in',
      page: 'issues'
    });
    expect(views).toMatchObject([
      {
        id: 'issues-by-repository',
        data: { source: 'issue-repository-totals' },
        mark: 'chart',
        chart: 'pie'
      },
      {
        id: 'issues-source',
        data: {
          source: 'issue-safe-outputs',
          limit: 100
        },
        mark: 'table',
        controls: 'interactive',
        'lazy-list': true,
        layout: 'full-view'
      }
    ]);
    expect(queries.find((/** @type {{ name: string }} */ query) => query.name === 'issue-repository-totals'))
      .toMatchObject({
        from: 'issue-safe-outputs',
        limit: 10,
        aggregate: {
          by: ['repository-coordinate'],
          values: [{ field: 'entity-url', as: 'issues', reducer: 'count' }]
        }
      });
    expect(dashboard.navigation.flatMap(
      (/** @type {{ pages?: string[] }} */ section) => section.pages ?? []
    )).toContain('issues');
  });

  it('resolves every authored view source through canonical data or Dashboard Language', () => {
    const unresolved = dashboard.pages.flatMap((/** @type {Record<string, unknown>} */ page) => viewsOf(page).flatMap((view) => (
      sourceNamesOf(view)
        .filter((name) => !canonicalNames.has(name) && !queryNames.has(name))
        .map((name) => `${page.id}/${view.id}: ${name}`)
    )));

    expect(unresolved).toEqual([]);
  });

  it('does not retain queries unused by dashboard content or another retained query', () => {
    const retained = new Set(declaredQueryReferences({
      ...dashboard,
      queries: undefined
    }));
    const queryByName = new Map(queries.map((/** @type {{ name: string }} */ query) => [query.name, query]));
    const pending = [...retained];

    while (pending.length > 0) {
      const query = queryByName.get(pending.pop());
      for (const dependency of declaredQueryReferences(query)) {
        if (retained.has(dependency)) continue;
        retained.add(dependency);
        pending.push(dependency);
      }
    }

    expect([...queryNames].filter((name) => !retained.has(name))).toEqual([]);
  });

  it('materializes every declared view query through the production worker handler', () => {
    expect([...dashboardQueryDefects(queries).entries()]).toEqual([]);
    const requested = [...new Set(dashboard.pages.flatMap((/** @type {Record<string, unknown>} */ page) => viewsOf(page).flatMap(sourceNamesOf)))]
      .filter((name) => queryNames.has(name));
    const results = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
      operation: 'execute-dashboard-queries',
      queries,
      sources: canonicalSources,
      sourceNames: requested
    }));

    expect(Object.keys(results).sort()).toEqual([...requested].sort());
    for (const name of requested) {
      expect(results[name]?.source).toBe(name);
      expect(results[name]?.rows).toEqual(expect.any(Array));
    }
  });
});