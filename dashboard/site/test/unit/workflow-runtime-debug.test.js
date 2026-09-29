// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  'workflow-active': 'true',
  'rollout-mode': 'review'
};

/** @param {{ runsAvailable?: boolean }} [options] */
function context({ runsAvailable = true } = {}) {
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
        metadata: {
          ...completeMetadata,
          availability: /** @type {'available'|'unavailable'} */ (runsAvailable ? 'available' : 'unavailable')
        },
        rows: runsAvailable
          ? [
              { organization: 'githubnext', repository: 'gh-aw-cao', workflow: workflow.workflow, run: '1', 'run-status': 'completed', 'run-conclusion': 'success' },
              { organization: 'githubnext', repository: 'gh-aw-cao', workflow: workflow.workflow, run: '2', 'run-status': 'completed', 'run-conclusion': 'failure' }
            ]
          : []
      },
      usage: {
        source: 'usage',
        metadata: { ...completeMetadata, completeness: /** @type {'partial'} */ ('partial') },
        rows: [
          { organization: 'githubnext', repository: 'gh-aw-cao', workflow: workflow.workflow, run: '1', aic: 42.5 }
        ]
      }
    }
  };
}

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('workflow runtime debug logging', () => {
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
    const { renderWorkflowRuntimeBody } = await import('../../src/components/workflow-runtime.js');

    renderWorkflowRuntimeBody(context(), workflow);

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs body resolution and computed metrics under its predictable category when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=workflow-runtime', output })
      };
    });
    vi.resetModules();
    const { renderWorkflowRuntimeBody } = await import('../../src/components/workflow-runtime.js');

    renderWorkflowRuntimeBody(context(), workflow);

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:workflow-runtime]',
      { event: 'body-resolved', runCount: 2, usageCount: 1 }
    );
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:workflow-runtime]',
      { event: 'metrics-computed', healthAvailable: true, usageAvailable: true, usageMeasured: true, failed: 1 }
    );
  });

  it('logs the unavailable run-health state transition', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=workflow-runtime', output })
      };
    });
    vi.resetModules();
    const { renderWorkflowRuntimeBody } = await import('../../src/components/workflow-runtime.js');

    renderWorkflowRuntimeBody(context({ runsAvailable: false }), workflow);

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:workflow-runtime]',
      { event: 'run-health-unavailable' }
    );
  });

  it('never logs sensitive payload content, only scalar metadata', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=workflow-runtime', output })
      };
    });
    vi.resetModules();
    const { renderWorkflowRuntimeBody } = await import('../../src/components/workflow-runtime.js');

    renderWorkflowRuntimeBody(context(), workflow);
    renderWorkflowRuntimeBody(context({ runsAvailable: false }), workflow);

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('Multi-Device');
      expect(JSON.stringify(payload)).not.toContain('githubnext');
    }
  });
});
