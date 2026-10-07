// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const metadata = {
  'source-id': 'fixture',
  'source-kind': 'fixture',
  'as-of': '2026-08-31T20:00:00Z',
  'retrieved-at': '2026-08-31T20:01:00Z',
  completeness: /** @type {'complete'} */ ('complete'),
  freshness: /** @type {'fresh'} */ ('fresh'),
  availability: /** @type {'available'} */ ('available')
};

const workflows = [{
  organization: 'githubnext',
  repository: 'gh-aw-cao',
  workflow: '.github/workflows/ambient-context.md',
  'workflow-name': 'Ambient Context',
  'workflow-role': 'orchestrator',
  'rollout-mode': 'review'
}];

/** @param {string} [body] */
function context(body) {
  return {
    pageId: 'workflow-detail',
    title: 'Workflow runtime',
    sourceNames: ['workflows'],
    contextDetails: [],
    routeParameter: 'workflow',
    headingTag: /** @type {'h3'} */ ('h3'),
    elementConfig: body !== undefined ? { body } : undefined,
    sources: {
      workflows: { source: 'workflows', metadata, rows: workflows }
    }
  };
}

/**
 * @param {ReturnType<typeof vi.fn>} debugFn
 * @param {string} search
 */
function mockDebugModule(debugFn, search) {
  const output = /** @type {Pick<Console, 'debug'>} */ ({ debug: debugFn });
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
}

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('workflow-route-page debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '');
    const { renderWorkflowRoutePage } = await import('../../src/components/workflow-route-page.js');

    renderWorkflowRoutePage(context('reports'));

    expect(debugFn).not.toHaveBeenCalled();
  });

  it('logs the requested and resolved body plus page id under its predictable category', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=workflow-route-page');
    const { renderWorkflowRoutePage } = await import('../../src/components/workflow-route-page.js');

    renderWorkflowRoutePage(context('insights'));

    expect(debugFn).toHaveBeenCalledWith('[cao:workflow-route-page]', {
      event: 'render',
      requestedBody: 'insights',
      resolvedBody: 'insights',
      pageId: 'workflow-runtime'
    });
  });

  it('reports an unrecognized body as a fallback to the default resolved body', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=workflow-route-page');
    const { renderWorkflowRoutePage } = await import('../../src/components/workflow-route-page.js');

    renderWorkflowRoutePage(context('not-a-real-body'));

    expect(debugFn).toHaveBeenCalledWith('[cao:workflow-route-page]', {
      event: 'render',
      requestedBody: 'not-a-real-body',
      resolvedBody: 'reports',
      pageId: 'workflow-detail'
    });
  });

  it('reports an unset body as "unset" instead of omitting the field', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=workflow-route-page');
    const { renderWorkflowRoutePage } = await import('../../src/components/workflow-route-page.js');

    renderWorkflowRoutePage(context());

    expect(debugFn).toHaveBeenCalledWith('[cao:workflow-route-page]', {
      event: 'render',
      requestedBody: 'unset',
      resolvedBody: 'reports',
      pageId: 'workflow-detail'
    });
  });

  it('never logs record content, only scalar metadata', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=workflow-route-page');
    const { renderWorkflowRoutePage } = await import('../../src/components/workflow-route-page.js');

    renderWorkflowRoutePage(context('runs'));

    for (const call of debugFn.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('ambient-context.md');
      expect(JSON.stringify(payload)).not.toContain('githubnext');
    }
  });
});
