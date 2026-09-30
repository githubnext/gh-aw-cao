// @vitest-environment jsdom
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

describe('page load error debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '');
    const { renderPageLoadError } = await import('../../src/components/page-load-error.js');
    const { DashboardServerError } = await import('../../src/remote-data-backend.js');

    const error = renderPageLoadError(
      new DashboardServerError('limit exceeded', 'query_plan_too_large', 'campaign-repository-coverage', 'retained_bytes'),
      vi.fn()
    );
    error.querySelector('button')?.dispatchEvent(new MouseEvent('click'));

    expect(debugFn).not.toHaveBeenCalled();
  });

  it('logs a classified event with a matched presentation for a recognized server error code', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=page-load-error');
    const { renderPageLoadError } = await import('../../src/components/page-load-error.js');
    const { DashboardServerError } = await import('../../src/remote-data-backend.js');

    renderPageLoadError(
      new DashboardServerError('limit exceeded', 'query_plan_too_large', 'campaign-repository-coverage', 'retained_bytes'),
      vi.fn()
    );

    expect(debugFn).toHaveBeenCalledWith('[cao:page-load-error]', {
      event: 'classified',
      errorKind: 'server',
      code: 'query_plan_too_large',
      matched: true,
      hasBoundary: true
    });
  });

  it('logs a classified event with no match for a generic (non-server) error', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=page-load-error');
    const { renderPageLoadError } = await import('../../src/components/page-load-error.js');

    renderPageLoadError(new Error('internal details'), vi.fn());

    expect(debugFn).toHaveBeenCalledWith('[cao:page-load-error]', {
      event: 'classified',
      errorKind: 'generic',
      code: undefined,
      matched: false,
      hasBoundary: false
    });
  });

  it('logs a retry-requested event when the retry button is clicked', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=page-load-error');
    const { renderPageLoadError } = await import('../../src/components/page-load-error.js');
    const retry = vi.fn();

    const error = renderPageLoadError(new Error('internal details'), retry);
    /** @type {HTMLButtonElement | null} */ (error.querySelector('button'))?.click();

    expect(retry).toHaveBeenCalledOnce();
    expect(debugFn).toHaveBeenCalledWith('[cao:page-load-error]', { event: 'retry-requested' });
  });

  it('never logs record content, only scalar metadata', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=page-load-error');
    const { renderPageLoadError } = await import('../../src/components/page-load-error.js');
    const { DashboardServerError } = await import('../../src/remote-data-backend.js');

    const error = renderPageLoadError(
      new DashboardServerError('limit 536870912', 'query_plan_too_large', 'campaign-inventory', '__proto__'),
      vi.fn()
    );
    error.querySelector('button')?.dispatchEvent(new MouseEvent('click'));

    for (const call of debugFn.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(value === null || value === undefined || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
