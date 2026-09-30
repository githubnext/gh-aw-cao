import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('workflow route composition debug logging', () => {
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
    const { workflowRouteComposition } = await import('../../src/components/workflow-route-composition.js');

    workflowRouteComposition('insights');

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs predictable composition resolution metadata under its category name when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=workflow-route-composition', output })
      };
    });
    vi.resetModules();
    const { workflowRouteComposition } = await import('../../src/components/workflow-route-composition.js');

    workflowRouteComposition('runs');
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:workflow-route-composition]',
      { event: 'composition-resolved', tab: 'runs', fellBackToDefault: false }
    );

    output.debug.mockClear();
    workflowRouteComposition('<unknown-with-sensitive-text>');
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:workflow-route-composition]',
      { event: 'composition-resolved', tab: 'reports', fellBackToDefault: true }
    );

    // Never log the raw, potentially sensitive requested body value itself.
    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      expect(JSON.stringify(payload)).not.toContain('sensitive-text');
    }
  });
});
