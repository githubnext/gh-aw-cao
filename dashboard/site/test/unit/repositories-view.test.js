import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderUiElement } from '../../src/components/ui-elements.js';
import { deriveRepositorySources, summarizeRepositories } from '../../src/repository-data.js';

const dashboard = JSON.parse(readFileSync(`${process.cwd()}/dashboard.json`, 'utf8'));

/** @type {import('../../src/presenter.js').SourceMetadata} */
const metadata = {
  'source-id': 'fixture',
  'source-kind': 'fixture',
  'as-of': '2026-08-31T18:00:00Z',
  'retrieved-at': '2026-08-31T18:01:00Z',
  completeness: 'complete',
  freshness: 'fresh',
  availability: 'available'
};

/**
 * @param {string} name
 * @param {Array<Record<string, unknown>>} rows
 * @param {Partial<import('../../src/presenter.js').SourceMetadata>} [overrides]
 */
function source(name, rows, overrides = {}) {
  return { source: name, rows, metadata: { ...metadata, ...overrides } };
}

function sources() {
  return {
    repositories: source('repositories', [
      { organization: 'octo', repository: 'quiet' },
      { organization: 'octo', repository: 'failing' },
      { organization: 'octo', repository: 'active' }
    ]),
    workflows: source('workflows', [
      { organization: 'octo', repository: 'failing', workflow: 'one', 'workflow-active': 'true' },
      { organization: 'octo', repository: 'failing', workflow: 'two', 'workflow-active': 'true' },
      { organization: 'octo', repository: 'active', workflow: 'three', 'workflow-active': 'true' },
      { organization: 'octo', repository: 'quiet', workflow: 'four', 'workflow-active': 'false' }
    ]),
    runs: source('runs', [
      { organization: 'octo', repository: 'failing', run: '1', 'run-conclusion': 'failure' },
      { organization: 'octo', repository: 'failing', run: '1', 'run-conclusion': 'failure' },
      { organization: 'octo', repository: 'failing', run: '2', 'run-conclusion': 'success' },
      { organization: 'octo', repository: 'active', run: '3', 'run-conclusion': 'success' }
    ], { 'coverage-start': '2026-08-30T18:00:00Z', 'coverage-end': '2026-08-31T18:00:00Z' }),
    outcomes: source('outcomes', [
      { organization: 'octo', repository: 'quiet', 'safe-output': 'report-1' }
    ]),
    usage: source('usage', [
      { organization: 'octo', repository: 'failing', workflow: 'one', invocation: 'usage-one', aic: 7 },
      { organization: 'octo', repository: 'failing', workflow: 'one', invocation: 'usage-two', aic: 2 },
      { organization: 'octo', repository: 'failing', workflow: 'two', invocation: 'usage-three', aic: 3 },
      { organization: 'octo', repository: 'active', run: '3', aic: 8 },
      { organization: 'octo', repository: 'usage-only', run: '4', aic: 100 }
    ], { completeness: 'partial' }),
    'operational-values': source('operational-values', [
      { organization: 'octo', repository: 'quiet', workflow: 'four', 'operational-value': 0.8, 'evaluator-digest': 'sha256:1' },
      { organization: 'octo', repository: 'quiet', workflow: 'four', 'operational-value': 0.9, 'evaluator-digest': 'sha256:1' }
    ])
  };
}

function context(sourceInputs = sources()) {
  const derivedSources = deriveRepositorySources(sourceInputs);
  return {
    pageId: 'repositories',
    title: 'Repositories',
    description: 'Repository health.',
    sourceNames: ['repository-summary'],
    sources: derivedSources,
    contextDetails: [],
    headingTag: /** @type {'h3'} */ ('h3')
  };
}

describe('repositories view', () => {
  it('aggregates repository activity using report ordering and status precedence', () => {
    const summaries = summarizeRepositories(sources());

    expect(summaries.map((summary) => summary.repository)).toEqual([
      'octo/failing',
      'octo/active',
      'octo/quiet'
    ]);
    expect(summaries[0]).toMatchObject({
      workflows: 2,
      runs: 2,
      failed: 1,
      aic: 12
    });
    expect(summaries[2]).toMatchObject({
      disabled: 1,
      reports: 1
    });
    expect(summaries[2].evaluatedWorkflowKeys.size).toBe(1);

    const activity = deriveRepositorySources(sources())['repository-activity'];
    expect(activity.rows).toEqual([
      expect.objectContaining({
        repository: 'octo/failing',
        workflows: 2,
        runs: 2,
        'failure-summary': '50% · 1 failed',
        status: 'Needs attention'
      }),
      expect.objectContaining({
        repository: 'octo/active',
        status: 'No failures observed'
      }),
      expect.objectContaining({
        repository: 'octo/quiet',
        status: 'Disabled workflows'
      })
    ]);
    expect(deriveRepositorySources(sources())['repository-workflows'].rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ repository: 'octo/failing', workflow: 'one', aic: 9 }),
      expect.objectContaining({ repository: 'octo/failing', workflow: 'two', aic: 3 })
    ]));
  });

  it('derives the configured scope and renders it through the reusable context summary', () => {
    const viewContext = context();
    const scope = /** @type {HTMLElement} */ (renderUiElement('context-summary', viewContext));
    const repositoriesPage = dashboard.dashboard.pages.find(
      (/** @type {{ id: string }} */ page) => page.id === 'repositories'
    );
    const summary = repositoriesPage.definition.views.find(
      (/** @type {{ id: string }} */ view) => view.id === 'repository-scope'
    );
    const usage = repositoriesPage.definition.views.find(
      (/** @type {{ id: string }} */ view) => view.id === 'repositories-by-aic'
    );
    const activity = repositoriesPage.definition.views.find(
      (/** @type {{ id: string }} */ view) => view.id === 'repositories-activity'
    );

    expect(scope.textContent).toContain('Repository scope · 3 configured');
    expect(scope.textContent).toContain('Complete 24-hour Actions run window');
    expect(scope.textContent).toContain('5 artifacts · partial');
    expect([...scope.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual([
      '#page-repository-detail?repository=octo%2Factive',
      '#page-repository-detail?repository=octo%2Ffailing',
      '#page-repository-detail?repository=octo%2Fquiet'
    ]);
    expect(summary).toMatchObject({
      data: {
        sources: ['repository-summary', 'repositories', 'runs', 'usage', 'operational-values']
      },
      mark: 'element',
      element: 'context-summary'
    });
    expect(usage).toMatchObject({
      data: { source: 'usage' },
      mark: 'chart',
      chart: 'pie',
      encoding: {
        x: { field: 'repository' },
        y: { field: 'aic', aggregate: 'sum', as: 'total-aic', unit: 'aic' },
        href: { field: 'repository-link' }
      }
    });
    expect(activity).toMatchObject({
      data: { source: 'repository-activity' },
      mark: 'table',
      controls: 'static',
      encoding: {
        columns: [
          { field: 'repository' },
          { field: 'workflows' },
          { field: 'reports' },
          { field: 'evaluated-workflows' },
          { field: 'runs' },
          { field: 'failure-summary' },
          { field: 'aic', unit: 'aic' },
          { field: 'status', display: 'status' }
        ],
        href: { field: 'repository-link' }
      }
    });
  });

  it('keeps unavailable run and usage evidence explicit', () => {
    const sourceInputs = sources();
    sourceInputs.runs.metadata = { ...metadata, availability: 'unavailable', completeness: 'unknown' };
    sourceInputs.usage.metadata = { ...metadata, availability: 'unavailable', completeness: 'unknown' };
    const derived = deriveRepositorySources(sourceInputs);
    const scope = /** @type {HTMLElement} */ (renderUiElement('context-summary', context(sourceInputs)));
    expect(scope.textContent).toContain('Actions run data unavailable');
    expect(scope.textContent).toContain('Usage data unavailable');
    expect(derived['repository-activity'].rows[0]).toMatchObject({
      runs: null,
      'failure-summary': 'Unavailable'
    });
  });

  it('derives route-scoped repository detail data for generic views', () => {
    const repositoryPage = dashboard.dashboard.pages.find(
      (/** @type {{ id: string }} */ page) => page.id === 'repository-detail'
    );
    const workflowsView = repositoryPage.views.find(
      (/** @type {{ id: string }} */ view) => view.id === 'repository-authored-workflows'
    );
    const workflowAicView = repositoryPage.views.find(
      (/** @type {{ id: string }} */ view) => view.id === 'repository-workflow-aic'
    );
    expect(repositoryPage.views[0].id).toBe('repository-workflow-aic');
    expect(workflowsView).toMatchObject({
      mark: 'table',
      controls: 'interactive',
      'column-summaries': true,
      encoding: {
        columns: expect.arrayContaining([
          { field: 'aic', type: 'quantitative', title: 'AIC', unit: 'aic' }
        ])
      }
    });
    expect(workflowAicView).toMatchObject({
      title: 'Top workflows by AIC',
      data: {
        source: 'repository-workflow-usage',
        'route-field': 'repository',
        limit: 5,
        'order-by': [{ field: 'total-aic', direction: 'desc' }]
      },
      mark: 'chart',
      chart: 'pie',
      encoding: {
        x: { field: 'workflow' },
        y: { field: 'aic', aggregate: 'sum', as: 'total-aic', unit: 'aic' },
        href: { field: 'workflow-link' }
      },
      layout: 'third'
    });

    const sourceInputs = sources();
    sourceInputs.workflows.rows[0] = {
      ...sourceInputs.workflows.rows[0],
      workflow: '.github/workflows/one.md',
      'workflow-name': 'One',
      'workflow-role': 'worker',
      'package-name': 'Maintenance',
      'rollout-mode': 'review',
      'observed-at': '2026-08-31T17:00:00Z',
      'workflow-link': {
        relation: 'workflow',
        href: 'https://github.com/octo/failing/blob/HEAD/.github/workflows/one.md',
        label: 'View One'
      }
    };

    const derived = deriveRepositorySources(sourceInputs);

    expect(derived['repository-detail-summary'].rows).toContainEqual(expect.objectContaining({
      repository: 'octo/failing',
      workflows: 2,
      'latest-update': '2026-08-31T17:00:00Z',
      'external-link': expect.objectContaining({ href: 'https://github.com/octo/failing/actions' })
    }));
    expect(derived['repository-workflow-status'].rows).toEqual(expect.arrayContaining([
      { repository: 'octo/failing', status: 'Active', workflows: 2 },
      { repository: 'octo/quiet', status: 'Disabled', workflows: 1 }
    ]));
    expect(derived['repository-workflow-usage'].rows).toEqual(expect.arrayContaining([
      { repository: 'octo/failing', workflow: 'one', invocation: 'usage-one', aic: 7 },
      { repository: 'octo/failing', workflow: 'one', invocation: 'usage-two', aic: 2 },
      { repository: 'octo/failing', workflow: 'two', invocation: 'usage-three', aic: 3 }
    ]));
    expect(derived['repository-workflows'].rows).toContainEqual(expect.objectContaining({
      repository: 'octo/failing',
      workflow: '.github/workflows/one.md',
      'workflow-name': 'One',
      'workflow-role': 'Worker',
      'package-name': 'Maintenance',
      'rollout-mode': 'review'
    }));
  });
});
