import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { processDataRequest } from '../../src/data-worker.js';
import { dashboardQueryDefects } from '../../src/data/queries/declarative.js';
import { TABLE_FIELDS } from '../../src/specification.js';

const document = JSON.parse(readFileSync(`${process.cwd()}/dashboard.json`, 'utf8'));
const dashboard = document.dashboard;
const queries = dashboard.queries;
const queryNames = new Set(queries.map((/** @type {{ name: string }} */ query) => query.name));
const tableNames = new Set(Object.keys(TABLE_FIELDS));

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

const databaseTables = Object.fromEntries([...tableNames].map((name) => [name, {
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

  it('renders the failed-runs ledger as a bounded lazy table', () => {
    const page = dashboard.pages.find((/** @type {Record<string, unknown>} */ candidate) =>
      candidate.id === 'overview-failed-runs'
    );

    expect(viewsOf(page)).toMatchObject([{
      id: 'overview-failed-runs-ledger',
      data: {
        source: 'failed-runs',
        'order-by': [{ field: 'started-at', direction: 'desc' }]
      },
      mark: 'table',
      controls: 'interactive',
      'lazy-list': true,
      layout: 'full-view'
    }]);
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

  it('uses one shared route shell first across every primary campaign tab', () => {
    const primaryPages = {
      'campaign-insights': 'insights',
      'campaign-problems': 'problems',
      'campaign-runs': 'runs',
      'campaign-issues': 'issues',
      'campaign-detail': 'overview'
    };

    for (const [pageId, body] of Object.entries(primaryPages)) {
      const page = dashboard.pages.find((/** @type {Record<string, unknown>} */ candidate) => candidate.id === pageId);
      const firstView = viewsOf(page)[0];
      expect(firstView).toMatchObject({
        data: {
          sources: [
            'workflows',
            'campaign-insight-tab-counts',
            'campaign-problem-tab-counts',
            'campaign-issue-tab-counts'
          ],
          arguments: [{ name: 'campaign', field: 'campaign' }]
        },
        mark: 'element',
        element: 'campaign-route',
        config: { body }
      });
    }

    expect(dashboard.pages.some((/** @type {Record<string, unknown>} */ page) => page.id === 'campaign-dispatches')).toBe(false);
  });

  it('uses one declarative route template and Insights destination for every campaign entry path', () => {
    const campaignPages = dashboard.pages.filter((/** @type {Record<string, unknown>} */ page) => (
      /** @type {Record<string, unknown> | undefined} */ (page.route)?.['hash-query-parameter'] === 'campaign'
    ));
    const expectedTabs = [
      { id: 'insights', label: 'Insights', icon: 'graph', page: 'campaign-insights' },
      { id: 'problems', label: 'Problems', icon: 'alert', page: 'campaign-problems' },
      { id: 'issues', label: 'Issues', icon: 'issue-opened', page: 'campaign-issues' }
    ];

    for (const page of campaignPages) {
      expect(page.route).toMatchObject({
        'title-format': 'title-case',
        'tabs-class-name': 'campaign-tabs',
        tabs: expectedTabs
      });
    }
    expect(JSON.stringify(dashboard.queries)).not.toContain('#page-campaign-detail?campaign=');
    expect(JSON.stringify(dashboard.queries)).toContain('#page-campaign-insights?campaign=');
  });

  it('renders campaign issues with the reusable issue card template', () => {
    const page = dashboard.pages.find((/** @type {Record<string, unknown>} */ candidate) => candidate.id === 'campaign-issues');
    const issueView = viewsOf(page).find((view) => view.id === 'campaign-issue-table');

    expect(issueView).toMatchObject({
      data: { source: 'campaign-worker-issues', 'route-field': 'campaign' },
      mark: 'list',
      list: {
        style: 'entity-cards',
        card: 'issue',
        drill: { type: 'external', field: 'issue-link' }
      }
    });
  });

  it('keeps campaign content data-driven through reusable views and templates', () => {
    const insights = dashboard.pages.find((/** @type {Record<string, unknown>} */ candidate) => candidate.id === 'campaign-insights');
    const problems = dashboard.pages.find((/** @type {Record<string, unknown>} */ candidate) => candidate.id === 'campaign-problems');
    const runs = dashboard.pages.find((/** @type {Record<string, unknown>} */ candidate) => candidate.id === 'campaign-runs');

    expect(viewsOf(insights)[1]).toMatchObject({
      data: {
        sources: ['campaign-operational-grader-series'],
        arguments: [{ name: 'campaign', field: 'campaign' }]
      },
      mark: 'element',
      element: 'measure-history'
    });
    expect(viewsOf(problems).find((view) => view.id === 'campaign-current-runtime-problems')).toMatchObject({
      data: { source: 'campaign-problem-items' },
      mark: 'list',
      list: { style: 'entity-cards', card: 'problem' }
    });
    expect(viewsOf(runs).find((view) => view.id === 'campaign-run-status')).toMatchObject({
      data: { source: 'campaign-runs', 'route-field': 'campaign' },
      mark: 'chart'
    });
  });

  it('renders issues per repository and one activity inventory', () => {
    const page = dashboard.pages.find((/** @type {Record<string, unknown>} */ candidate) => candidate.id === 'repositories');
    const views = viewsOf(page);

    expect(views[0]).toMatchObject(
      {
        id: 'repositories-issues',
        data: { source: 'issue-repository-totals' },
        mark: 'chart',
        chart: 'pie'
      }
    );
    expect(queries.find((/** @type {{ name: string }} */ query) => query.name === 'issue-repository-totals'))
      .toMatchObject({
        from: 'issue-safe-outputs',
        limit: 10,
        aggregate: {
          by: ['repository-coordinate'],
          values: [{ field: 'entity-url', as: 'issues', reducer: 'count' }]
        }
      });
    expect(views.map((view) => view.id)).toEqual([
      'repositories-issues',
      'repositories-activity'
    ]);
    expect(views[1]).toMatchObject({
      data: { source: 'repository-activity' },
      mark: 'table'
    });
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

  it('keeps issue repository totals available when audit records are unavailable', () => {
    const availableMetadata = { ...metadata, availability: 'available' };
    const unavailableMetadata = { ...metadata, availability: 'unavailable', completeness: 'partial' };
    const issueRows = [
      {
        organization: 'githubnext',
        repository: 'gh-aw-cao',
        workflow: '.github/workflows/worker.md',
        run: '101',
        'run-attempt': 1,
        'event-type': 'safe_output.created',
        'event-timestamp': '2026-09-20T12:00:00Z',
        'github-entity-type': 'issue',
        'is-pull-request': false,
        'safe-output-type': 'create_issue',
        'event-summary': 'Fix issue view',
        'correlation-id': 'https://github.com/githubnext/gh-aw-cao/issues/13439'
      },
      {
        organization: 'githubnext',
        repository: 'gh-aw-cao',
        workflow: '.github/workflows/worker.md',
        run: '102',
        'run-attempt': 1,
        'event-type': 'safe_output.created',
        'event-timestamp': '2026-09-20T13:00:00Z',
        'github-entity-type': 'pull_request',
        'is-pull-request': true,
        'safe-output-type': 'create_pull_request',
        'event-summary': 'Ignore pull request',
        'correlation-id': 'https://github.com/githubnext/gh-aw-cao/pull/13440'
      }
    ];
    const results = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
      operation: 'execute-dashboard-queries',
      queries,
      sourceNames: ['issue-safe-outputs', 'issue-repository-totals'],
      sources: {
        audits: { source: 'audits', rows: [], metadata: unavailableMetadata },
        issues: { source: 'issues', rows: issueRows, metadata: availableMetadata },
        runs: {
          source: 'runs',
          rows: [{
            organization: 'githubnext',
            repository: 'gh-aw-cao',
            workflow: '.github/workflows/worker.md',
            run: '101',
            'run-attempt': 1,
            'run-link': {
              relation: 'run',
              href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/101',
              label: 'Run 101'
            }
          }],
          metadata: availableMetadata
        }
      }
    }));

    expect(results['issue-safe-outputs'].metadata.availability).toBe('available');
    expect(results['issue-safe-outputs'].rows).toEqual([
      expect.objectContaining({
        'event-summary': 'Fix issue view',
        'entity-url': 'https://github.com/githubnext/gh-aw-cao/issues/13439',
        repository: 'gh-aw-cao'
      })
    ]);
    expect(results['issue-repository-totals'].metadata.availability).toBe('available');
    expect(results['issue-repository-totals'].rows).toEqual([
      { 'repository-coordinate': 'githubnext/gh-aw-cao', issues: 1 }
    ]);
  });

  it('resolves every authored view source through canonical data or Dashboard Language', () => {
    const unresolved = dashboard.pages.flatMap((/** @type {Record<string, unknown>} */ page) => viewsOf(page).flatMap((view) => (
      sourceNamesOf(view)
        .filter((name) => !tableNames.has(name) && !queryNames.has(name))
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
      sources: databaseTables,
      sourceNames: requested
    }));

    expect(Object.keys(results).sort()).toEqual([...requested].sort());
    for (const name of requested) {
      expect(results[name]?.source).toBe(name);
      expect(results[name]?.rows).toEqual(expect.any(Array));
    }
  });
});