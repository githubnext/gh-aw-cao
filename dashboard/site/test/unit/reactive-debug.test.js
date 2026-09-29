import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('reactive.js debug logging', () => {
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
    const { effect, batch, state } = await import('../../src/reactive.js');

    const counter = state(0);
    const handle = effect(() => {
      counter.get();
    });
    batch(() => {
      counter.set(1);
    });
    handle.stop();

    const controller = new AbortController();
    controller.abort();
    effect(() => {}, { signal: controller.signal });

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a flush-start outcome with predictable category when a batch schedules pending work', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => '?debug=reactive', output })
      };
    });
    vi.resetModules();
    const { effect, batch, state } = await import('../../src/reactive.js');

    const counter = state(0);
    const handle = effect(() => {
      counter.get();
    });
    output.debug.mockClear();

    batch(() => {
      counter.set(1);
    });

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:reactive]',
      { event: 'flush-start', computedCount: 0, effectCount: 1 }
    );
    handle.stop();
  });

  it('logs an effect-stopped outcome when an effect is stopped', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => '?debug=reactive', output })
      };
    });
    vi.resetModules();
    const { effect } = await import('../../src/reactive.js');

    const handle = effect(() => {});
    output.debug.mockClear();
    handle.stop();

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:reactive]',
      { event: 'effect-stopped', computed: false, cleanupCount: 0 }
    );
  });

  it('logs an effect-aborted-before-start outcome for an already-aborted signal', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => '?debug=reactive', output })
      };
    });
    vi.resetModules();
    const { effect } = await import('../../src/reactive.js');

    const controller = new AbortController();
    controller.abort();
    effect(() => {}, { signal: controller.signal });

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:reactive]',
      { event: 'effect-aborted-before-start', computed: false }
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
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => '?debug=reactive', output })
      };
    });
    vi.resetModules();
    const { effect, batch, state } = await import('../../src/reactive.js');

    const secretState = state('super-secret-token-value');
    const handle = effect(() => {
      secretState.get();
    });
    batch(() => {
      secretState.set('another-secret-value');
    });
    handle.stop();

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toMatch(/secret/);
    }
  });
});
