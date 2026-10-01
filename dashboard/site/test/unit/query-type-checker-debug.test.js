import { afterEach, describe, expect, it, vi } from 'vitest';

/** @param {Record<string, unknown>} value */
const query = (value) => ({ subject: 'Exercise static query reference checking.', ...value });

const definitions = [
  query({ name: 'usage-by-workflow', from: 'usage' }),
  query({ name: 'first', from: 'second' }),
  query({ name: 'second', from: 'first' })
];

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('query type checker debug logging', () => {
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
    const { compileDashboardQueryTypes } = await import('../../src/query-type-checker.js');

    compileDashboardQueryTypes(definitions);

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs compile start, dependency cycles, and compile completion under its predictable category when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=query-type-checker', output })
      };
    });
    vi.resetModules();
    const { compileDashboardQueryTypes } = await import('../../src/query-type-checker.js');

    const result = compileDashboardQueryTypes(definitions);

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:query-type-checker]',
      'compile-start',
      { queryCount: 3 }
    );
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:query-type-checker]',
      'dependency-cycle',
      { cyclicQueryCount: 2 }
    );
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:query-type-checker]',
      'compile-complete',
      expect.objectContaining({
        queryCount: 3,
        errorCount: result.errors.length,
        durationMs: expect.any(Number)
      })
    );
  });

  it('does not log a dependency-cycle event when there is no cycle', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=query-type-checker', output })
      };
    });
    vi.resetModules();
    const { compileDashboardQueryTypes } = await import('../../src/query-type-checker.js');

    compileDashboardQueryTypes([query({ name: 'usage-by-workflow', from: 'usage' })]);

    const calls = output.debug.mock.calls.map(([, event, payload]) => ({ event, payload }));
    expect(calls.some((call) => call.event === 'dependency-cycle')).toBe(false);
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
          actual.createDebug(category, { search: () => '?debug=query-type-checker', output })
      };
    });
    vi.resetModules();
    const { compileDashboardQueryTypes } = await import('../../src/query-type-checker.js');

    compileDashboardQueryTypes(definitions);

    for (const call of output.debug.mock.calls) {
      const [, , payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('usage-by-workflow');
      expect(JSON.stringify(payload)).not.toContain('first');
      expect(JSON.stringify(payload)).not.toContain('second');
    }
  });
});
