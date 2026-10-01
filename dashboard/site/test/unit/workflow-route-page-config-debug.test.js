import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('workflow route page config debug logging', () => {
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
    const { workflowRoutePageConfig, workflowRoutePageConfigForBody } = await import(
      '../../src/components/workflow-route-page-config.js'
    );

    workflowRoutePageConfig('<unknown-sensitive-page-id>');
    workflowRoutePageConfigForBody('<unknown-sensitive-body>');

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a fallback event only for unrecognized page IDs, under a predictable category', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=workflow-route-page-config', output })
      };
    });
    vi.resetModules();
    const { workflowRoutePageConfig } = await import('../../src/components/workflow-route-page-config.js');

    const resolved = workflowRoutePageConfig('workflow-runs');
    expect(resolved.pageId).toBe('workflow-runs');
    expect(output.debug).not.toHaveBeenCalled();

    const fallback = workflowRoutePageConfig('<unknown-sensitive-page-id>');
    expect(fallback.pageId).toBe('workflow-detail');
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:workflow-route-page-config]',
      { event: 'page-id-fallback', pageId: '<unknown-sensitive-page-id>' }
    );
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
          actual.createDebug(category, { search: () => '?debug=workflow-route-page-config', output })
      };
    });
    vi.resetModules();
    const { workflowRoutePageConfigForBody } = await import('../../src/components/workflow-route-page-config.js');

    const resolved = workflowRoutePageConfigForBody('runs');
    expect(resolved.pageId).toBe('workflow-runs');
    expect(output.debug).not.toHaveBeenCalled();

    const fallback = workflowRoutePageConfigForBody('<unknown-sensitive-body>');
    expect(fallback.pageId).toBe('workflow-detail');
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:workflow-route-page-config]',
      { event: 'body-fallback', body: '<unknown-sensitive-body>' }
    );

    // Never log anything beyond the already-computed metadata fields.
    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      expect(Object.keys(payload).sort()).toEqual(expect.arrayContaining(['event']));
    }
  });
});
