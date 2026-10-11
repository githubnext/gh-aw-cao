// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  document.body.replaceChildren();
  globalThis.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
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

/** Navigates jsdom to the canvas-only URL the component requires to render. */
function useCanvasUrl() {
  globalThis.history.replaceState(null, '', '/?local-preview=canvas');
}

describe('query editor component debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    useCanvasUrl();
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?local-preview=canvas');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ intent: 'i', subject: 's', objective: 'o', acceptance: 'a' })
    }));
    const { renderQueryEditor } = await import('../../src/components/query-editor.js');

    const root = renderQueryEditor({ pageId: 'query-editor-page', title: 'Query editor', sourceNames: [], sources: {}, contextDetails: [], headingTag: 'h2' });
    document.body.append(root);
    const improve = /** @type {HTMLButtonElement} */ (root.querySelector('.query-editor-improve'));
    improve.click();
    await vi.waitFor(() => expect(root.getAttribute('aria-busy')).toBe('false'));

    expect(debugFn).not.toHaveBeenCalled();
  });

  it('logs a succeeded enhance operation under its predictable category when the debug query matches', async () => {
    useCanvasUrl();
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?local-preview=canvas&debug=components:query-editor');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ intent: 'i', subject: 's', objective: 'o', acceptance: 'a' })
    }));
    const { renderQueryEditor } = await import('../../src/components/query-editor.js');

    const root = renderQueryEditor({ pageId: 'query-editor-page', title: 'Query editor', sourceNames: [], sources: {}, contextDetails: [], headingTag: 'h2' });
    document.body.append(root);
    const improve = /** @type {HTMLButtonElement} */ (root.querySelector('.query-editor-improve'));
    improve.click();
    await vi.waitFor(() => expect(root.getAttribute('aria-busy')).toBe('false'));

    expect(debugFn).toHaveBeenCalledWith('[cao:components:query-editor]', { operation: 'enhance', status: 'succeeded' });
  });

  it('logs a failed operation with only a sanitized error name, never the raw message', async () => {
    useCanvasUrl();
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?local-preview=canvas&debug=components:query-editor');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('administrator access is required')));
    const { renderQueryEditor } = await import('../../src/components/query-editor.js');

    const root = renderQueryEditor({ pageId: 'query-editor-page', title: 'Query editor', sourceNames: [], sources: {}, contextDetails: [], headingTag: 'h2' });
    document.body.append(root);
    const improve = /** @type {HTMLButtonElement} */ (root.querySelector('.query-editor-improve'));
    improve.click();
    await vi.waitFor(() => expect(root.getAttribute('aria-busy')).toBe('false'));

    expect(debugFn).toHaveBeenCalledWith('[cao:components:query-editor]', { operation: 'enhance', status: 'failed', error: 'Error' });
    for (const call of debugFn.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('administrator access is required');
    }
  });
});
