// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderWorkflowRuntime } from '../../src/components/workflow-runtime.js';
import { createWorkflowRoutePageView } from '../../src/components/workflow-route-page-views.js';
import { renderWorkflowRoutePage } from '../../src/components/workflow-route-page.js';

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
  campaign: 'testing',
  'campaign-name': 'Testing',
  'campaign-memberships': [
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
    sourceNames: ['workflows', 'runs', 'usage'],
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
      sources: ['workflows', 'runs', 'usage'],
      layout: 'full'
    })).toEqual({
      id: 'workflow-runtime-route',
      title: 'Workflow runtime',
      data: {
        sources: ['workflows', 'runs', 'usage']
      },
      mark: 'element',
      element: 'workflow-route-page',
      config: {
        body: 'insights'
      },
      layout: 'full'
    });
  });

  it('renders workflow identity, health, registration, and usage', () => {
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
      'Campaign · Central Agentic Ops',
      'Campaign · Testing'
    ]);
    expect([...rendered.querySelectorAll('.workflow-badges a')].map((badge) => badge.getAttribute('href'))).toEqual([
      '#page-campaign-insights?campaign=central-agentic-ops',
      '#page-campaign-insights?campaign=testing'
    ]);
    expect(rendered.querySelector('.workflow-identity > a')?.getAttribute('href')).toBe(
      'https://github.com/githubnext/gh-aw-cao/blob/HEAD/.github/workflows/multi-device-docs-tester.md'
    );
    expect(rendered.querySelector('.workflow-identity > a')?.textContent).toBe('View authored workflow');
    expect(rendered.querySelector('.workflow-identity > a')?.getAttribute('target')).toBe('_blank');
    expect(rendered.querySelector('.workflow-health-chart svg')?.getAttribute('aria-label')).toContain('Successful 1, Failed 1');
    expect(rendered.querySelector('.workflow-run-health dt')?.textContent).toBe('Run health (last 24h)');
    expect(rendered.querySelector('.workflow-runtime-metrics')?.textContent).toContain('24-hour Actions run window');
    expect(rendered.querySelector('.workflow-runtime-metrics')?.textContent).toContain('Registrationactive');
    expect(rendered.querySelector('.workflow-runtime-metrics')?.textContent).toContain('AI Credits (last 24h)50.0');
    expect(rendered.querySelector('.workflow-runtime-metrics')?.textContent).not.toContain('50.0 AIC');
    expect(rendered.querySelector('.workflow-runtime-metrics')?.textContent).toContain('2 runs with AIC telemetry; 24-hour Actions run window');
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
    expect(usageMetric?.querySelector('dd')?.textContent).toBe('');
    expect(usageMetric?.querySelector('p')?.textContent).toBe('0 runs with AIC telemetry; 24-hour Actions run window');
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
      description: 'Run health and AI Credit usage for .github/workflows/multi-device-docs-tester.md in githubnext/gh-aw-cao.',
      titleLink: {
        href: 'https://github.com/githubnext/gh-aw-cao/blob/HEAD/.github/workflows/multi-device-docs-tester.md',
        label: 'Open Multi-Device Docs Tester workflow on GitHub'
      },
      mode: 'review',
      navigationPage: 'campaigns'
    });

    selectWorkflow(rendered, '<invalid>');
    expect(rendered.textContent).toBe('Select a workflow to inspect its runtime.');
    selectWorkflow(rendered, 'githubnext/gh-aw-cao:.github/workflows/missing.md');
    expect(rendered.textContent).toBe('Workflow not found.');
  });

  it('keeps workflow-route-page navigation aligned with the configured page route', () => {
    const rendered = renderWorkflowRoutePage({
      ...context(),
      pageId: 'custom-workflow-page',
      elementConfig: { body: 'insights' }
    });
    selectWorkflow(rendered);

    expect(rendered.querySelector('.repository-tabs [aria-current="page"]')?.textContent).toBe('Insights');
    expect(rendered.querySelector('.repository-tabs [aria-current="page"]')?.getAttribute('href')).toBe(
      '#page-workflow-runtime?workflow=githubnext%2Fgh-aw-cao%3A.github%2Fworkflows%2Fmulti-device-docs-tester.md'
    );
    expect(rendered.querySelector('.workflow-runtime-metrics')).not.toBeNull();
  });
});
