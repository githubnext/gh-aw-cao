import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('compliance suite debug logging', () => {
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
    const { runComplianceSmokeSuite } = await import('../../src/compliance.js');

    runComplianceSmokeSuite();

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs the suite start, appendix validation outcome, and completion counts under its predictable category when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=compliance', output })
      };
    });
    vi.resetModules();
    const { runComplianceSmokeSuite } = await import('../../src/compliance.js');

    const results = runComplianceSmokeSuite();

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:compliance]',
      { operation: 'compliance-smoke-suite', status: 'start' }
    );
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:compliance]',
      { operation: 'appendix-a-validation', status: 'ok' }
    );
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:compliance]',
      {
        operation: 'compliance-smoke-suite',
        status: 'complete',
        count: results.length,
        failCount: results.filter((result) => result.status === 'fail').length
      }
    );
  });

  it('never logs failure evidence text, only scalar status and counts', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=compliance', output })
      };
    });
    vi.resetModules();
    const { runComplianceSmokeSuite } = await import('../../src/compliance.js');

    runComplianceSmokeSuite();

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
