// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('view chrome debug logging', () => {
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
    const { renderCustomViewStateDetails } = await import('../../src/components/view-chrome.js');

    renderCustomViewStateDetails('mcp-top-tools', [], { code: 'input-unavailable', source: 'mcp-tool-totals' });

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs under the predictable category name derived from the filename', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=view-chrome', output })
      };
    });
    vi.resetModules();
    const { renderCustomViewStateDetails } = await import('../../src/components/view-chrome.js');

    renderCustomViewStateDetails('mcp-top-tools', [], { code: 'input-unavailable', source: 'mcp-tool-totals' });

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:view-chrome]',
      {
        event: 'custom-view-state-details',
        hasSourceName: true,
        hasQueryError: true,
        dependencyResolved: true,
        detailCount: 2
      }
    );
  });

  it('reports only scalar, already-computed metadata and excludes sensitive values', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=view-chrome', output })
      };
    });
    vi.resetModules();
    const { renderCustomViewStateDetails } = await import('../../src/components/view-chrome.js');

    renderCustomViewStateDetails(null, ['Scope: {"organization":"<secret-token>"}'], 'raw sensitive error text');

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:view-chrome]',
      {
        event: 'custom-view-state-details',
        hasSourceName: false,
        hasQueryError: false,
        dependencyResolved: false,
        detailCount: 1
      }
    );
    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      expect(JSON.stringify(payload)).not.toContain('secret-token');
      expect(JSON.stringify(payload)).not.toContain('raw sensitive error text');
      expect(Object.values(payload).every((value) => typeof value !== 'object')).toBe(true);
    }
  });
});
