// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/** @param {{ search: () => string, output: { debug: import('vitest').Mock } }} options */
async function mockedCompiler({ search, output }) {
  vi.doMock('../../src/debug.js', async () => {
    const actual = /** @type {typeof import('../../src/debug.js')} */ (
      await vi.importActual('../../src/debug.js')
    );
    return {
      ...actual,
      createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search, output })
    };
  });
  vi.resetModules();
  return import('../../src/data/queries/view-payload-compiler.js');
}

describe('view payload compiler debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const output = { debug: vi.fn() };
    const { compileDashboardViewPayloadQueries } = await mockedCompiler({ search: () => '', output });

    compileDashboardViewPayloadQueries({
      views: [{ id: 'runs-list', data: { source: 'runs', filters: { 'run-conclusion': 'success' } } }]
    }, 'operations');

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs the compiled alias, query, and replaced-source counts under its predictable category when enabled', async () => {
    const output = { debug: vi.fn() };
    const { compileDashboardViewPayloadQueries } = await mockedCompiler({
      search: () => '?debug=view-payload-compiler',
      output
    });

    compileDashboardViewPayloadQueries({
      views: [
        { id: 'successes', data: { source: 'runs', filters: { 'run-conclusion': 'success' } } },
        { id: 'failures', data: { source: 'runs', filters: { 'run-conclusion': 'failure' } } }
      ]
    }, 'operations');

    expect(output.debug).toHaveBeenCalledWith('[cao:view-payload-compiler]', {
      event: 'compiled',
      pageId: 'operations',
      viewId: null,
      viewCount: 2,
      aliasCount: 2,
      queryCount: 2,
      replacedSourceCount: 0
    });
  });

  it('logs a parameter-resolution failure with only the query name and reason', async () => {
    const output = { debug: vi.fn() };
    const { resolveDashboardQueryParameters } = await mockedCompiler({
      search: () => '?debug=view-payload-compiler',
      output
    });

    expect(() => resolveDashboardQueryParameters([
      {
        name: 'runs-by-multiplier',
        from: 'runs',
        parameters: [{ name: 'multiplier', type: 'number' }],
        limit: { parameter: 'unknown-parameter' }
      }
    ], {})).toThrow('references undeclared parameter "unknown-parameter"');

    expect(output.debug).toHaveBeenCalledWith('[cao:view-payload-compiler]', {
      event: 'parameter-resolution-failed',
      query: 'runs-by-multiplier',
      reason: 'undeclared-parameter'
    });

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number').toBe(true);
      }
    }
  });

  it('logs a missing-form-parameter failure distinctly from an undeclared parameter', async () => {
    const output = { debug: vi.fn() };
    const { resolveDashboardQueryParameters } = await mockedCompiler({
      search: () => '?debug=view-payload-compiler',
      output
    });

    expect(() => resolveDashboardQueryParameters([
      {
        name: 'runs-by-multiplier',
        from: 'runs',
        parameters: [{ name: 'multiplier', type: 'number' }],
        limit: { parameter: 'multiplier' }
      }
    ], {})).toThrow('requires form parameter "multiplier"');

    expect(output.debug).toHaveBeenCalledWith('[cao:view-payload-compiler]', {
      event: 'parameter-resolution-failed',
      query: 'runs-by-multiplier',
      reason: 'missing-form-parameter'
    });
  });
});
