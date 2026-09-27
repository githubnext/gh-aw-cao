// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('dashboard-interactions debug logging', () => {
  afterEach(() => {
    Reflect.deleteProperty(document, 'startViewTransition');
    Reflect.deleteProperty(document.documentElement.dataset, 'navigationDirection');
    vi.doUnmock('../../src/debug.js');
    vi.resetModules();
  });

  /** @param {string} search */
  async function importWithDebug(search) {
    const output = { debug: vi.fn() };
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
    const module = await import('../../src/components/dashboard-interactions.js');
    return { output, updateWithViewTransition: module.updateWithViewTransition };
  }

  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const { output, updateWithViewTransition: update } = await importWithDebug('');
    const runUpdate = vi.fn();
    update(document, runUpdate);
    expect(runUpdate).toHaveBeenCalledTimes(1);
    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs the predictable "unsupported" skip reason with only scalar metadata', async () => {
    const { output, updateWithViewTransition: update } = await importWithDebug('?debug=dashboard-interactions');
    const runUpdate = vi.fn();

    update(document, runUpdate, 'forward');

    expect(runUpdate).toHaveBeenCalledTimes(1);
    expect(output.debug).toHaveBeenCalledWith('[cao:dashboard-interactions]', {
      event: 'transition-skipped',
      reason: 'unsupported',
      direction: 'forward'
    });
    for (const call of output.debug.mock.calls) {
      const metadata = call[1];
      expect(Object.values(metadata).every((value) => typeof value !== 'object' || value === null)).toBe(true);
    }
  });

  it('logs transition start and finish once a native view transition resolves', async () => {
    const { output, updateWithViewTransition: update } = await importWithDebug('?debug=dashboard-interactions');
    const runUpdate = vi.fn();
    /** @type {(value?: unknown) => void} */
    let finishTransition = () => {};
    const finished = new Promise((resolve) => {
      finishTransition = resolve;
    });
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: vi.fn((/** @type {() => void} */ callback) => {
        callback();
        return { finished };
      })
    });

    update(document, runUpdate, 'backward');

    expect(output.debug).toHaveBeenCalledWith('[cao:dashboard-interactions]', {
      event: 'transition-started',
      direction: 'backward'
    });

    finishTransition();
    await finished;
    await Promise.resolve();
    await Promise.resolve();

    expect(output.debug).toHaveBeenCalledWith('[cao:dashboard-interactions]', {
      event: 'transition-finished',
      direction: 'backward'
    });
  });
});
