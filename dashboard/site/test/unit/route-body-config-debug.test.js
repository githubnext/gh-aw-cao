import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('route body config debug logging', () => {
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
    const { createRouteBodyConfig } = await import('../../src/components/route-body-config.js');

    const config = createRouteBodyConfig(/** @type {const} */ (['reports', 'runs']), 'reports');
    config.body('<unknown-sensitive-body>');
    config.composition({ reports: 'report-view', runs: 'runs-view' }, '<unknown-sensitive-body>');

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a fallback event only for unrecognized bodies, under a predictable category', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=route-body-config', output })
      };
    });
    vi.resetModules();
    const { createRouteBodyConfig } = await import('../../src/components/route-body-config.js');

    const config = createRouteBodyConfig(/** @type {const} */ (['reports', 'runs']), 'reports');

    const recognized = config.body('runs');
    expect(recognized).toBe('runs');
    expect(output.debug).not.toHaveBeenCalled();

    const fallback = config.body('<unknown-sensitive-body>');
    expect(fallback).toBe('reports');
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:route-body-config]',
      { event: 'body-fallback', requested: '<unknown-sensitive-body>', fallback: 'reports' }
    );
  });

  it('logs non-string selections as their type name, never the raw value', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=route-body-config', output })
      };
    });
    vi.resetModules();
    const { createRouteBodyConfig } = await import('../../src/components/route-body-config.js');

    const config = createRouteBodyConfig(/** @type {const} */ (['reports', 'runs']), 'reports');

    config.body({ secret: 'token-abc' });
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:route-body-config]',
      { event: 'body-fallback', requested: 'object', fallback: 'reports' }
    );

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      expect(JSON.stringify(payload)).not.toContain('token-abc');
    }
  });

  it('logs a fallback event once through composition(), reusing body() resolution', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=route-body-config', output })
      };
    });
    vi.resetModules();
    const { createRouteBodyConfig } = await import('../../src/components/route-body-config.js');

    const config = createRouteBodyConfig(/** @type {const} */ (['reports', 'runs']), 'reports');

    const resolved = config.composition({ reports: 'report-view', runs: 'runs-view' }, 'invalid');
    expect(resolved).toBe('report-view');
    expect(output.debug).toHaveBeenCalledTimes(1);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:route-body-config]',
      { event: 'body-fallback', requested: 'invalid', fallback: 'reports' }
    );
  });
});
