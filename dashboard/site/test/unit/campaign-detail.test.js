// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderCampaignRouteVariant, renderCampaignRouteView } from '../../src/components/campaign-route-view.js';
import { configureSourceLoader, refreshSources, resetSourceStore } from '../../src/source-store.js';

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

const operationalGraders = [
  {
    organization: 'githubnext',
    repository: 'gh-aw-cao',
    workflow: '.github/workflows/ambient-context-agents-md-curator.md',
    run: '100',
    'operational-grader': 0.5,
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
    'operational-grader': 0.75,
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
    'operational-grader': 1,
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
      'operational-graders': { source: 'operational-graders', metadata, rows: operationalGraders }
    }
  };
}

afterEach(() => resetSourceStore());

describe('campaign detail route', () => {
  it('renders the shared navigation shell for the selected campaign Insights facet', () => {
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
    expect(rendered.querySelector('.measure-history')).toBeNull();
  });

  it('keeps the compatibility Info route outside the reusable campaign tabs', () => {
    const rendered = renderCampaignRouteVariant(context(), 'overview');
    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'campaign', value: 'ambient-context' }
    }));

    expect(rendered.dataset.campaign).toBe('ambient-context');
    expect(rendered.querySelector('.campaign-tabs')?.textContent).toBe('InsightsProblemsIssues');
    expect(rendered.querySelector('.campaign-tabs [aria-current="page"]')).toBeNull();
    expect([...rendered.querySelectorAll('.campaign-tabs a')].map((link) => link.getAttribute('href'))).toEqual([
      '#page-campaign-insights?campaign=ambient-context',
      '#page-campaign-problems?campaign=ambient-context',
      '#page-campaign-issues?campaign=ambient-context'
    ]);
    expect([...rendered.querySelectorAll('.campaign-tabs a')].map((link) => link.getAttribute('data-nav-page-id'))).toEqual([
      'campaign-insights',
      'campaign-problems',
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

  it('shows non-zero item counts uniformly across campaign data tabs', () => {
    const base = context();
    const rendered = renderCampaignRouteVariant({
      ...base,
      sourceNames: ['workflows', 'campaign-insight-tab-counts', 'campaign-problem-tab-counts', 'campaign-issue-tab-counts'],
      sources: {
        ...base.sources,
        'campaign-insight-tab-counts': {
          source: 'campaign-insight-tab-counts',
          metadata,
          rows: [
            { campaign: 'ambient-context', items: 4 },
            { campaign: 'other', items: 1 }
          ]
        },
        'campaign-problem-tab-counts': {
          source: 'campaign-problem-tab-counts',
          metadata,
          rows: [
            { campaign: 'ambient-context', items: 2 }
          ]
        },
        'campaign-issue-tab-counts': {
          source: 'campaign-issue-tab-counts',
          metadata,
          rows: [
            { campaign: 'ambient-context', items: 1 }
          ]
        }
      }
    }, 'problems');
    const host = document.createElement('div');
    host.append(rendered);
    let allocation;
    host.addEventListener('dashboard-route-allocation', (event) => {
      if (event instanceof CustomEvent) allocation = event.detail;
    });
    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'campaign', value: 'ambient-context' }
    }));

    expect([...rendered.querySelectorAll('.campaign-tabs a')].map((link) => ({
      label: link.querySelector('span')?.textContent,
      count: link.querySelector('.count-badge')?.textContent
    }))).toEqual([
      { label: 'Insights', count: '4' },
      { label: 'Problems', count: '2' },
      { label: 'Issues', count: '1' }
    ]);
    expect(allocation).toEqual({
      title: 'Ambient Context',
      description: 'Operational activity for the Ambient Context campaign.',
      titleLink: {
        href: 'https://ghe.example/githubnext/gh-aw-cao/tree/HEAD/ambient-context',
        label: 'Open Ambient Context campaign source on GitHub'
      },
      navigationPage: 'campaigns'
    });
  });

  it('refreshes plot badges when independently bound campaign sources change', async () => {
    let insightItems = 0;
    const base = context();
    configureSourceLoader(async (name) => {
      if (name === 'workflows') return base.sources.workflows;
      if (name === 'campaign-insight-tab-counts') {
        return {
          source: name,
          metadata,
          rows: insightItems > 0 ? [{ campaign: 'ambient-context', items: insightItems }] : []
        };
      }
      return { source: name, metadata, rows: [] };
    });
    const rendered = renderCampaignRouteView({
      ...base,
      pageId: 'campaign-insights',
      sourceNames: [
        'workflows',
        'campaign-insight-tab-counts',
        'campaign-problem-tab-counts',
        'campaign-issue-tab-counts'
      ],
      elementConfig: { body: 'insights' }
    });
    document.body.append(rendered);
    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'campaign', value: 'ambient-context' }
    }));

    await vi.waitFor(() => {
      expect(rendered.querySelector('.campaign-tabs .count-badge')).toBeNull();
    });
    insightItems = 1;
    refreshSources();
    await vi.waitFor(() => {
      expect(rendered.querySelector('.campaign-tabs .count-badge')?.textContent).toBe('1');
    });
    rendered.remove();
  });

  it('keeps campaign facets above the page filter bar for the route view lifetime', async () => {
    const page = document.createElement('section');
    page.className = 'dashboard-page';
    const loadingTabs = document.createElement('div');
    loadingTabs.className = 'route-tab-navigation';
    loadingTabs.append(document.createElement('nav'));
    loadingTabs.querySelector('nav')?.setAttribute('data-route-tabs', '');
    loadingTabs.querySelector('nav')?.classList.add('campaign-tabs');
    const filterBar = document.createElement('div');
    filterBar.className = 'filter-bar';
    const rendered = renderCampaignRouteVariant(context(), 'overview');
    page.append(loadingTabs, filterBar, rendered);

    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'campaign', value: 'ambient-context' }
    }));

    expect(page.children[0]).toBe(page.querySelector('.campaign-tabs'));
    expect(page.children[1]).toBe(filterBar);
    expect(page.querySelector('.route-tab-navigation')).toBeNull();
    expect(page.querySelectorAll('[data-route-tabs]')).toHaveLength(1);

    rendered.remove();
    await Promise.resolve();
    expect(page.querySelector('.campaign-tabs')).toBeNull();
  });

  it('places campaign facets above already-rendered page content when no page chrome is present', () => {
    const page = document.createElement('section');
    page.className = 'dashboard-page';
    const rendered = renderCampaignRouteVariant(context(), 'problems');
    const contentGrid = document.createElement('div');
    contentGrid.className = 'custom-view-grid';
    contentGrid.append(rendered);
    const otherViewContent = document.createElement('p');
    otherViewContent.className = 'campaign-problem-cards';
    otherViewContent.textContent = 'problems content';
    contentGrid.append(otherViewContent);
    page.append(contentGrid);

    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'campaign', value: 'ambient-context' }
    }));

    expect(page.children[0]).toBe(page.querySelector('.campaign-tabs'));
    expect(page.children[1]).toBe(contentGrid);
  });

  it('keeps non-facet workflow composition available without adding a selected tab', () => {
    const rendered = renderCampaignRouteVariant(context(), 'workflows');
    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'campaign', value: 'ambient-context' }
    }));

    expect(rendered.querySelector('.campaign-tabs [aria-current="page"]')).toBeNull();
    expect(rendered.querySelector('.campaign-tabs')?.textContent).toBe('InsightsProblemsIssues');
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

      expect(rendered.querySelector('.campaign-tabs [aria-current="page"]')).toBeNull();
      expect(detail).toEqual({
        title: 'Ambient Context',
        description: 'Operational activity for the Ambient Context campaign.',
        titleLink: {
          href: 'https://ghe.example/githubnext/gh-aw-cao/tree/HEAD/ambient-context',
          label: 'Open Ambient Context campaign source on GitHub'
        },
        navigationPage: 'campaigns'
      });
    });

    it('keeps rollout mode out of shared campaign identity chrome', () => {
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

      expect(detail).not.toHaveProperty('mode');
    });
  });

  it('reallocates campaign title, description, and parent navigation', () => {
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
      description: 'Operational activity for the Ambient Context campaign.',
      titleLink: {
        href: 'https://ghe.example/githubnext/gh-aw-cao/tree/HEAD/ambient-context',
        label: 'Open Ambient Context campaign source on GitHub'
      },
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
        description: 'Operational activity for the Ambient Context campaign.',
        titleLink: {
          href: 'https://ghe.example/githubnext/gh-aw-cao/tree/HEAD/ambient-context',
          label: 'Open Ambient Context campaign source on GitHub'
        },
        navigationPage: 'campaigns'
      });

      rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
        detail: { parameter: 'campaign', value: 'missing' }
      }));
      expect(rendered.textContent).toContain('Campaign not found.');

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
      expect(unavailable.textContent).toContain('Campaign data is unavailable.');
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
    expect(rendered.textContent).toContain('Campaign not found.');
  });

  it('keeps a canonical campaign identity while workflow inventory is still loading', () => {
    const loadingContext = context();
    const rendered = renderCampaignRouteVariant({
      ...loadingContext,
      sources: {
        ...loadingContext.sources,
        workflows: {
          source: 'workflows',
          rows: [],
          metadata: {
            ...metadata,
            completeness: /** @type {'partial'} */ ('partial')
          }
        }
      }
    }, 'insights');
    const host = document.createElement('div');
    host.append(rendered);
    let detail;
    host.addEventListener('dashboard-route-allocation', (event) => {
      if (event instanceof CustomEvent) detail = event.detail;
    });

    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'campaign', value: 'dependabot' }
    }));

    expect(detail).toEqual({
      title: 'Dependabot',
      description: 'Operational activity for the Dependabot campaign.',
      navigationPage: 'campaigns'
    });
    expect(rendered.textContent).toContain('Loading campaign data...');
    expect(rendered.textContent).not.toContain('Campaign not found.');
    expect(rendered.querySelector('[aria-busy="true"]')?.getAttribute('role')).toBe('status');
  });

  it('distinguishes first load, database loading, and an empty ingested database', async () => {
    const firstLoadContext = context();
    const firstLoad = renderCampaignRouteVariant({
      ...firstLoadContext,
      sources: {
        ...firstLoadContext.sources,
        workflows: {
          source: 'workflows',
          metadata: { ...metadata, availability: 'empty', completeness: 'unknown' },
          rows: []
        }
      }
    }, 'overview');
    firstLoad.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'campaign', value: 'dependabot' }
    }));
    expect(firstLoad.textContent).toContain('Campaign data will appear after the first data load completes.');
    expect(firstLoad.textContent).not.toContain('unavailable');

    resetSourceStore();
    /** @type {(source: import('../../src/presenter.js').LogicalSourceInput) => void} */
    let resolveWorkflows = () => {};
    configureSourceLoader((name) => name === 'workflows'
      ? new Promise((resolve) => { resolveWorkflows = resolve; })
      : Promise.resolve({ source: name, metadata, rows: [] }));
    const loading = renderCampaignRouteVariant({
      ...context(),
      sources: {}
    }, 'overview');
    loading.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'campaign', value: 'dependabot' }
    }));
    expect(loading.textContent).toContain('Loading campaign data...');
    expect(loading.querySelector('[aria-busy="true"]')?.getAttribute('role')).toBe('status');
    resolveWorkflows({
      source: 'workflows',
      metadata: { ...metadata, availability: 'empty', completeness: 'unknown' },
      rows: []
    });
    await vi.waitFor(() => expect(loading.textContent).toContain('Campaign data will appear after the first data load completes.'));

    resetSourceStore();
    const emptyIngestedContext = context();
    const emptyIngested = renderCampaignRouteVariant({
      ...emptyIngestedContext,
      sources: {
        ...emptyIngestedContext.sources,
        workflows: { source: 'workflows', metadata: { ...metadata, availability: 'empty' }, rows: [] }
      }
    }, 'overview');
    emptyIngested.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'campaign', value: 'dependabot' }
    }));
    expect(emptyIngested.textContent).toContain('Campaign data is unavailable.');
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
      expect(rendered.textContent).toContain('Campaign data is unavailable.');
      expect(rendered.querySelector('.campaign-tabs')).not.toBeNull();
    }
  });
});
