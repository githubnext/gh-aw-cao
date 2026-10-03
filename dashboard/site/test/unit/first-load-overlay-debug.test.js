// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserFirstLoad } from '../../src/browser-first-load.js';

afterEach(() => {
  document.body.replaceChildren();
  browserFirstLoad.set({ status: 'inactive', dismissed: false });
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

describe('first-load overlay debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '');
    const { mountFirstLoadOverlay } = await import('../../src/components/first-load-overlay.js');
    const { browserFirstLoad: scopedFirstLoad } = await import('../../src/browser-first-load.js');

    scopedFirstLoad.set({ status: 'loading', dismissed: false });
    const owner = new AbortController();
    mountFirstLoadOverlay({ document, signal: owner.signal, retry: vi.fn() });
    const dismissButton = document.querySelector('.first-load-browse');
    dismissButton?.dispatchEvent(new MouseEvent('click'));
    owner.abort();

    expect(debugFn).not.toHaveBeenCalled();
  });

  it('logs a mounted event with the current status under its predictable category', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=first-load-overlay');
    const { mountFirstLoadOverlay } = await import('../../src/components/first-load-overlay.js');
    const { browserFirstLoad: scopedFirstLoad } = await import('../../src/browser-first-load.js');

    scopedFirstLoad.set({ status: 'loading', dismissed: false });
    const owner = new AbortController();
    mountFirstLoadOverlay({ document, signal: owner.signal, retry: vi.fn() });
    owner.abort();

    expect(debugFn).toHaveBeenCalledWith('[cao:first-load-overlay]', { event: 'mounted', status: 'loading' });
  });

  it('logs a dismissed event when the explore-while-loading button is clicked', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=first-load-overlay');
    const { mountFirstLoadOverlay } = await import('../../src/components/first-load-overlay.js');
    const { browserFirstLoad: scopedFirstLoad } = await import('../../src/browser-first-load.js');

    scopedFirstLoad.set({ status: 'loading', dismissed: false });
    const owner = new AbortController();
    mountFirstLoadOverlay({ document, signal: owner.signal, retry: vi.fn() });
    const dismissButton = /** @type {HTMLButtonElement | null} */ (document.querySelector('.first-load-browse'));
    dismissButton?.click();
    owner.abort();

    expect(debugFn).toHaveBeenCalledWith('[cao:first-load-overlay]', { event: 'dismissed' });
  });

  it('logs a retry-requested event when the failed-state retry button is clicked', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=first-load-overlay');
    const { mountFirstLoadOverlay } = await import('../../src/components/first-load-overlay.js');
    const { browserFirstLoad: scopedFirstLoad } = await import('../../src/browser-first-load.js');

    scopedFirstLoad.set({ status: 'failed', dismissed: false });
    const owner = new AbortController();
    const retry = vi.fn();
    mountFirstLoadOverlay({ document, signal: owner.signal, retry });
    const retryButton = [...document.querySelectorAll('.first-load-browse')]
      .find((candidate) => candidate.textContent === 'Retry import');
    /** @type {HTMLButtonElement | null} */ (retryButton)?.click();
    owner.abort();

    expect(debugFn).toHaveBeenCalledWith('[cao:first-load-overlay]', { event: 'retry-requested' });
    expect(retry).toHaveBeenCalledOnce();
  });

  it('never logs record content, only scalar metadata', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=first-load-overlay');
    const { mountFirstLoadOverlay } = await import('../../src/components/first-load-overlay.js');
    const { browserFirstLoad: scopedFirstLoad } = await import('../../src/browser-first-load.js');

    scopedFirstLoad.set({ status: 'failed', dismissed: false });
    const owner = new AbortController();
    const retry = vi.fn();
    mountFirstLoadOverlay({ document, signal: owner.signal, retry });
    document.querySelector('.first-load-close')?.dispatchEvent(new MouseEvent('click'));
    const retryButton = [...document.querySelectorAll('.first-load-browse')]
      .find((candidate) => candidate.textContent === 'Retry import');
    /** @type {HTMLButtonElement | null} */ (retryButton)?.click();
    owner.abort();

    for (const call of debugFn.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
