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

describe('workflow-badges debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '');
    const { workflowRole } = await import('../../src/components/workflow-badges.js');

    workflowRole({});

    expect(debugFn).not.toHaveBeenCalled();
  });

  it('does not log when the workflow role is recognized', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=workflow-badges');
    const { workflowRole } = await import('../../src/components/workflow-badges.js');

    expect(workflowRole({ 'workflow-role': 'orchestrator' })).toBe('orchestrator');

    expect(debugFn).not.toHaveBeenCalled();
  });

  it('logs a role-fallback event with the resolved role and membership count under its predictable category', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=workflow-badges');
    const { workflowRole } = await import('../../src/components/workflow-badges.js');

    expect(workflowRole({
      campaign: 'ambient-context',
      'campaign-name': 'Ambient Context'
    })).toBe('operation');

    expect(debugFn).toHaveBeenCalledWith('[cao:workflow-badges]', {
      event: 'role-fallback',
      resolved: 'operation',
      membershipCount: 1
    });

    debugFn.mockClear();
    expect(workflowRole({})).toBe('unknown');

    expect(debugFn).toHaveBeenCalledWith('[cao:workflow-badges]', {
      event: 'role-fallback',
      resolved: 'unknown',
      membershipCount: 0
    });
  });

  it('never logs record content, only scalar metadata', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=workflow-badges');
    const { workflowRole } = await import('../../src/components/workflow-badges.js');

    workflowRole({
      campaign: 'ambient-context',
      'campaign-name': 'Ambient Context',
      'campaign-memberships': [{ id: 'secret-token', name: 'should-not-leak' }]
    });

    for (const call of debugFn.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
