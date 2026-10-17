// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  document.body.replaceChildren();
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

describe('refresh error debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '');
    const { notifyRefreshError } = await import('../../src/components/refresh-error.js');

    notifyRefreshError(vi.fn());
    document.querySelector('.dashboard-notification-action')?.dispatchEvent(new MouseEvent('click'));
    document.querySelector('.dashboard-notification-dismiss')?.dispatchEvent(new MouseEvent('click'));

    expect(debugFn).not.toHaveBeenCalled();
  });

  it('logs a shown event under its predictable category when the banner is rendered', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=refresh-error');
    const { notifyRefreshError } = await import('../../src/components/refresh-error.js');

    notifyRefreshError(vi.fn());

    expect(debugFn).toHaveBeenCalledWith('[cao:refresh-error]', { event: 'shown' });
  });

  it('logs a retry-requested event when the retry button is clicked', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=refresh-error');
    const { notifyRefreshError } = await import('../../src/components/refresh-error.js');
    const retry = vi.fn();

    notifyRefreshError(retry);
    const retryButton = /** @type {HTMLButtonElement | null} */ (document.querySelector('.dashboard-notification-action'));
    retryButton?.click();

    expect(retry).toHaveBeenCalledOnce();
    expect(debugFn).toHaveBeenCalledWith('[cao:refresh-error]', { event: 'retry-requested' });
  });

  it('delegates dismissal logging to the shared manager', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=notification-service');
    const { notifyRefreshError } = await import('../../src/components/refresh-error.js');

    notifyRefreshError(vi.fn());
    const dismissButton = /** @type {HTMLButtonElement | null} */ (document.querySelector('.dashboard-notification-dismiss'));
    dismissButton?.click();
    document.querySelector('.dashboard-notification')?.dispatchEvent(new Event('transitionend'));

    expect(debugFn).toHaveBeenCalledWith('[cao:notification-service]', { event: 'dismissed', tone: 'error', activeCount: 0 });
  });

  it('never logs record content, only scalar metadata', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=refresh-error');
    const { notifyRefreshError } = await import('../../src/components/refresh-error.js');

    notifyRefreshError(vi.fn());
    document.querySelector('.dashboard-notification-action')?.dispatchEvent(new MouseEvent('click'));
    document.querySelector('.dashboard-notification-dismiss')?.dispatchEvent(new MouseEvent('click'));

    for (const call of debugFn.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
