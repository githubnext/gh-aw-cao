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

describe('simulation-days debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '');
    const { simulationDaysSource } = await import('../../src/data/queries/simulation-days.js');

    simulationDaysSource();

    expect(debugFn).not.toHaveBeenCalled();
  });

  it('logs a resolved event with the row count under its predictable category when enabled', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=simulation-days');
    const { simulationDaysSource } = await import('../../src/data/queries/simulation-days.js');

    simulationDaysSource();

    expect(debugFn).toHaveBeenCalledWith('[cao:simulation-days]', { event: 'resolved', rowCount: 30 });
  });

  it('never logs the generated row content, only scalar metadata', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=simulation-days');
    const { simulationDaysSource } = await import('../../src/data/queries/simulation-days.js');

    simulationDaysSource();

    for (const call of debugFn.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
