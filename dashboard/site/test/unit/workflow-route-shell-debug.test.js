// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

const METADATA = {
  'source-id': 'fixture',
  'source-kind': 'fixture',
  'as-of': '2026-08-31T18:00:00Z',
  'retrieved-at': '2026-08-31T18:01:00Z',
  completeness: /** @type {'complete'} */ ('complete'),
  freshness: /** @type {'fresh'} */ ('fresh'),
  availability: /** @type {'available'} */ ('available')
};

const WORKFLOWS = [{
  organization: 'githubnext',
  repository: 'gh-aw-cao',
  workflow: '.github/workflows/ambient-context.md',
  'workflow-name': 'Ambient Context'
}];

const VALID_ROUTE = 'githubnext/gh-aw-cao:.github/workflows/ambient-context.md';
const MISSING_WORKFLOW_ROUTE = 'githubnext/gh-aw-cao:.github/workflows/unknown.md';

/** @param {{ search: string, output: { debug: import('vitest').Mock } }} options */
async function importWorkflowRouteShellWithDebug({ search, output }) {
  vi.doMock('../../src/debug.js', async () => {
    const actual = /** @type {typeof import('../../src/debug.js')} */ (
      await vi.importActual('../../src/debug.js')
    );
    return {
      ...actual,
      createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => search, output })
    };
  });
  vi.resetModules();
  return import('../../src/components/workflow-route-shell.js');
}

/** @param {string} routeValue */
function baseContext(routeValue) {
  return {
    pageId: 'workflow-detail',
    title: 'Workflow',
    sourceNames: ['workflows'],
    sources: { workflows: { rows: WORKFLOWS, source: 'workflows', metadata: METADATA } },
    contextDetails: [],
    headingTag: /** @type {'h3'} */ ('h3'),
    routeParameter: 'workflow',
    elementConfig: { body: routeValue ? undefined : undefined }
  };
}

function shellConfig() {
  return {
    rootClassName: 'workflow-route-shell-test',
    contentClassName: 'workflow-route-content',
    selectMessage: 'Select a workflow.',
    description: 'Details for {workflow} in {repository}.',
    navigationPage: /** @type {'repositories'} */ ('repositories'),
    breadcrumbs: undefined,
    currentTab: /** @type {'workflow-detail'} */ ('workflow-detail'),
    bodyRenderer: undefined
  };
}

/** @param {ReturnType<typeof import('../../src/components/workflow-route-shell.js')['renderWorkflowRouteShell']>} root @param {string} routeValue */
function dispatchRoute(root, routeValue) {
  root.dispatchEvent(new CustomEvent('dashboard-route-change', {
    detail: { parameter: 'workflow', value: routeValue }
  }));
}

describe('workflow-route-shell debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const output = { debug: vi.fn() };
    const module = await importWorkflowRouteShellWithDebug({ search: '', output });

    const root = module.renderWorkflowRouteShell(baseContext(''), shellConfig());
    dispatchRoute(root, VALID_ROUTE);

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('is selected by the predictable "workflow-route-shell" category, not enabled by unrelated categories', async () => {
    const output = { debug: vi.fn() };
    const module = await importWorkflowRouteShellWithDebug({ search: '?debug=some-other-category', output });

    module.renderWorkflowRouteShell(baseContext(''), shellConfig());

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs initialization with a scalar workflow count when enabled', async () => {
    const output = { debug: vi.fn() };
    const module = await importWorkflowRouteShellWithDebug({ search: '?debug=workflow-route-shell', output });

    module.renderWorkflowRouteShell(baseContext(''), shellConfig());

    expect(output.debug).toHaveBeenCalledWith('[cao:workflow-route-shell]', {
      event: 'initialized',
      currentTab: 'workflow-detail',
      workflowCount: 1
    });
  });

  it('logs a matched outcome when the route resolves to a known workflow', async () => {
    const output = { debug: vi.fn() };
    const module = await importWorkflowRouteShellWithDebug({ search: '?debug=workflow-route-shell', output });

    const root = module.renderWorkflowRouteShell(baseContext(''), shellConfig());
    output.debug.mockClear();
    dispatchRoute(root, VALID_ROUTE);

    expect(output.debug).toHaveBeenCalledWith('[cao:workflow-route-shell]', {
      event: 'matched',
      currentTab: 'workflow-detail'
    });
  });

  it('logs a not-found outcome when the route does not match a known workflow', async () => {
    const output = { debug: vi.fn() };
    const module = await importWorkflowRouteShellWithDebug({ search: '?debug=workflow-route-shell', output });

    const root = module.renderWorkflowRouteShell(baseContext(''), shellConfig());
    output.debug.mockClear();
    dispatchRoute(root, MISSING_WORKFLOW_ROUTE);

    expect(output.debug).toHaveBeenCalledWith('[cao:workflow-route-shell]', {
      event: 'not-found',
      currentTab: 'workflow-detail'
    });
  });

  it('never logs sensitive payload content, only scalar metadata', async () => {
    const output = { debug: vi.fn() };
    const module = await importWorkflowRouteShellWithDebug({ search: '?debug=workflow-route-shell', output });

    const root = module.renderWorkflowRouteShell(baseContext(''), shellConfig());
    dispatchRoute(root, VALID_ROUTE);
    dispatchRoute(root, MISSING_WORKFLOW_ROUTE);

    expect(output.debug.mock.calls.length).toBeGreaterThan(0);
    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('githubnext');
      expect(JSON.stringify(payload)).not.toContain('ambient-context');
    }
  });
});
