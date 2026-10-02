import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderProblemDetail } from '../../src/components/problem-detail.js';
import { publishSource, resetSourceStore } from '../../src/source-store.js';
import { dashboardViewAliasName } from '../../src/data/queries/view-payload-compiler.js';
import { renderDashboard, disposeDashboard } from '../../src/presenter.js';

afterEach(async () => {
  document.body.replaceChildren();
  await Promise.resolve();
  resetSourceStore();
});

const metadata = {
  'source-id': 'campaign-problem-items-fixture',
  'source-kind': 'fixture',
  'as-of': '2026-09-24T18:00:00Z',
  'retrieved-at': '2026-09-24T18:00:00Z',
  completeness: /** @type {'complete'} */ ('complete'),
  freshness: /** @type {'fresh'} */ ('fresh'),
  availability: /** @type {'available'} */ ('available')
};

/** @param {Record<string, unknown>[]} rows */
function context(rows = [problem()]) {
  return {
    pageId: 'campaign-problem-detail',
    title: 'Problem',
    sourceNames: ['campaign-problem-items'],
    contextDetails: [],
    routeParameter: 'target-repository',
    headingTag: /** @type {'h3'} */ ('h3'),
    sources: {
      'campaign-problem-items': {
        source: 'campaign-problem-items',
        metadata,
        rows
      }
    }
  };
}

function problem() {
  return {
    campaign: 'dependabot',
    'campaign-name': 'Dependabot',
    workflow: '.github/workflows/dependabot.md',
    'workflow-name': 'Dependabot / Update Planner',
    'workflow-role': 'orchestrator',
    'runtime-repository': 'githubnext/gh-aw-cao',
    'target-repository': 'github/gh-aw',
    'rollout-mode': 'live',
    'problem-kind': 'failure',
    'problem-title': 'Dependency update failed',
    'failure-count': 4,
    'occurrence-count': 65,
    status: 'failed',
    'status-detail': 'Workflow failed',
    'failure-message': 'The dependency update command exited with status 1.',
    'error-signature': 'dependency-update-failed',
    'failure-job': 'update',
    'failure-step': 'Apply update',
    'failure-log': '2026-09-24T10:01:00Z ##[error]dependency update failed',
    'gh-aw-version': '0.89.20',
    engine: 'copilot',
    'engine-version': '1.2.3',
    'requested-model': 'model-a',
    'resolved-model': 'model-b',
    'started-at': '2026-09-24T10:00:00Z',
    'run-link': {
      relation: 'run',
      href: 'https://github.com/github/gh-aw/actions/runs/1',
      label: 'View run'
    },
    'runtime-repository-link': {
      'dashboard-href': '#page-repository-detail?repository=githubnext%2Fgh-aw-cao',
      'dashboard-label': 'githubnext/gh-aw-cao'
    },
    'workflow-source-link': {
      relation: 'workflow',
      href: 'https://github.com/github/gh-aw/actions/workflows/dependabot.lock.yml',
      label: 'Dependabot / Update Planner'
    },
    'target-repository-link': {
      'dashboard-href': '#page-repository-detail?repository=github%2Fgh-aw',
      'dashboard-label': 'github/gh-aw'
    }
  };
}

describe('problem detail', () => {
  it('renders the complete problem as a full detail view rather than a table', () => {
    const allocation = vi.fn();
    const rendered = renderProblemDetail(context());
    rendered.addEventListener('dashboard-route-allocation', allocation);
    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'target-repository', value: 'github/gh-aw' }
    }));

    expect(rendered.querySelector('table')).toBeNull();
    expect(rendered.querySelector('.problem-view-summary')?.textContent).toContain('exited with status 1');
    expect(rendered.querySelector('.status')?.textContent).toBe('Failure');
    expect(rendered.querySelector('.mode-badge')?.textContent).toBe('Live');
    expect(rendered.querySelector('.problem-view-highlights')?.textContent).toContain('Occurrences65');
    expect(rendered.querySelector('.problem-view-sections')?.textContent).toContain('Error signaturedependency-update-failed');
    expect(rendered.querySelector('.problem-view-sections')?.textContent).toContain('Resolved modelmodel-b');
    const runAnchor = rendered.querySelector('.problem-view-highlights a[href*="/actions/runs/1"]');
    expect(runAnchor?.textContent).toBe('https://github.com/github/gh-aw/actions/runs/1');
    expect(runAnchor?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(runAnchor?.querySelector('svg')).toBeNull();
    expect(rendered.querySelector('a[href="#page-repository-detail?repository=githubnext%2Fgh-aw-cao"]')?.textContent).toBe('githubnext/gh-aw-cao');
    expect(rendered.querySelector('a[href*="/actions/workflows/dependabot.lock.yml"]')?.textContent).toBe('Dependabot / Update Planner');
    expect(rendered.querySelector('a[href="#page-repository-detail?repository=github%2Fgh-aw"]')?.textContent).toBe('github/gh-aw');
    expect(rendered.querySelector('.problem-view-log')?.textContent).toContain('##[error]dependency update failed');
    expect(rendered.getElementsByTagName('button')[0]?.textContent).toBe('Fix it');
    expect(allocation).toHaveBeenCalledWith(expect.objectContaining({
      detail: {
        title: 'Dependency update failed',
        description: 'Dependabot / Update Planner · github/gh-aw · Live'
      }
    }));
  });

  it('renders an explicit empty state when the routed problem is unavailable', () => {
    const rendered = renderProblemDetail(context([]));
    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'target-repository', value: 'github/gh-aw' }
    }));

    expect(rendered.textContent).toBe('This runtime problem is no longer present in the selected horizon.');
  });

  it('treats missing or non-text route values as an unselected problem', () => {
    const rendered = renderProblemDetail(context());
    for (const value of [undefined, null, { repository: 'github/gh-aw' }]) {
      rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
        detail: { parameter: 'target-repository', value }
      }));
      expect(rendered.textContent).toBe('Select a runtime problem to view its details.');
      expect(rendered.dataset.targetRepository).toBe('');
    }
  });

  it('explains fields not emitted before a sparse driver-exit failure', () => {
    const sparseProblem = /** @type {Record<string, unknown>} */ ({ ...problem() });
    for (const field of [
      'failure-message',
      'failure-job',
      'failure-step',
      'failure-log',
      'engine-version',
      'requested-model',
      'resolved-model'
    ]) delete sparseProblem[field];
    const rendered = renderProblemDetail(context([sparseProblem]));
    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'target-repository', value: 'github/gh-aw' }
    }));

    expect(rendered.textContent).not.toContain('Unavailable');
    expect(rendered.querySelector('.problem-view-sections')?.textContent).toContain('Failure messageWorkflow failed');
    expect(rendered.querySelector('.problem-view-sections')?.textContent).toContain('JobThe failed job was not identified in retained run telemetry.');
    expect(rendered.querySelector('.problem-view-sections')?.textContent).toContain('Requested modelThe requested model was not recorded for this run.');
    expect(rendered.querySelector('.problem-view-sections')?.textContent).toContain('Resolved modelThe resolved model was not recorded for this run.');
    expect(rendered.querySelector('.problem-view-log')?.textContent).toContain('did not retain raw output');
  });

  it('does not invent a link when run evidence is missing or unsafe', () => {
    for (const runLink of [undefined, { href: 'javascript:alert(1)', label: 'Unsafe' }]) {
      const sparseProblem = /** @type {Record<string, unknown>} */ ({ ...problem(), 'run-link': runLink });
      const rendered = renderProblemDetail(context([sparseProblem]));
      rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
        detail: { parameter: 'target-repository', value: 'github/gh-aw' }
      }));

      expect(rendered.querySelector('.problem-view-highlights')?.textContent).toContain('Workflow runUnavailable');
      expect(rendered.querySelector('.problem-view-highlights a')).toBeNull();
    }
  });

  it('updates worker-bound evidence without replacing focused controls or log scroll state', () => {
    const fixture = { ...context(), viewId: 'campaign-problem-detail-view', viewIndex: 0 };
    const rendered = renderProblemDetail(fixture);
    document.body.append(rendered);
    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'target-repository', value: 'github/gh-aw' }
    }));
    const button = rendered.querySelector('button');
    const log = rendered.querySelector('.problem-view-log pre');
    button?.focus();
    if (log) log.scrollTop = 32;
    const allocation = vi.fn();
    rendered.addEventListener('dashboard-route-allocation', allocation);
    publishSource('campaign-problem-items', {
      ...fixture.sources['campaign-problem-items'],
      rows: [{ ...problem(), 'problem-title': 'Updated problem', 'occurrence-count': 66, 'failure-log': 'Updated log' }]
    }, dashboardViewAliasName(fixture.pageId, { id: fixture.viewId }, 0, 'campaign-problem-items', 0));

    expect(rendered.querySelector('button')).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(rendered.querySelector('.problem-view-log pre')).toBe(log);
    expect(log?.scrollTop).toBe(32);
    expect(log?.textContent).toBe('Updated log');
    expect(rendered.querySelector('.problem-view-highlights')?.textContent).toContain('Occurrences66');
    expect(allocation).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.objectContaining({ title: 'Updated problem' }) }));
  });

  it('keeps the repair prompt open and updates its evidence reactively', () => {
    const rendered = renderProblemDetail(context());
    document.body.append(rendered);
    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'target-repository', value: 'github/gh-aw' }
    }));
    rendered.querySelector('button')?.click();
    const preview = rendered.querySelector('.table-intent-preview');
    expect(preview?.textContent).toContain('"occurrence-count": 65');
    const dialog = rendered.querySelector('dialog');
    publishSource('campaign-problem-items', {
      ...context().sources['campaign-problem-items'],
      rows: [{ ...problem(), 'occurrence-count': 66 }]
    });

    expect(rendered.querySelector('dialog')).toBe(dialog);
    expect(dialog?.open).toBe(true);
    expect(preview?.textContent).toContain('"occurrence-count": 66');
    rendered.querySelector('.table-intent-dialog-close')?.dispatchEvent(new MouseEvent('click'));
    expect(dialog?.open).toBe(false);
  });

  it('distinguishes loading, incomplete, unavailable, recovery, and complete empty evidence', async () => {
    const rendered = renderProblemDetail({ ...context(), sources: {} });
    document.body.append(rendered);
    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'target-repository', value: 'github/gh-aw' }
    }));
    expect(rendered.getAttribute('aria-busy')).toBe('true');
    expect(rendered.textContent).toBe('Loading runtime problem evidence...');
    publishSource('campaign-problem-items', {
      source: 'campaign-problem-items', metadata: { ...metadata, completeness: 'partial' }, rows: []
    });
    expect(rendered.getAttribute('aria-busy')).toBe('false');
    expect(rendered.textContent).toContain('evidence is incomplete');
    expect(rendered.textContent).not.toContain('no longer present');
    publishSource('campaign-problem-items', {
      source: 'campaign-problem-items', metadata: { ...metadata, completeness: 'partial' }, rows: [problem()]
    });
    expect(rendered.querySelector('[role="status"]')?.textContent).toContain('evidence is incomplete');
    expect(rendered.querySelector('.problem-view')).not.toBeNull();
    publishSource('campaign-problem-items', {
      source: 'campaign-problem-items', metadata: { ...metadata, availability: 'unavailable' }, rows: []
    });
    expect(rendered.textContent).toContain('evidence is unavailable');
    expect(rendered.textContent).not.toContain('no longer present');
    publishSource('campaign-problem-items', context().sources['campaign-problem-items']);
    expect(rendered.querySelector('.problem-view')).not.toBeNull();
    publishSource('campaign-problem-items', {
      source: 'campaign-problem-items', metadata: { ...metadata, availability: 'empty' }, rows: []
    });
    expect(rendered.textContent).toBe('This runtime problem is no longer present in the selected horizon.');
  });

  it('stops source reactions and route listeners after its root is removed', async () => {
    const rendered = renderProblemDetail(context());
    document.body.append(rendered);
    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'target-repository', value: 'github/gh-aw' }
    }));
    rendered.querySelector('button')?.click();
    const contents = rendered.textContent;
    const allocation = vi.fn();
    rendered.addEventListener('dashboard-route-allocation', allocation);
    rendered.remove();
    await Promise.resolve();
    publishSource('campaign-problem-items', {
      ...context().sources['campaign-problem-items'],
      rows: [{ ...problem(), 'occurrence-count': 99 }]
    });
    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'target-repository', value: '' }
    }));
    expect(rendered.textContent).toBe(contents);
    expect(allocation).not.toHaveBeenCalled();
    expect(rendered.dataset.targetRepository).toBe('github/gh-aw');
  });

  it('keeps the detail element mounted while the active page subscription publishes fresh results', async () => {
    const previousUrl = window.location.href;
    window.history.replaceState(null, '', '#page-campaign-problem-detail?target-repository=github%2Fgh-aw');
    /** @type {import('../../src/presenter.js').PageSourceLoadOptions | undefined} */
    let subscription;
    const loadPageSources = /** @type {import('../../src/presenter.js').PageSourceLoader} */ (
      vi.fn(async () => ({}))
    );
    loadPageSources.subscribeViewSources = vi.fn(async (_pageId, _viewId, names, options) => {
      expect(names).toEqual(['campaign-problem-items']);
      subscription = options;
      return context().sources;
    });
    const dashboard = renderDashboard({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'problem-subscription', title: 'Problem subscription',
          pages: [{
            id: 'campaign-problem-detail', kind: 'custom', title: 'Problem',
            'filter-bar': false,
            route: { 'hash-query-parameter': 'target-repository' },
            views: [{
              id: 'campaign-problem-detail-view', title: 'Problem',
              mark: 'element', element: 'problem-detail',
              data: { sources: ['campaign-problem-items'] }
            }]
          }]
        }
      },
      sources: {},
      loadPageSources
    });
    document.body.append(dashboard);
    try {
      await vi.waitFor(() => expect(dashboard.querySelector('.problem-view')).not.toBeNull());
      expect(loadPageSources).not.toHaveBeenCalled();
      expect(subscription?.signal.aborted).toBe(false);
      const detail = dashboard.querySelector('.problem-detail');
      const button = /** @type {HTMLButtonElement} */ (detail?.querySelector('.problem-view button'));
      button.focus();
      subscription?.onUpdate?.({
        'campaign-problem-items': {
          ...context().sources['campaign-problem-items'],
          rows: [{ ...problem(), 'occurrence-count': 67 }]
        }
      });
      expect(dashboard.querySelector('.problem-detail')).toBe(detail);
      expect(detail?.querySelector('.problem-view-highlights')?.textContent).toContain('Occurrences67');
      expect(document.activeElement).toBe(button);
    } finally {
      disposeDashboard(dashboard);
      dashboard.remove();
      window.history.replaceState(null, '', previousUrl);
    }
    expect(subscription?.signal.aborted).toBe(true);
  });
});

describe('problem detail debug logging', () => {
  afterEach(() => {
    vi.doUnmock('../../src/debug.js');
    vi.resetModules();
  });

  it('stays silent by default and logs only scalar metadata under its predictable category', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => '?debug=problem-detail', output })
      };
    });
    vi.resetModules();
    const { renderProblemDetail: renderProblemDetailWithDebug } = await import('../../src/components/problem-detail.js');

    const rendered = renderProblemDetailWithDebug(context());
    expect(output.debug).toHaveBeenCalledWith('[cao:problem-detail]', { event: 'initialized', pageId: 'campaign-problem-detail', availability: 'available' });

    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'target-repository', value: 'github/gh-aw' }
    }));
    expect(output.debug).toHaveBeenCalledWith('[cao:problem-detail]', { event: 'matched', pageId: 'campaign-problem-detail' });

    const emptyRendered = renderProblemDetailWithDebug(context([]));
    emptyRendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'target-repository', value: 'github/gh-aw' }
    }));
    expect(output.debug).toHaveBeenCalledWith('[cao:problem-detail]', { event: 'not-found', pageId: 'campaign-problem-detail' });

    for (const call of output.debug.mock.calls) {
      const metadata = call[1];
      expect(Object.values(metadata).every((value) => typeof value !== 'object')).toBe(true);
    }
  });

  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => '', output })
      };
    });
    vi.resetModules();
    const { renderProblemDetail: renderProblemDetailWithoutDebug } = await import('../../src/components/problem-detail.js');

    const rendered = renderProblemDetailWithoutDebug(context());
    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'target-repository', value: 'github/gh-aw' }
    }));

    expect(output.debug).not.toHaveBeenCalled();
  });
});
