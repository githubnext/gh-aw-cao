// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderPackageNavigation } from '../../src/components/package-detail.js';
import { renderPackageRouteVariant, renderPackageRouteView } from '../../src/components/package-route-view.js';

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
    package: 'ambient-context',
    'package-name': 'Ambient Context',
    organization: 'githubnext',
    repository: 'gh-aw-cao',
    workflow: '.github/workflows/ambient-context.md',
    'workflow-name': 'Ambient Context',
    'workflow-role': 'orchestrator',
    'rollout-mode': 'review',
    'package-description': 'Keeps repository guidance current.',
    'package-readme-path': 'ambient-context/README.md',
    'package-readme': '# Ambient Context\n\nKeeps shared guidance current. See the [guide](docs/guide.md).\n\n## Capabilities\n\n- Reviews context\n- Proposes updates',
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
    package: 'ambient-context',
    'package-name': 'Ambient Context',
    organization: 'githubnext',
    repository: 'gh-aw-cao',
    workflow: '.github/workflows/ambient-context-agents-md-curator.md',
    'workflow-name': 'Ambient Context / AGENTS.md',
    'workflow-role': 'worker',
    'rollout-mode': 'review'
  },
  {
    package: 'other',
    'package-name': 'Other',
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
    package: 'ambient-context',
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
    package: 'ambient-context',
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
    package: 'other',
    workflow: '.github/workflows/ambient-context.md',
    'workflow-name': 'Other',
    'safe-output': 'other-1',
    'outcome-title': 'Other package report',
    'outcome-summary': 'Not part of the selected package.',
    'outcome-category': 'issue',
    'outcome-status': 'open',
    'rollout-mode': 'live',
    'observed-at': '2026-08-29T15:00:00Z'
  }
];

function context() {
  return {
    pageId: 'package-detail',
    title: 'Orchestrator and workers',
    sourceNames: ['workflows'],
    contextDetails: [],
    routeParameter: 'package',
    headingTag: /** @type {'h3'} */ ('h3'),
    sources: {
      workflows: { source: 'workflows', metadata, rows: workflows },
      outcomes: { source: 'outcomes', metadata, rows: outcomes },
      'operational-values': { source: 'operational-values', metadata, rows: operationalValues }
    }
  };
}

describe('renderPackageNavigation', () => {
  it('renders weekly operational-value plots for only the selected package workers', () => {
    const rendered = renderPackageRouteView({
      ...context(),
      pageId: 'package-insights',
      sourceNames: ['workflows', 'operational-values'],
      elementConfig: { body: 'insights' }
    });
    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'package', value: 'ambient-context' }
    }));

    expect(rendered.querySelector('.package-tabs [aria-current="page"]')?.getAttribute('href')).toBe('#page-package-insights?package=ambient-context');
    expect(rendered.querySelector('.value-report h2')?.textContent).toBe('Ambient Context / AGENTS.md');
    expect(rendered.querySelector('.value-score')?.textContent).toContain('75%');
    expect(rendered.querySelector('.value-outcomes')?.textContent).toContain('Outcome change from first observation');
    expect(rendered.querySelector('.value-outcomes')?.textContent).toContain('Primary operational value+25.0 pts');
    expect(rendered.querySelector('.value-attainment')?.textContent).toContain('Weekly operational attainment');
    expect(rendered.querySelector('.value-attainment .primary-weekly')).not.toBeNull();
    expect(rendered.textContent).not.toContain('github/other');
  });

  it('renders reusable navigation for the selected package workflow view', () => {
    const rendered = renderPackageNavigation(context());
    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'package', value: 'ambient-context' }
    }));

    expect(rendered.dataset.package).toBe('ambient-context');
    expect(rendered.querySelector('.package-tabs')?.textContent).toBe('InsightsWorkflowsDispatchesReports');
    expect(rendered.querySelector('.package-tabs [aria-current="page"]')?.getAttribute('href')).toBe('#page-package-detail?package=ambient-context');
    expect(rendered.querySelector('.package-readme h1')?.textContent).toBe('Ambient Context');
    expect(rendered.querySelector('.package-readme h2')?.textContent).toBe('Capabilities');
    expect(rendered.querySelectorAll('.package-readme li')).toHaveLength(2);
    expect(rendered.querySelector('.package-readme-about')?.textContent).toContain('Keeps repository guidance current.');
    expect(rendered.querySelector('.package-marketplace-detail')?.getAttribute('data-package')).toBe('ambient-context');
    expect(rendered.querySelector('.package-marketplace-title')?.textContent).toBe('Ambient ContextPackage');
    expect(rendered.querySelector('.package-rollout')?.textContent).toBe('review');
    expect(rendered.querySelector('.package-marketplace-actions a')?.getAttribute('href')).toBe('https://ghe.example/githubnext/gh-aw-cao/blob/HEAD/ambient-context/README.md');
    expect([...rendered.querySelectorAll('.package-readme a')].find((link) => link.textContent === 'guide')?.getAttribute('href')).toBe('https://ghe.example/githubnext/gh-aw-cao/blob/HEAD/ambient-context/docs/guide.md');
    const resources = /** @type {HTMLDetailsElement} */ (rendered.querySelector('.package-readme-resources'));
    expect(resources.open).toBe(false);
    expect(resources.querySelector('summary')?.textContent).toBe('ResourcesShow details');
    resources.open = true;
    expect(resources.textContent).toContain('Source repository');
    expect([...resources.querySelectorAll('a')].at(-1)?.getAttribute('href')).toBe('https://ghe.example/githubnext/gh-aw-cao');
    expect(rendered.textContent).not.toContain('Other');
  });

  it('renders workflow tab composition through the reusable package route variant primitive', () => {
    const rendered = renderPackageRouteVariant(context(), 'workflows');
    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'package', value: 'ambient-context' }
    }));

    expect(rendered.querySelector('.package-tabs [aria-current="page"]')?.getAttribute('href')).toBe('#page-package-detail?package=ambient-context');
    expect(rendered.querySelector('.package-tabs')?.textContent).toBe('InsightsWorkflowsDispatchesReports');
  });

  describe('dispatch navigation', () => {
    it('renders package-scoped dispatch navigation and identity', () => {
      const host = document.createElement('div');
      const rendered = renderPackageRouteView({ ...context(), pageId: 'package-dispatches', elementConfig: { body: 'dispatches' } });
      host.append(rendered);
      let detail;
      host.addEventListener('dashboard-route-allocation', (event) => {
        if (event instanceof CustomEvent) detail = event.detail;
      });

      rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
        detail: { parameter: 'package', value: 'ambient-context' }
      }));

      expect(rendered.querySelector('.package-tabs [aria-current="page"]')?.getAttribute('href')).toBe('#page-package-dispatches?package=ambient-context');
      expect(detail).toEqual({
        title: 'Ambient Context',
        description: 'Workflow dispatch runs for the Ambient Context package.',
        mode: 'review',
        navigationPage: 'packages'
      });
    });

    it('uses the trusted target mode for package navigation', () => {
      const host = document.createElement('div');
      const targetModeWorkflows = workflows.map((workflow) => workflow.package === 'ambient-context'
        ? { ...workflow, 'package-targets': [{ repository: 'githubnext/gh-aw-cao', mode: 'live' }] }
        : workflow);
      const rendered = renderPackageNavigation({
        ...context(),
        sources: { ...context().sources, workflows: { source: 'workflows', metadata, rows: targetModeWorkflows } }
      });
      host.append(rendered);
      let detail;
      host.addEventListener('dashboard-route-allocation', (event) => {
        if (event instanceof CustomEvent) detail = event.detail;
      });

      rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
        detail: { parameter: 'package', value: 'ambient-context' }
      }));

      expect(detail).toEqual(expect.objectContaining({ mode: 'live' }));
    });
  });

  it('reallocates package title, description, mode, and parent navigation', () => {
    const host = document.createElement('div');
    const rendered = renderPackageNavigation(context());
    host.append(rendered);
    let detail;
    host.addEventListener('dashboard-route-allocation', (event) => {
      if (event instanceof CustomEvent) detail = event.detail;
    });

    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'package', value: 'ambient-context' }
    }));

    expect(detail).toEqual({
      title: 'Ambient Context',
      description: 'Orchestrator and worker workflows in the Ambient Context package.',
      mode: 'review',
      navigationPage: 'packages'
    });
  });

  describe('report navigation', () => {
    it('renders route-scoped package navigation', () => {
      const rendered = renderPackageRouteView({ ...context(), pageId: 'package-reports', elementConfig: { body: 'reports' } });
      rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
        detail: { parameter: 'package', value: 'ambient-context' }
      }));

      expect(rendered.querySelector('.package-tabs [aria-current="page"]')?.getAttribute('href')).toBe('#page-package-reports?package=ambient-context');
      expect(rendered.getAttribute('data-route-view')).not.toBeNull();
    });

    it('reallocates package report identity and renders explicit empty states', () => {
      const host = document.createElement('div');
      const rendered = renderPackageRouteView({ ...context(), pageId: 'package-reports', elementConfig: { body: 'reports' } });
      host.append(rendered);
      let detail;
      host.addEventListener('dashboard-route-allocation', (event) => {
        if (event instanceof CustomEvent) detail = event.detail;
      });

      rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
        detail: { parameter: 'package', value: 'ambient-context' }
      }));
      expect(detail).toEqual({
        title: 'Ambient Context',
        description: 'Durable reports produced by the Ambient Context package.',
        mode: 'review',
        navigationPage: 'packages'
      });

      rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
        detail: { parameter: 'package', value: 'missing' }
      }));
      expect(rendered.textContent).toBe('Package not found.');

      const unavailableContext = context();
      const unavailable = renderPackageRouteView({
        ...unavailableContext,
        elementConfig: { body: 'reports' },
        pageId: 'package-reports',
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
        detail: { parameter: 'package', value: 'ambient-context' }
      }));
      expect(unavailable.textContent).toBe('Package data is unavailable.');
    });
  });

  it('renders explicit empty states for missing and invalid package routes', () => {
    const rendered = renderPackageNavigation(context());
    expect(rendered.textContent).toBe('Select a package to view its workflows.');

    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'package', value: '<invalid>' }
    }));
    expect(rendered.textContent).toBe('Select a package to view its workflows.');

    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'package', value: 'missing' }
    }));
    expect(rendered.textContent).toBe('Package not found.');
  });

  it('renders the same unavailable state for workflow and report navigation', () => {
    const unavailableContext = context();

    for (const selectedView of /** @type {const} */ (['workflows', 'dispatches', 'reports'])) {
      const rendered = renderPackageRouteView({
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
        detail: { parameter: 'package', value: 'ambient-context' }
      }));
      expect(rendered.textContent).toBe('Package data is unavailable.');
    }
  });
});
