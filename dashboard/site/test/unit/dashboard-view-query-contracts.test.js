import { describe, expect, it } from 'vitest';
import { processDataRequest } from '../../src/data-worker.js';
import { dashboardQueryDefects, executeDashboardQueries } from '../../src/data/queries/declarative.js';
import { compileDashboardViewPayloadQueries } from '../../src/data/queries/view-payload-compiler.js';
import { CAMPAIGN_ROUTE_BODY_VALUES } from '../../src/components/route-body-specification.js';
import { SERVER_SOURCE_VALUES, TABLE_FIELDS } from '../../src/specification.js';

import { authoritativeDashboard as document } from '../authoritative-dashboard.js';
const dashboard = document.dashboard;
const queries = dashboard.queries;
const queryNames = new Set(queries.map((/** @type {{ name: string }} */ query) => query.name));
const tableNames = new Set(Object.keys(TABLE_FIELDS));
const dataSourceNames = new Set([...tableNames, ...SERVER_SOURCE_VALUES]);
const queriesByName = new Map(queries.map((/** @type {{ name: string }} */ query) => [query.name, query]));
const serverSourceNames = new Set(SERVER_SOURCE_VALUES);

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
 * @param {string} name
 * @param {Set<string>} [visited]
 * @returns {boolean}
 */
function requiresServerSource(name, visited = /** @type {Set<string>} */ (new Set())) {
  if (serverSourceNames.has(name)) return true;
  if (visited.has(name)) return false;
  visited.add(name);
  const query = queriesByName.get(name);
  if (!query) return false;
  const inputs = [
    query.from,
    ...(Array.isArray(query.union) ? query.union : []),
    ...(Array.isArray(query.joins) ? query.joins.map((/** @type {{ source: string }} */ join) => join.source) : [])
  ];
  return inputs.some((input) => typeof input === 'string' && requiresServerSource(input, visited));
}

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
    if (key === 'any' && typeof configured.label === 'string' && Array.isArray(nested)) {
      return nested.filter((name) => typeof name === 'string' && queryNames.has(name));
    }
    return declaredQueryReferences(nested);
  });
}

describe('dashboard view query contracts', () => {
  it('declares experimental evidence pages without presenting observation counts as campaign completion', () => {
    const evolutionSection = dashboard.navigation.find(
      (/** @type {{ label?: string }} */ section) => section.label === 'Evolution'
    );
    expect(evolutionSection?.pages).toEqual(['experiments', 'evals', 'graders']);
    for (const id of ['experiments', 'evals', 'graders']) {
      expect(dashboard.pages.find((/** @type {{ id?: string }} */ page) => page.id === id))
        .toMatchObject({ kind: 'custom', experimental: true });
    }
    const experiments = dashboard.pages.find((/** @type {{ id?: string }} */ page) => page.id === 'experiments');
    expect(viewsOf(experiments)).toMatchObject([
      { mark: 'chart', chart: 'horizontal-bar', data: { source: 'experiment-assignment-coverage' } },
      { mark: 'table', data: { source: 'experiments' }, 'lazy-list': true, layout: 'full-view' }
    ]);
    expect(viewsOf(dashboard.pages.find((/** @type {{ id?: string }} */ page) => page.id === 'evals'))[0])
      .toMatchObject({ data: { source: 'eval-yes-no-status' } });
    for (const id of ['evals', 'graders']) {
      const page = dashboard.pages.find((/** @type {{ id?: string }} */ candidate) => candidate.id === id);
      expect(viewsOf(page)[0]).toMatchObject({
        mark: 'table', 'lazy-list': true, layout: 'full-view',
        data: { 'order-by': [{ field: 'workflow', direction: 'asc' }, { field: 'observed-at', direction: 'desc' }] }
      });
      expect(page.description).toContain('TODO:');
    }
  });

  it('computes assignment coverage and explicit YES/NO grader verdicts from declared evidence sources', () => {
    const results = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
      operation: 'execute-dashboard-queries',
      queries,
      sourceNames: ['experiment-assignment-coverage', 'grader-status-ledger', 'eval-yes-no-status'],
      sources: {
        ...databaseTables,
        'experiment-assignments': {
          source: 'experiment-assignments', metadata,
          rows: [
            { organization: 'githubnext', repository: 'one', workflow: 'worker.md', experiment: 'prompt', run: '1' },
            { organization: 'githubnext', repository: 'one', workflow: 'worker.md', experiment: 'prompt', run: '2' },
            { organization: 'githubnext', repository: 'two', workflow: 'worker.md', experiment: 'prompt', run: '3' }
          ]
        },
        'eval-observations': {
          source: 'eval-observations', metadata,
          rows: [
            { workflow: 'worker.md', eval: 'answer', 'eval-result': 'YES' },
            { workflow: 'worker.md', eval: 'answer', 'eval-result': 'UNKNOWN' },
            { workflow: 'worker.md', eval: 'answer', 'eval-result': 'NO' }
          ]
        },
        'grader-observations': {
          source: 'grader-observations', metadata,
          rows: [
            { workflow: 'worker.md', grader: 'quality', status: 'pass' },
            { workflow: 'worker.md', grader: 'quality', status: 'failed' },
            { workflow: 'worker.md', grader: 'quality', status: 'unavailable' }
          ]
        }
      }
    }));
    expect(results['experiment-assignment-coverage'].rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ 'workflow-coordinate': 'githubnext/one:worker.md', experiment: 'prompt', assignments: 2 }),
      expect.objectContaining({ 'workflow-coordinate': 'githubnext/two:worker.md', experiment: 'prompt', assignments: 1 })
    ]));
    expect(results['grader-status-ledger'].rows.map((row) => row.verdict)).toEqual(['YES', 'NO', 'unknown']);
    expect(results['eval-yes-no-status'].rows.map((row) => row['eval-result'])).toEqual(['YES', 'NO']);
  });

  it('groups navigable experimental pages in one experimental section', () => {
    expect(dashboard.navigation.filter(
      (/** @type {{ experimental?: boolean }} */ section) => section.experimental === true
    )).toEqual([{
      label: 'Experimental',
      experimental: true,
      pages: [
        'operational-value',
        'friction',
        'skills',
        'steering',
        'simulators'
      ]
    }]);
  });

  it('places the Cost page in the Data section', () => {
    const page = dashboard.pages.find((/** @type {Record<string, unknown>} */ candidate) => candidate.id === 'cost');
    const dataSection = dashboard.navigation.find(
      (/** @type {Record<string, unknown>} */ section) => section.label === 'Data'
    );

    expect(/** @type {Record<string, unknown> | undefined} */ (dataSection)?.pages).toContain('cost');
    expect(page).toMatchObject({
      icon: 'credit-card'
    });
  });

  it('computes campaign cost without inventory, dispatch, or coverage dependencies', () => {
      const cost = queriesByName.get('cost-by-campaign');
      const totals = queriesByName.get('campaign-cost-totals');
      expect(cost?.from).toBe('campaigns');
      expect(cost?.joins?.map((/** @type {{ source: string }} */ join) => join.source)).toEqual(['campaign-cost-totals']);
      expect(totals?.from).toBe('workflows');
      expect(totals?.joins?.map((/** @type {{ source: string }} */ join) => join.source)).toEqual(['workflow-aic-totals']);

      const sources = {
        ...databaseTables,
        campaigns: {
          source: 'campaigns', metadata,
          rows: [
            { campaign: 'beta', 'campaign-name': 'Beta' },
            { campaign: 'alpha & one', 'campaign-name': 'Alpha & One' },
            { campaign: 'empty', 'campaign-name': 'Empty' }
          ]
        },
        workflows: {
          source: 'workflows', metadata,
          rows: [
            { organization: 'org', repository: 'repo', workflow: 'one.md', campaign: 'alpha & one', 'workflow-role': 'orchestrator' },
            { organization: 'org', repository: 'repo', workflow: 'two.md', campaign: 'alpha & one', 'workflow-role': 'worker' },
            { organization: 'org', repository: 'repo', workflow: 'three.md', campaign: 'beta', 'workflow-role': 'worker' },
            { organization: 'org', repository: 'repo', workflow: 'four.md', campaign: 'beta', 'workflow-role': 'standalone' }
          ]
        },
        runs: {
          source: 'runs', metadata,
          rows: [
            { organization: 'org', repository: 'repo', workflow: 'one.md', run: '1', 'run-attempt': 1, 'aic-total': 3 },
            { organization: 'org', repository: 'repo', workflow: 'one.md', run: '1', 'run-attempt': 2, 'aic-total': 5 },
            { organization: 'org', repository: 'repo', workflow: 'three.md', run: '2', 'run-attempt': 1, 'aic-total': 2 },
            { organization: 'org', repository: 'repo', workflow: 'four.md', run: '3', 'run-attempt': 1, 'aic-total': 100 }
          ]
        }
      };
      const results = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
        operation: 'execute-dashboard-queries', queries,
        sourceNames: ['cost-by-campaign', 'campaign-inventory'],
        sources
      }));
      expect(results['cost-by-campaign'].rows).toEqual([
        {
          'campaign-name': 'Alpha & One',
          'campaign-dashboard-link': {
            'dashboard-href': '#page-campaign-insights?campaign=alpha%20%26%20one',
            'dashboard-label': 'View Alpha & One campaign dashboard'
          },
          aic: 8
        },
        {
          'campaign-name': 'Beta',
          'campaign-dashboard-link': {
            'dashboard-href': '#page-campaign-insights?campaign=beta',
            'dashboard-label': 'View Beta campaign dashboard'
          },
          aic: 2
        },
        {
          'campaign-name': 'Empty',
          'campaign-dashboard-link': {
            'dashboard-href': '#page-campaign-insights?campaign=empty',
            'dashboard-label': 'View Empty campaign dashboard'
          },
          aic: 0
        }
      ]);
      expect(results['cost-by-campaign'].rows.map((row) => row.aic))
        .toEqual(results['campaign-inventory'].rows
          .sort((a, b) => Number(b.aic) - Number(a.aic))
          .map((row) => row.aic));
  });

  it('renders the Cost page with concise titles and a workflow bar chart', () => {
    const page = dashboard.pages.find((/** @type {Record<string, unknown>} */ candidate) => candidate.id === 'cost');
    expect(viewsOf(page)).toMatchObject([
      {
        id: 'cost-by-campaign',
        title: 'Cost per campaign',
        data: { source: 'cost-by-campaign' },
        mark: 'chart',
        chart: 'pie',
        encoding: {
          x: { field: 'campaign-name' },
          y: { field: 'aic', unit: 'aic' }
        }
      },
      {
        id: 'cost-by-repository',
        title: 'Cost per repository',
        data: { source: 'cost-by-repository' },
        mark: 'chart',
        chart: 'pie',
        encoding: {
          x: { field: 'repository-coordinate' },
          y: { field: 'aic', unit: 'aic' }
        }
      },
      {
        id: 'cost-by-workflow',
        title: 'Cost per workflow',
        data: { source: 'cost-by-workflow' },
        mark: 'chart',
        chart: 'horizontal-bar',
        encoding: {
          x: { field: 'workflow' },
          section: { field: 'repository-coordinate' },
          y: { field: 'aic', unit: 'aic' }
        }
      },
      {
        id: 'cost-per-workflow-run',
        title: 'Cost per workflow run',
        disclosure: 'supplemental',
        data: { source: 'cost-per-workflow-run' },
        mark: 'chart',
        chart: 'horizontal-bar',
        encoding: {
          x: { field: 'workflow' },
          section: { field: 'repository-coordinate' },
          y: { field: 'aic-per-run', unit: 'aic-per-run' }
        }
      },
      {
        id: 'engines-models-aic-insights',
        title: 'AIC per observed run',
        data: { source: 'engines-models-usage' },
        mark: 'table',
        layout: 'full-view',
        'lazy-list': true,
        encoding: {
          columns: [
            { field: 'summary' },
            { field: 'runs' },
            { field: 'minimum-aic-per-run' },
            { field: 'average-aic-per-run' },
            { field: 'maximum-aic-per-run' }
          ]
        }
      }
    ]);
  });

  it('renders experimental operational value as a chart followed by a full-view observations table', () => {
    const page = dashboard.pages.find(
      (/** @type {Record<string, unknown>} */ candidate) => candidate.id === 'operational-value'
    );
    const experimentalSection = dashboard.navigation.find(
      (/** @type {Record<string, unknown>} */ section) => section.experimental === true
    );

    expect(/** @type {Record<string, unknown> | undefined} */ (experimentalSection)?.pages)
      .toContain('operational-value');
    expect(page).toMatchObject({
      kind: 'built-in',
      page: 'operational-value',
      experimental: true
    });
    expect(viewsOf(page)[0]).toMatchObject({
      id: 'operational-value-history',
      data: { source: 'operational-values' },
      mark: 'chart',
      chart: 'line',
      encoding: {
        x: { field: 'observed-at', type: 'temporal' },
        y: { field: 'operational-value', type: 'quantitative' },
        color: { field: 'operational-value-definition', type: 'nominal' }
      }
    });
    expect(viewsOf(page)[1]).toMatchObject({
      id: 'operational-value-observations',
      title: 'Operational value observations',
      mark: 'table',
      layout: 'full-view',
      controls: 'interactive',
      'lazy-list': true
    });
    expect(/** @type {Record<string, unknown>} */ (page).definition).not.toHaveProperty('sections');
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

  it('keeps Overview runtime health independent from audit-heavy campaign run presentation', () => {
    const runtimeHealth = dashboard.queries.find(
      (/** @type {Record<string, unknown>} */ query) => query.name === 'campaign-runtime-health-groups'
    );
    const runtimeHealthInput = dashboard.queries.find(
      (/** @type {Record<string, unknown>} */ query) => query.name === 'campaign-runtime-health-runs'
    );

    expect(runtimeHealth).toMatchObject({ from: 'campaign-runtime-health-runs' });
    expect(runtimeHealthInput).toMatchObject({ from: 'overview-runs' });
    expect(declaredQueryReferences(runtimeHealthInput)).not.toContain('run-incomplete-outcomes');
    expect(declaredQueryReferences(runtimeHealthInput)).not.toContain('audits');
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
      'campaign-memory': 'memory',
      'campaign-detail': 'overview'
    };

    for (const [pageId, body] of Object.entries(primaryPages)) {
      const page = dashboard.pages.find((/** @type {Record<string, unknown>} */ candidate) => candidate.id === pageId);
      const firstView = viewsOf(page)[0];
      const sources = [
        'workflows',
        'campaign-insight-tab-counts',
        'campaign-problem-tab-counts',
        'campaign-issue-tab-counts',
        ...(pageId === 'campaign-insights'
          ? [
              'campaign-operational-value-primary-series',
              'campaign-operational-value-run-days',
              'campaign-operational-value-evidence-state'
            ]
          : [])
      ];
      expect(firstView).toMatchObject({
        data: {
          sources,
          arguments: [{ name: 'campaign', field: 'campaign' }]
        },
        mark: 'element',
        element: 'campaign-route',
        config: { body }
      });
    }

    expect(dashboard.pages.some((/** @type {Record<string, unknown>} */ page) => page.id === 'campaign-dispatches')).toBe(false);
  });

  it('keeps stable campaign route IDs with an Operational Value label across every entry path', () => {
    const campaignPages = dashboard.pages.filter((/** @type {Record<string, unknown>} */ page) => (
      /** @type {Record<string, unknown> | undefined} */ (page.route)?.['hash-query-parameter'] === 'campaign'
    ));
    const expectedTabs = [
      { id: 'insights', label: 'Operational Value', icon: 'graph', page: 'campaign-insights' },
      { id: 'problems', label: 'Failures', icon: 'alert', page: 'campaign-problems' },
      { id: 'issues', label: 'Reports', icon: 'issue-opened', page: 'campaign-issues' },
      { id: 'memory', label: 'Memory', icon: 'archive', page: 'campaign-memory' }
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
    expect(dashboard.pages.some((/** @type {Record<string, unknown>} */ page) => page.id === 'campaign-pull-requests')).toBe(false);
    expect(CAMPAIGN_ROUTE_BODY_VALUES).not.toContain('pull-requests');
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

    expect(viewsOf(insights)[0]).toMatchObject({
      data: {
        sources: [
          'workflows',
          'campaign-insight-tab-counts',
          'campaign-problem-tab-counts',
          'campaign-issue-tab-counts',
          'campaign-operational-value-primary-series',
          'campaign-operational-value-run-days',
          'campaign-operational-value-evidence-state'
        ],
        arguments: [{ name: 'campaign', field: 'campaign' }]
      },
      mark: 'element',
      element: 'campaign-route',
      config: { body: 'insights' }
    });

    expect(viewsOf(insights)[1]).toMatchObject({
      id: 'campaign-performance-baseline',
      data: {
        source: 'campaign-performance-baseline',
        'route-field': 'campaign'
      },
      mark: 'table',
      encoding: {
        columns: [
          { field: 'concluded-runs', title: 'Concluded runs' },
          { field: 'success-rate-display', title: 'Run success' },
          { field: 'reliability-signal', title: 'Reliability signal' },
          { field: 'produced-outputs', title: 'Produced outputs' },
          { field: 'production-signal', title: 'Production signal' },
          { field: 'aic-per-successful-run', title: 'Average AIC / successful run', unit: 'aic-per-run' }
        ]
      }
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

  it('builds a route-scoped selected-horizon campaign baseline with deterministic signals', () => {
    const page = dashboard.pages.find(
      (/** @type {Record<string, unknown>} */ candidate) => candidate.id === 'campaign-insights'
    );
    const payload = compileDashboardViewPayloadQueries(page, 'campaign-insights', {
      viewId: 'campaign-performance-baseline',
      routeParameters: { campaign: 'optimization' },
      queryContext: {
        timeWindow: {
          start: '2026-08-31T00:00:00Z',
          end: '2026-09-30T00:00:00Z'
        }
      },
      queries
    });
    const result = executeDashboardQueries(payload.queries, {
      runs: {
        source: 'runs',
        metadata,
        rows: [
          {
            organization: 'githubnext',
            repository: 'gh-aw-cao',
            workflow: 'optimization-worker.md',
            run: '100',
            'run-attempt': 1,
            'run-status': 'completed',
            'run-conclusion': 'success',
            'started-at': '2026-09-10T00:00:00Z',
            'safe-items-count': 2,
            'aic-total': 4
          },
          {
            organization: 'githubnext',
            repository: 'gh-aw-cao',
            workflow: 'optimization-worker.md',
            run: '101',
            'run-attempt': 1,
            'run-status': 'completed',
            'run-conclusion': 'success',
            'started-at': '2026-09-20T00:00:00Z',
            'safe-items-count': 0,
            'aic-total': 6
          },
          {
            organization: 'githubnext',
            repository: 'gh-aw-cao',
            workflow: 'optimization-worker.md',
            run: '102',
            'run-attempt': 1,
            'run-status': 'completed',
            'run-conclusion': 'failure',
            'started-at': '2026-09-25T00:00:00Z',
            'aic-total': 9
          },
          {
            organization: 'githubnext',
            repository: 'gh-aw-cao',
            workflow: 'optimization-worker.md',
            run: 'old',
            'run-attempt': 1,
            'run-status': 'completed',
            'run-conclusion': 'failure',
            'started-at': '2026-08-20T00:00:00Z',
            'aic-total': 20
          },
          {
            organization: 'githubnext',
            repository: 'gh-aw-cao',
            workflow: 'other-worker.md',
            run: 'other',
            'run-attempt': 1,
            'run-status': 'completed',
            'run-conclusion': 'failure',
            'started-at': '2026-09-25T00:00:00Z',
            'aic-total': 8
          }
        ]
      },
      workflows: {
        source: 'workflows',
        metadata,
        rows: [
          {
            organization: 'githubnext',
            repository: 'gh-aw-cao',
            workflow: 'optimization-worker.md',
            campaign: 'optimization',
            'campaign-name': 'Optimization',
            'workflow-name': 'Optimization worker',
            'workflow-role': 'worker'
          },
          {
            organization: 'githubnext',
            repository: 'gh-aw-cao',
            workflow: 'other-worker.md',
            campaign: 'other',
            'campaign-name': 'Other',
            'workflow-name': 'Other worker',
            'workflow-role': 'worker'
          }
        ]
      },
      audits: {
        source: 'audits',
        metadata,
        rows: []
      }
    }, payload.aliases);
    const baselineAlias = payload.aliases.find((alias) => alias.includes('campaign-performance-baseline'));

    expect(baselineAlias).toBeDefined();
    expect(result[baselineAlias ?? ''].rows).toEqual([{
      campaign: 'optimization',
      'concluded-runs': 3,
      'successful-runs': 2,
      'success-rate': 2 / 3,
      'success-rate-display': '66.7%',
      'success-rate-percent': (2 / 3) * 100,
      'reliability-signal': 'Unsuccessful runs observed',
      'produced-outputs': 2,
      'production-signal': 'Outputs produced; acceptance unverified',
      'aic-per-successful-run': 5
    }]);
  });

  it('renders one campaign problem as a dedicated full detail view', () => {
    const detailPage = dashboard.pages.find(
      (/** @type {Record<string, unknown>} */ candidate) => candidate.id === 'campaign-problem-detail'
    );
    const detailView = dashboard.views.find(
      (/** @type {Record<string, unknown>} */ candidate) => candidate.id === 'campaign-problem-detail-view'
    );

    expect(detailPage).toMatchObject({
      route: { 'hash-query-parameter': 'target-repository' },
      views: ['campaign-problem-detail-view']
    });
    expect(detailView).toMatchObject({
      data: { sources: ['campaign-problem-items'] },
      mark: 'element',
      element: 'problem-detail',
      layout: 'full'
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
        id: 'issues-by-status',
        data: { source: 'issue-safe-outputs' },
        mark: 'chart',
        chart: 'pie',
        encoding: {
          x: { field: 'issue-status-detail' },
          y: { field: 'entity-url', aggregate: 'count' }
        }
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
        'issue-state': 'CLOSED',
        'issue-closed': true,
        'issue-state-reason': 'COMPLETED',
        'issue-closed-at': '2026-09-20T12:30:00Z',
        'issue-status-observed-at': '2026-09-20T12:31:00Z',
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
        'issue-status': 'Closed',
        'issue-closing-status': 'Completed',
        'issue-status-detail': 'Closed: Completed',
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
        .filter((name) => !dataSourceNames.has(name) && !queryNames.has(name))
        .map((name) => `${page.id}/${view.id}: ${name}`)
    )));

    expect(unresolved).toEqual([]);
  });

  it('registers collection health as a server-owned query source', () => {
    expect(SERVER_SOURCE_VALUES).toContain('collection-health');
    expect(queries.find((/** @type {{ name: string }} */ query) => query.name === 'ingestion-health')?.from)
      .toBe('collection-health');
    const sourceNames = ['ingestion-queue-sizes'];
    const available = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
      operation: 'execute-dashboard-queries',
      queries,
      sourceNames,
      sources: {
        'collection-health': {
          source: 'collection-health',
          metadata: { ...metadata, availability: 'available' },
          rows: [{ configured: true, 'queue-depth': 8, 'pending-tasks': 2, 'backfill-queued-run-tasks': 13 }]
        }
      }
    }));
    expect(available['ingestion-queue-sizes'].rows).toEqual([
      { queue: 'Ready and scheduled', tasks: 8 },
      { queue: 'In flight', tasks: 2 },
      { queue: 'Backfill admitted (total)', tasks: 13 }
    ]);
    const unconfigured = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
      operation: 'execute-dashboard-queries', queries, sourceNames,
      sources: {
        'collection-health': {
          source: 'collection-health', metadata: { ...metadata, availability: 'available' },
          rows: [{ configured: false, 'queue-depth': 0, 'pending-tasks': 0, 'backfill-queued-run-tasks': 0 }]
        }
      }
    }));
    expect(unconfigured['ingestion-queue-sizes'].rows).toEqual([]);
    const denied = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
      operation: 'execute-dashboard-queries', queries, sourceNames, sources: {}
    }));
    expect(denied['ingestion-queue-sizes'].metadata.availability).toBe('unavailable');
  });

  it('registers GitHub quota usage as a server-owned query source', () => {
    expect(SERVER_SOURCE_VALUES).toContain('github-quota-usage');
    expect(queries.find((/** @type {{ name: string }} */ query) => query.name === 'github-api-usage')?.from)
      .toBe('github-quota-usage');
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

  it('materializes worker-resolvable view queries through the production worker handler', () => {
    expect([...dashboardQueryDefects(queries).entries()]).toEqual([]);
    const requested = [...new Set(dashboard.pages.flatMap((/** @type {Record<string, unknown>} */ page) => viewsOf(page).flatMap(sourceNamesOf)))]
      .filter((name) => queryNames.has(name));
    const workerRequested = requested.filter((name) => !requiresServerSource(name));
    expect(requested.filter((name) => requiresServerSource(name)).sort()).toEqual(['github-api-usage', 'ingestion-health', 'ingestion-queue-sizes']);
    const results = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
      operation: 'execute-dashboard-queries',
      queries,
      sources: databaseTables,
      sourceNames: workerRequested
    }));

    expect(Object.keys(results).sort()).toEqual([...workerRequested].sort());
    for (const name of workerRequested) {
      expect(results[name]?.source).toBe(name);
      expect(results[name]?.rows).toEqual(expect.any(Array));
      expect(results[name]?.metadata.availability, name).not.toBe('unavailable');
    }
  });
});