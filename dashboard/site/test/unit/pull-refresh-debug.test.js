// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/** @param {HTMLElement} scroller @param {string} type @param {number} clientY */
function touch(scroller, type, clientY) {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, 'touches', {
    value: type === 'touchend' ? [] : [{ clientY }]
  });
  scroller.dispatchEvent(event);
}

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
  document.body.replaceChildren();
});

describe('pull-refresh debug logging', () => {
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
    const { enablePullRefresh } = await import('../../src/components/pull-refresh.js');

    const scroller = document.createElement('main');
    document.body.append(scroller);
    const controller = new AbortController();

    enablePullRefresh({ scroller, view: window, isActive: () => true, signal: controller.signal });
    touch(scroller, 'touchstart', 100);
    touch(scroller, 'touchmove', 180);
    touch(scroller, 'touchend', 180);

    expect(output.debug).not.toHaveBeenCalled();
    controller.abort();
  });

  it('logs armed and refresh-requested under its predictable category when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=pull-refresh', output })
      };
    });
    vi.resetModules();
    const { enablePullRefresh } = await import('../../src/components/pull-refresh.js');

    const scroller = document.createElement('main');
    document.body.append(scroller);
    const controller = new AbortController();

    enablePullRefresh({ scroller, view: window, isActive: () => true, signal: controller.signal });
    touch(scroller, 'touchstart', 100);
    touch(scroller, 'touchmove', 180);

    expect(output.debug).toHaveBeenCalledWith('[cao:pull-refresh]', { event: 'armed' });

    output.debug.mockClear();
    touch(scroller, 'touchend', 180);

    expect(output.debug).toHaveBeenCalledWith('[cao:pull-refresh]', { event: 'refresh-requested' });
    controller.abort();
  });

  it('does not log armed again while the gesture stays armed, and does not log on a below-threshold release', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=pull-refresh', output })
      };
    });
    vi.resetModules();
    const { enablePullRefresh } = await import('../../src/components/pull-refresh.js');

    const scroller = document.createElement('main');
    document.body.append(scroller);
    const controller = new AbortController();

    enablePullRefresh({ scroller, view: window, isActive: () => true, signal: controller.signal });
    touch(scroller, 'touchstart', 100);
    touch(scroller, 'touchmove', 180);
    output.debug.mockClear();
    touch(scroller, 'touchmove', 200);
    expect(output.debug).not.toHaveBeenCalled();
    touch(scroller, 'touchend', 200);
    controller.abort();

    const belowThresholdOutput = { debug: vi.fn() };
    vi.doUnmock('../../src/debug.js');
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=pull-refresh', output: belowThresholdOutput })
      };
    });
    vi.resetModules();
    const { enablePullRefresh: enablePullRefreshAgain } = await import('../../src/components/pull-refresh.js');
    const secondScroller = document.createElement('main');
    document.body.append(secondScroller);
    const secondController = new AbortController();
    enablePullRefreshAgain({ scroller: secondScroller, view: window, isActive: () => true, signal: secondController.signal });
    touch(secondScroller, 'touchstart', 100);
    touch(secondScroller, 'touchmove', 120);
    touch(secondScroller, 'touchend', 120);

    expect(belowThresholdOutput.debug).not.toHaveBeenCalled();
    secondController.abort();
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
          actual.createDebug(category, { search: () => '?debug=pull-refresh', output })
      };
    });
    vi.resetModules();
    const { enablePullRefresh } = await import('../../src/components/pull-refresh.js');

    const scroller = document.createElement('main');
    document.body.append(scroller);
    const controller = new AbortController();

    enablePullRefresh({ scroller, view: window, isActive: () => true, signal: controller.signal });
    touch(scroller, 'touchstart', 100);
    touch(scroller, 'touchmove', 180);
    touch(scroller, 'touchend', 180);
    controller.abort();

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
