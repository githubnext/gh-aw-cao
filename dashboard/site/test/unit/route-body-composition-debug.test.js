import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('route body composition debug logging', () => {
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
    const { selectConfigBody } = await import('../../src/components/route-body-composition.js');

    selectConfigBody({ values: ['insights', 'reports'], fallback: 'reports' }, '<unknown-sensitive-body>');

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
          actual.createDebug(category, { search: () => '?debug=route-body-composition', output })
      };
    });
    vi.resetModules();
    const { selectConfigBody } = await import('../../src/components/route-body-composition.js');
    const config = { values: ['insights', 'reports'], fallback: 'reports' };

    const recognized = selectConfigBody(config, 'insights');
    expect(recognized).toBe('insights');
    expect(output.debug).not.toHaveBeenCalled();

    const fallback = selectConfigBody(config, '<unknown-sensitive-body>');
    expect(fallback).toBe('reports');
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:route-body-composition]',
      { event: 'body-fallback', body: '<unknown-sensitive-body>', fallback: 'reports' }
    );
  });

  it('coerces non-string selections to a type name instead of logging the raw value', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=route-body-composition', output })
      };
    });
    vi.resetModules();
    const { selectConfigBody } = await import('../../src/components/route-body-composition.js');
    const config = { values: ['insights', 'reports'], fallback: 'reports' };

    const fallback = selectConfigBody(config, { secret: 'do-not-log' });
    expect(fallback).toBe('reports');
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:route-body-composition]',
      { event: 'body-fallback', body: 'object', fallback: 'reports' }
    );

    // Never log anything beyond the already-computed scalar metadata fields.
    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('do-not-log');
    }
  });
});
