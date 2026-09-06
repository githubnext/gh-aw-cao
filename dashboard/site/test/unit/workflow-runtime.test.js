// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderWorkflowRuntime } from '../../src/components/workflow-runtime.js';
import { createWorkflowRoutePageView } from '../../src/components/workflow-route-page-views.js';
import { renderWorkflowRouteView } from '../../src/components/workflow-route-view.js';

const completeMetadata = {
  'source-id': 'fixture',
  'source-kind': 'fixture',
  'as-of': '2026-08-31T19:00:00Z',
  'retrieved-at': '2026-08-31T19:01:00Z',
  'coverage-start': '2026-08-30T19:00:00Z',
  'coverage-end': '2026-08-31T19:00:00Z',
  completeness: /** @type {'complete'} */ ('complete'),
  freshness: /** @type {'fresh'} */ ('fresh'),
  availability: /** @type {'available'} */ ('available')
};

const workflow = {
  organization: 'githubnext',
  repository: 'gh-aw-cao',
  workflow: '.github/workflows/multi-device-docs-tester.md',
  'workflow-name': 'Multi-Device Docs Tester',
  'workflow-role': 'standalone',
  package: 'testing',
  'package-name': 'Testing',
  'package-memberships': [
    { id: 'testing', name: 'Testing' },
    { id: 'central-agentic-ops', name: 'Central Agentic Ops' }
  ],
  'workflow-active': 'true',
  'rollout-mode': 'review',
  'workflow-link': {
    relation: 'workflow',
    href: 'https://github.com/githubnext/gh-aw-cao/blob/HEAD/.github/workflows/multi-device-docs-tester.md',
    label: 'View Multi-Device Docs Tester',
    'dashboard-href': '#page-workflow-runtime?workflow=githubnext%2Fgh-aw-cao%3A.github%2Fworkflows%2Fmulti-device-docs-tester.md',
    'dashboard-label': 'View Multi-Device Docs Tester workflow dashboard'
  }
};

/**
 * @param {Record<string, import('../../src/presenter.js').LogicalSourceInput>} [overrides]
 * @returns {import('../../src/components/ui-elements.js').ElementRenderContext}
 */
function context(overrides = {}) {
  return {
    pageId: 'workflow-runtime',
    title: 'Workflow runtime',
    sourceNames: ['workflows', 'runs', 'usage', 'operational-values'],
    contextDetails: [],
    routeParameter: 'workflow',
    headingTag: /** @type {'h3'} */ ('h3'),
    sources: {
      workflows: { source: 'workflows', metadata: completeMetadata, rows: [workflow] },
      runs: {
        source: 'runs',
        metadata: completeMetadata,
        rows: [
          { organization: 'githubnext', repository: 'gh-aw-cao', workflow: workflow.workflow, run: '1', 'run-status': 'completed', 'run-conclusion': 'success' },
          { organization: 'githubnext', repository: 'gh-aw-cao', workflow: workflow.workflow, run: '2', 'run-status': 'completed', 'run-conclusion': 'failure' },
          { organization: 'githubnext', repository: 'gh-aw-cao', workflow: workflow.workflow, run: '3', 'run-status': 'queued', 'run-conclusion': 'unknown' },
          { organization: 'other', repository: 'repo', workflow: workflow.workflow, run: '4', 'run-status': 'completed', 'run-conclusion': 'success' }
        ]
      },
      usage: {
        source: 'usage',
        metadata: { ...completeMetadata, completeness: /** @type {'partial'} */ ('partial') },
        rows: [
          { organization: 'githubnext', repository: 'gh-aw-cao', workflow: workflow.workflow, run: '1', aic: 42.5 },
          { organization: 'githubnext', repository: 'gh-aw-cao', workflow: workflow.workflow, run: '2', aic: 7.5 }
        ]
      },
      'operational-values': {
        source: 'operational-values',
        metadata: completeMetadata,
        rows: /** @type {Array<Record<string, unknown>>} */ ([])
      },
      ...overrides
    }
  };
}

/** @param {HTMLElement} rendered @param {string} [value] */
function selectWorkflow(rendered, value = 'githubnext/gh-aw-cao:.github/workflows/multi-device-docs-tester.md') {
  rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
    detail: { parameter: 'workflow', value }
  }));
}

describe('renderWorkflowRuntime', () => {
  it('defines reusable declarative workflow route page views', () => {
    expect(createWorkflowRoutePageView({
      id: 'workflow-runtime-route',
      title: 'Workflow runtime',
      body: 'insights',
      sources: ['workflows', 'runs', 'usage', 'operational-values'],
      layout: 'full'
    })).toEqual({
      id: 'workflow-runtime-route',
      title: 'Workflow runtime',
      data: {
        sources: ['workflows', 'runs', 'usage', 'operational-values']
      },
      mark: 'element',
      element: 'workflow-route',
      config: {
        body: 'insights'
      },
      layout: 'full'
    });
  });

  it('renders workflow identity, health, registration, usage, and the value empty state', () => {
    const rendered = renderWorkflowRuntime(context());
    selectWorkflow(rendered);

    expect(rendered.dataset.workflow).toBe('githubnext/gh-aw-cao:.github/workflows/multi-device-docs-tester.md');
    expect(rendered.querySelector('.repository-tabs')?.textContent).toBe('InsightsReportsRuns');
    expect(rendered.querySelector('.repository-tabs [aria-current="page"]')?.textContent).toBe('Insights');
    expect(rendered.querySelector('.repository-tabs a:last-child')?.getAttribute('href')).toBe(
      '#page-workflow-runs?workflow=githubnext%2Fgh-aw-cao%3A.github%2Fworkflows%2Fmulti-device-docs-tester.md'
    );
    expect(rendered.querySelector('.repository-tabs a:nth-child(2)')?.getAttribute('href')).toBe(
      '#page-workflow-detail?workflow=githubnext%2Fgh-aw-cao%3A.github%2Fworkflows%2Fmulti-device-docs-tester.md'
    );
    expect([...rendered.querySelectorAll('.workflow-badges .workflow-badge')].map((badge) => badge.textContent)).toEqual([
      'Standalone',
      'Package · Central Agentic Ops',
      'Package · Testing'
    ]);
    expect([...rendered.querySelectorAll('.workflow-badges a')].map((badge) => badge.getAttribute('href'))).toEqual([
      '#page-package-insights?package=central-agentic-ops',
      '#page-package-insights?package=testing'
    ]);
    expect(rendered.querySelector('.workflow-identity > a')?.getAttribute('href')).toBe(
      'https://github.com/githubnext/gh-aw-cao/blob/HEAD/.github/workflows/multi-device-docs-tester.md'
    );
    expect(rendered.querySelector('.workflow-identity > a')?.textContent).toBe('View authored workflow');
    expect(rendered.querySelector('.workflow-identity > a')?.getAttribute('target')).toBe('_blank');
    expect(rendered.querySelector('.workflow-health-chart svg')?.getAttribute('aria-label')).toContain('Successful 1, Failed 1');
    expect(rendered.querySelector('.workflow-run-health dt')?.textContent).toBe('Run health (last 24h)');
    expect(rendered.querySelector('.workflow-runtime-metrics')?.textContent).toContain('Complete 24-hour Actions run window');
    expect(rendered.querySelector('.workflow-runtime-metrics')?.textContent).toContain('Registrationactive');
    expect(rendered.querySelector('.workflow-runtime-metrics')?.textContent).toContain('AI Credits (last 24h)50.0 AIC');
    expect(rendered.querySelector('.workflow-runtime-metrics')?.textContent).toContain('2 runs with AIC telemetry; Partial 24-hour Actions run window');
    expect(rendered.querySelector('.value-report-empty')?.textContent).toContain('No workflow observations yet');
    expect(rendered.querySelector('.value-report-empty code')?.textContent).toBe('grader_results.json');
  });

  it('does not present missing partial AI Credit coverage as measured zero usage', () => {
    const sources = context().sources;
    sources.usage = {
      source: 'usage',
      metadata: { ...completeMetadata, completeness: /** @type {'partial'} */ ('partial') },
      rows: []
    };
    const rendered = renderWorkflowRuntime(context(sources));
    selectWorkflow(rendered);

    const usageMetric = [...rendered.querySelectorAll('.workflow-runtime-metrics > div')]
      .find((metric) => metric.querySelector('dt')?.textContent?.startsWith('AI Credits'));
    expect(usageMetric?.querySelector('dd')?.textContent).toBe('—');
    expect(usageMetric?.querySelector('p')?.textContent).toBe('0 runs with AIC telemetry; Partial 24-hour Actions run window');
  });

  it('renders retained operational-value observations and evidence', () => {
    const sources = context().sources;
    sources['operational-values'] = {
      source: 'operational-values',
      metadata: completeMetadata,
      rows: [
        {
          organization: 'githubnext',
          repository: 'gh-aw-cao',
          workflow: workflow.workflow,
          run: '0',
          'operational-value': 0.4,
          'operational-case': 'docs-run-1',
          'maturity-status': 'matured',
          'evaluator-digest': 'sha256:old',
          'requested-evidence-at': '2026-08-31T17:00:00Z',
          'observed-at': '2026-08-31T17:00:00Z'
        },
        {
          organization: 'githubnext',
          repository: 'gh-aw-cao',
          workflow: workflow.workflow,
          run: '1',
          'operational-value': 0.75,
          'operational-case': 'docs-run-1',
          'maturity-status': 'matured',
          'evaluator-digest': 'sha256:abcdefghijk',
          'requested-evidence-at': '2026-08-24T18:00:00Z',
          'observed-at': '2026-09-01T18:00:00Z',
          diagnostics: { 'repository-health': 0.4, 'oversized-file-share': 0.8, currentLines: 1907 },
          'diagnostic-definitions': [
            { id: 'repository-health', name: 'Repository health', direction: 'higher_is_better', aggregation: 'latest' },
            { id: 'oversized-file-share', name: 'Oversized file share', direction: 'lower_is_better', aggregation: 'latest' }
          ]
        },
        {
          organization: 'githubnext',
          repository: 'gh-aw-cao',
          workflow: workflow.workflow,
          run: '2',
          'operational-value': 0.8,
          'operational-case': 'docs-run-1',
          'maturity-status': 'matured',
          'evaluator-digest': 'sha256:abcdefghijk',
          'requested-evidence-at': '2026-08-31T18:00:00Z',
          'observed-at': '2026-09-01T19:00:00Z',
          diagnostics: { 'repository-health': 0.65, 'oversized-file-share': 0.5 },
          'diagnostic-definitions': [
            { id: 'repository-health', name: 'Repository health', direction: 'higher_is_better', aggregation: 'latest' },
            { id: 'oversized-file-share', name: 'Oversized file share', direction: 'lower_is_better', aggregation: 'latest' }
          ],
          'run-link': { relation: 'run', href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/2', label: 'Run 2' },
          'evidence-link': { relation: 'evidence', href: 'https://github.com/githubnext/gh-aw-cao/issues/1', label: 'Evidence 1' }
        }
      ]
    };
    const rendered = renderWorkflowRuntime(context(sources));
    selectWorkflow(rendered);

    expect(rendered.querySelector('.value-report-empty')).toBeNull();
    expect(rendered.querySelector('.value-score')?.textContent).toContain('80%');
    expect(rendered.querySelector('.value-chart')?.textContent).toContain('Mature average80%');
    expect(rendered.querySelector('.value-chart')?.textContent).toContain('Opportunities1');
    expect(rendered.querySelector('.value-outcomes')?.textContent).toContain('Outcome change from first observation');
    expect(rendered.querySelector('.value-outcomes')?.textContent).toContain('Repository health+25.0 pts');
    expect(rendered.querySelector('.value-outcomes')?.textContent).toContain('Oversized file share+30.0 pts');
    expect(rendered.querySelector('.value-outcomes')?.textContent).not.toContain('CurrentLines');
    expect(rendered.querySelector('.value-diagnostic-legend i.chart-series-1[aria-hidden="true"]')).not.toBeNull();
    expect(rendered.querySelector('.value-attainment')?.textContent).toContain('Weekly operational attainment');
    expect(rendered.querySelector('.value-attainment')?.textContent).toContain('4-week rolling mean');
    expect(rendered.querySelector('.value-attainment .chart-axis')?.textContent).toBe('Aug 24Aug 31');
    expect(rendered.querySelector('.value-attainment .primary-weekly')).not.toBeNull();
    expect(rendered.querySelector('.value-attainment .primary-rolling')).not.toBeNull();
    expect(rendered.querySelector('.value-details tbody')?.textContent).toContain('docs-run-1');
    expect(rendered.querySelectorAll('.value-details tbody tr')).toHaveLength(1);
    expect([...rendered.querySelectorAll('.value-details tbody a')].map((link) => link.getAttribute('href'))).toEqual([
      'https://github.com/githubnext/gh-aw-cao/actions/runs/2',
      'https://github.com/githubnext/gh-aw-cao/issues/1'
    ]);
  });

  it('distinguishes unavailable operational-value evidence from an observed empty result', () => {
    const sources = context().sources;
    sources['operational-values'] = {
      source: 'operational-values',
      metadata: { ...completeMetadata, availability: /** @type {'unavailable'} */ ('unavailable') },
      rows: /** @type {Array<Record<string, unknown>>} */ ([])
    };
    const rendered = renderWorkflowRuntime(context(sources));
    selectWorkflow(rendered);

    expect(rendered.querySelector('.value-report-empty')?.textContent).toContain('Unavailable');
    expect(rendered.querySelector('.value-report-empty')?.textContent).toContain('Operational-value evidence unavailable');
    expect(rendered.querySelector('.value-report-empty')?.textContent).not.toContain('No workflow observations yet');
  });

  it('reallocates page chrome and fails closed for invalid or missing routes', () => {
    const host = document.createElement('div');
    const rendered = renderWorkflowRuntime(context());
    host.append(rendered);
    let detail;
    host.addEventListener('dashboard-route-allocation', (event) => {
      if (event instanceof CustomEvent) detail = event.detail;
    });

    selectWorkflow(rendered);
    expect(detail).toEqual({
      title: 'Multi-Device Docs Tester',
      description: 'Run health, AI Credit usage, and operational value for .github/workflows/multi-device-docs-tester.md in githubnext/gh-aw-cao.',
      mode: 'review',
      navigationPage: 'packages'
    });

    selectWorkflow(rendered, '<invalid>');
    expect(rendered.textContent).toBe('Select a workflow to inspect its runtime.');
    selectWorkflow(rendered, 'githubnext/gh-aw-cao:.github/workflows/missing.md');
    expect(rendered.textContent).toBe('Workflow not found.');
  });

  it('uses declarative route view ids to choose the workflow insights composition', () => {
    const rendered = renderWorkflowRouteView({
      ...context(),
      pageId: 'custom-workflow-page',
      elementConfig: { body: 'insights' }
    });
    selectWorkflow(rendered);

    expect(rendered.querySelector('.repository-tabs [aria-current="page"]')?.textContent).toBe('Insights');
    expect(rendered.querySelector('.workflow-runtime-metrics')).not.toBeNull();
  });

  it('uses the declarative route view id for workflow insights composition', () => {
    const rendered = renderWorkflowRouteView({
      ...context(),
      pageId: 'workflow-detail',
      elementConfig: { body: 'insights' }
    });
    selectWorkflow(rendered);

    expect(rendered.querySelector('.repository-tabs [aria-current="page"]')?.textContent).toBe('Insights');
    expect(rendered.querySelector('.workflow-runtime-metrics')).not.toBeNull();
  });
});
