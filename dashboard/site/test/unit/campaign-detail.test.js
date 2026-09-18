// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderCampaignRouteVariant, renderCampaignRouteView } from '../../src/components/campaign-route-view.js';

const metadata = {
  'source-id': 'fixture',
  'source-kind': 'fixture',
  'as-of': '2026-08-31T18:00:00Z',
  'retrieved-at': '2026-08-31T18:01:00Z',
  completeness: /** @type {'complete'} */ ('complete'),
  freshness: /** @type {'fresh'} */ ('fresh'),
  availability: /** @type {'available'} */ ('available')
};

const workflows = [
  {
    campaign: 'ambient-context',
    'campaign-name': 'Ambient Context',
    organization: 'githubnext',
    repository: 'gh-aw-cao',
    workflow: '.github/workflows/ambient-context.md',
    'workflow-name': 'Ambient Context',
    'workflow-role': 'orchestrator',
    'rollout-mode': 'review',
    'campaign-description': 'Keeps repository guidance current.',
    'campaign-readme-path': 'ambient-context/README.md',
    'campaign-readme': '# Ambient Context\n\nKeeps shared guidance current. See the [guide](docs/guide.md).\n\n## Capabilities\n\n- Reviews context\n- Proposes updates',
    'repository-link': {
      relation: 'repository',
      href: 'https://ghe.example/githubnext/gh-aw-cao',
      label: 'View githubnext/gh-aw-cao'
    },
    'workflow-link': {
      relation: 'workflow',
      href: 'https://github.com/githubnext/gh-aw-cao/blob/HEAD/.github/workflows/ambient-context.md',
      label: 'View Ambient Context',
      'dashboard-href': '#page-workflow-runtime?workflow=githubnext%2Fgh-aw-cao%3A.github%2Fworkflows%2Fambient-context.md',
      'dashboard-label': 'View Ambient Context workflow dashboard'
    }
  },
  {
    campaign: 'ambient-context',
    'campaign-name': 'Ambient Context',
    organization: 'githubnext',
    repository: 'gh-aw-cao',
    workflow: '.github/workflows/ambient-context-agents-md-curator.md',
    'workflow-name': 'Ambient Context / AGENTS.md',
    'workflow-role': 'worker',
    'rollout-mode': 'review'
  },
  {
    campaign: 'other',
    'campaign-name': 'Other',
    workflow: '.github/workflows/other.md',
    'workflow-name': 'Other',
    'workflow-role': 'orchestrator',
    'rollout-mode': 'live'
  }
];

const operationalValues = [
  {
    organization: 'githubnext',
    repository: 'gh-aw-cao',
    workflow: '.github/workflows/ambient-context-agents-md-curator.md',
    run: '100',
    'operational-value': 0.5,
    'operational-case': 'repository:github/example',
    'evaluator-digest': 'sha256:current',
    'requested-evidence-at': '2026-08-17T18:00:00Z',
    'observed-at': '2026-08-24T18:00:00Z',
    'maturity-status': 'matured'
  },
  {
    organization: 'githubnext',
    repository: 'gh-aw-cao',
    workflow: '.github/workflows/ambient-context-agents-md-curator.md',
    run: '101',
    'operational-value': 0.75,
    'operational-case': 'repository:github/example-2',
    'evaluator-digest': 'sha256:current',
    'requested-evidence-at': '2026-08-24T18:00:00Z',
    'observed-at': '2026-08-31T18:00:00Z',
    'maturity-status': 'matured'
  },
  {
    organization: 'githubnext',
    repository: 'gh-aw-cao',
    workflow: '.github/workflows/other.md',
    run: '102',
    'operational-value': 1,
    'operational-case': 'repository:github/other',
    'evaluator-digest': 'sha256:other',
    'requested-evidence-at': '2026-08-24T18:00:00Z',
    'observed-at': '2026-08-31T18:00:00Z',
    'maturity-status': 'matured'
  }
];

const outcomes = [
  {
    campaign: 'ambient-context',
    workflow: '.github/workflows/ambient-context.md',
    'workflow-name': 'Ambient Context',
    'safe-output': 'ambient-issue-1',
    'outcome-title': 'Review ambient context proposal',
    'outcome-summary': 'A review proposal is ready.',
    'outcome-category': 'issue',
    'outcome-state': 'pending',
    'rollout-mode': 'review',
    'observed-at': '2026-08-31T17:00:00Z'
  },
  {
    campaign: 'ambient-context',
    workflow: '.github/workflows/ambient-context-agents-md-curator.md',
    'workflow-name': 'Ambient Context / AGENTS.md',
    'safe-output': 'ambient-pr-2',
    'outcome-title': 'Reconcile AGENTS.md guidance',
    'outcome-summary': 'Updated durable guidance.',
    'outcome-category': 'pull-request',
    'outcome-status': 'closed',
    'outcome-state': 'lifecycle-close',
    'rollout-mode': 'live',
    'observed-at': '2026-08-30T16:00:00Z'
  },
  {
    campaign: 'other',
    workflow: '.github/workflows/ambient-context.md',
    'workflow-name': 'Other',
    'safe-output': 'other-1',
    'outcome-title': 'Other campaign report',
    'outcome-summary': 'Not part of the selected campaign.',
    'outcome-category': 'issue',
    'outcome-status': 'open',
    'rollout-mode': 'live',
    'observed-at': '2026-08-29T15:00:00Z'
  }
];

function context() {
  return {
    pageId: 'campaign-detail',
    title: 'Orchestrator and workers',
    sourceNames: ['workflows'],
    contextDetails: [],
    routeParameter: 'campaign',
    headingTag: /** @type {'h3'} */ ('h3'),
    sources: {
      workflows: { source: 'workflows', metadata, rows: workflows },
      outcomes: { source: 'outcomes', metadata, rows: outcomes },
      'operational-values': { source: 'operational-values', metadata, rows: operationalValues }
    }
  };
}

describe('campaign detail route', () => {
  it('renders the Insights facet for the selected campaign', () => {
    const rendered = renderCampaignRouteView({
      ...context(),
      pageId: 'campaign-insights',
      sourceNames: ['workflows'],
      elementConfig: { body: 'insights' }
    });
    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'campaign', value: 'ambient-context' }
    }));

    expect(rendered.querySelector('.campaign-tabs [aria-current="page"]')?.textContent).toBe('Insights');
  expect(rendered.querySelector('.campaign-value-history')?.textContent).toContain('No operational-value extracts were observed');
  });

  it('renders reusable navigation for the selected campaign workflow view', () => {
    const rendered = renderCampaignRouteVariant(context(), 'overview');
    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'campaign', value: 'ambient-context' }
    }));

    expect(rendered.dataset.campaign).toBe('ambient-context');
    expect(rendered.querySelector('.campaign-tabs')?.textContent).toBe('OverviewInsightsWorkflowsRunsIssues');
    expect(rendered.querySelector('.campaign-tabs [aria-current="page"]')?.getAttribute('href')).toBe('#page-campaign-detail?campaign=ambient-context');
    expect([...rendered.querySelectorAll('.campaign-tabs a')].map((link) => link.getAttribute('href'))).toEqual([
      '#page-campaign-detail?campaign=ambient-context',
      '#page-campaign-insights?campaign=ambient-context',
      '#page-campaign-workflows?campaign=ambient-context',
      '#page-campaign-runs?campaign=ambient-context',
      '#page-campaign-issues?campaign=ambient-context'
    ]);
    expect([...rendered.querySelectorAll('.campaign-tabs a')].map((link) => link.getAttribute('data-nav-page-id'))).toEqual([
      'campaign-detail',
      'campaign-insights',
      'campaign-workflows',
      'campaign-runs',
      'campaign-issues'
    ]);
    expect(rendered.querySelector('.campaign-readme h1')?.textContent).toBe('Ambient Context');
    expect(rendered.querySelector('.campaign-readme h2')?.textContent).toBe('Capabilities');
    expect(rendered.querySelectorAll('.campaign-readme li')).toHaveLength(2);
    expect(rendered.querySelector('.campaign-readme-about')?.textContent).toContain('Keeps repository guidance current.');
    expect(rendered.querySelector('.campaign-marketplace-detail')?.getAttribute('data-campaign')).toBe('ambient-context');
    expect(rendered.querySelector('.campaign-marketplace-title')?.textContent).toBe('Ambient ContextCampaign');
    expect(rendered.querySelector('.campaign-rollout')?.textContent).toBe('review');
    expect(rendered.querySelector('.campaign-marketplace-actions a')?.getAttribute('href')).toBe('https://ghe.example/githubnext/gh-aw-cao/blob/HEAD/ambient-context/README.md');
    expect([...rendered.querySelectorAll('.campaign-readme a')].find((link) => link.textContent === 'guide')?.getAttribute('href')).toBe('https://ghe.example/githubnext/gh-aw-cao/blob/HEAD/ambient-context/docs/guide.md');
    const resources = /** @type {HTMLDetailsElement} */ (rendered.querySelector('.campaign-readme-resources'));
    expect(resources.open).toBe(false);
    expect(resources.querySelector('summary')?.textContent).toBe('ResourcesShow details');
    resources.open = true;
    expect(resources.textContent).toContain('Source repository');
    expect([...resources.querySelectorAll('a')].at(-1)?.getAttribute('href')).toBe('https://ghe.example/githubnext/gh-aw-cao');
    expect(rendered.textContent).not.toContain('Other');
  });

  it('renders workflow tab composition through the reusable campaign route variant primitive', () => {
    const rendered = renderCampaignRouteVariant(context(), 'workflows');
    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'campaign', value: 'ambient-context' }
    }));

    expect(rendered.querySelector('.campaign-tabs [aria-current="page"]')?.getAttribute('href')).toBe('#page-campaign-workflows?campaign=ambient-context');
    expect(rendered.querySelector('.campaign-tabs')?.textContent).toBe('OverviewInsightsWorkflowsRunsIssues');
  });

  describe('workflow run navigation', () => {
    it('renders campaign-scoped workflow run navigation and identity', () => {
      const host = document.createElement('div');
      const rendered = renderCampaignRouteView({ ...context(), pageId: 'campaign-runs', elementConfig: { body: 'runs' } });
      host.append(rendered);
      let detail;
      host.addEventListener('dashboard-route-allocation', (event) => {
        if (event instanceof CustomEvent) detail = event.detail;
      });

      rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
        detail: { parameter: 'campaign', value: 'ambient-context' }
      }));

      expect(rendered.querySelector('.campaign-tabs [aria-current="page"]')?.getAttribute('href')).toBe('#page-campaign-runs?campaign=ambient-context');
      expect(detail).toEqual({
        title: 'Ambient Context',
        description: 'Workflow runs for the Ambient Context campaign.',
        mode: 'review',
        navigationPage: 'campaigns'
      });
    });

    it('uses the trusted target mode for campaign navigation', () => {
      const host = document.createElement('div');
      const targetModeWorkflows = workflows.map((workflow) => workflow.campaign === 'ambient-context'
        ? { ...workflow, 'campaign-targets': [{ repository: 'githubnext/gh-aw-cao', mode: 'live' }] }
        : workflow);
      const rendered = renderCampaignRouteVariant({
        ...context(),
        sources: { ...context().sources, workflows: { source: 'workflows', metadata, rows: targetModeWorkflows } }
      }, 'overview');
      host.append(rendered);
      let detail;
      host.addEventListener('dashboard-route-allocation', (event) => {
        if (event instanceof CustomEvent) detail = event.detail;
      });

      rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
        detail: { parameter: 'campaign', value: 'ambient-context' }
      }));

      expect(detail).toEqual(expect.objectContaining({ mode: 'live' }));
    });
  });

  it('reallocates campaign title, description, mode, and parent navigation', () => {
    const host = document.createElement('div');
    const rendered = renderCampaignRouteVariant(context(), 'overview');
    host.append(rendered);
    let detail;
    host.addEventListener('dashboard-route-allocation', (event) => {
      if (event instanceof CustomEvent) detail = event.detail;
    });

    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'campaign', value: 'ambient-context' }
    }));

    expect(detail).toEqual({
      title: 'Ambient Context',
      description: 'Overview of the Ambient Context campaign.',
      mode: 'review',
      navigationPage: 'campaigns'
    });
  });

  describe('report navigation', () => {
    it('renders route-scoped campaign navigation', () => {
      const rendered = renderCampaignRouteView({ ...context(), pageId: 'campaign-reports', elementConfig: { body: 'reports' } });
      rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
        detail: { parameter: 'campaign', value: 'ambient-context' }
      }));

      expect(rendered.querySelector('.campaign-tabs [aria-current="page"]')).toBeNull();
      expect(rendered.getAttribute('data-route-view')).not.toBeNull();
    });

    it('reallocates campaign report identity and renders explicit empty states', () => {
      const host = document.createElement('div');
      const rendered = renderCampaignRouteView({ ...context(), pageId: 'campaign-reports', elementConfig: { body: 'reports' } });
      host.append(rendered);
      let detail;
      host.addEventListener('dashboard-route-allocation', (event) => {
        if (event instanceof CustomEvent) detail = event.detail;
      });

      rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
        detail: { parameter: 'campaign', value: 'ambient-context' }
      }));
      expect(detail).toEqual({
        title: 'Ambient Context',
        description: 'Durable reports produced by the Ambient Context campaign.',
        mode: 'review',
        navigationPage: 'campaigns'
      });

      rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
        detail: { parameter: 'campaign', value: 'missing' }
      }));
      expect(rendered.textContent).toBe('Campaign not found.');

      const unavailableContext = context();
      const unavailable = renderCampaignRouteView({
        ...unavailableContext,
        elementConfig: { body: 'reports' },
        pageId: 'campaign-reports',
        sources: {
          ...unavailableContext.sources,
          workflows: {
            ...unavailableContext.sources.workflows,
            metadata: { ...metadata, availability: /** @type {'unavailable'} */ ('unavailable') },
            rows: []
          }
        }
      });
      unavailable.dispatchEvent(new CustomEvent('dashboard-route-change', {
        detail: { parameter: 'campaign', value: 'ambient-context' }
      }));
      expect(unavailable.textContent).toBe('Campaign data is unavailable.');
    });
  });

  it('renders explicit empty states for missing and invalid campaign routes', () => {
    const rendered = renderCampaignRouteVariant(context(), 'overview');
    expect(rendered.textContent).toBe('Select a campaign to view its overview.');

    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'campaign', value: '<invalid>' }
    }));
    expect(rendered.textContent).toBe('Select a campaign to view its overview.');

    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'campaign', value: 'missing' }
    }));
    expect(rendered.textContent).toBe('Campaign not found.');
  });

  it('renders the same unavailable state for workflow and report navigation', () => {
    const unavailableContext = context();

    for (const selectedView of /** @type {const} */ (['workflows', 'dispatches', 'reports'])) {
      const rendered = renderCampaignRouteView({
        ...unavailableContext,
        elementConfig: { body: selectedView },
        sources: {
          ...unavailableContext.sources,
          workflows: {
            ...unavailableContext.sources.workflows,
            metadata: { ...metadata, availability: /** @type {'unavailable'} */ ('unavailable') },
            rows: []
          }
        }
      });
      rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
        detail: { parameter: 'campaign', value: 'ambient-context' }
      }));
      expect(rendered.textContent).toBe('Campaign data is unavailable.');
    }
  });
});
