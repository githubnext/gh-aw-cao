// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

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

const workflow = {
  workflow: '.github/workflows/ambient-context.md',
  'workflow-role': 'orchestrator'
};

const workflowWithLink = {
  ...workflow,
  'workflow-link': {
    href: 'https://github.com/githubnext/gh-aw-cao/blob/main/.github/workflows/ambient-context.md',
    label: 'Source'
  }
};

describe('workflow-identity debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '');
    const { renderWorkflowIdentity } = await import('../../src/components/workflow-identity.js');

    renderWorkflowIdentity(workflow);

    expect(debugFn).not.toHaveBeenCalled();
  });

  it('logs a render event with hasSourceLink=false when no workflow-link resolves, under its predictable category', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=workflow-identity');
    const { renderWorkflowIdentity } = await import('../../src/components/workflow-identity.js');

    renderWorkflowIdentity(workflow);

    expect(debugFn).toHaveBeenCalledWith('[cao:workflow-identity]', { event: 'render', hasSourceLink: false });
  });

  it('logs a render event with hasSourceLink=true when a workflow-link resolves', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=workflow-identity');
    const { renderWorkflowIdentity } = await import('../../src/components/workflow-identity.js');

    renderWorkflowIdentity(workflowWithLink);

    expect(debugFn).toHaveBeenCalledWith('[cao:workflow-identity]', { event: 'render', hasSourceLink: true });
  });

  it('never logs record content, only scalar metadata', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=workflow-identity');
    const { renderWorkflowIdentity } = await import('../../src/components/workflow-identity.js');

    renderWorkflowIdentity(workflowWithLink);

    for (const call of debugFn.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });

  it('does not enable logging for an unrelated debug category', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=workflow-badges');
    const { renderWorkflowIdentity } = await import('../../src/components/workflow-identity.js');

    renderWorkflowIdentity(workflowWithLink);

    expect(debugFn).not.toHaveBeenCalled();
  });
});
