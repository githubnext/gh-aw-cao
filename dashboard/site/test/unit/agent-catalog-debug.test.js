import { afterEach, describe, expect, it, vi } from 'vitest';

const document = {
  dashboard: {
    navigation: [{ pages: ['insights'] }],
    queries: [
      {
        name: 'usage-by-workflow',
        intent: 'Show observed AI Credit usage by workflow.',
        from: 'runs'
      },
      {
        name: 'missing-store-query',
        intent: 'Reads a store the local projection cannot provide.',
        from: 'nonexistent-store'
      }
    ],
    views: [
      {
        id: 'shared-usage',
        data: { source: 'usage-by-workflow' }
      }
    ],
    pages: [
      {
        id: 'insights',
        title: 'Insights',
        description: 'Inspect usage.',
        views: ['shared-usage']
      }
    ]
  }
};

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('agent catalog debug logging', () => {
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
    const { listQueries, describeQuery, queryExecutionRequirements } = await import('../../src/agent/catalog.js');

    listQueries(document);
    describeQuery(document, 'not-a-real-query');
    queryExecutionRequirements(document, 'missing-store-query');

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs cache rebuilds and unavailable-query diagnostics under its predictable category when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=catalog', output })
      };
    });
    vi.resetModules();
    const { listQueries, describeQuery, queryExecutionRequirements } = await import('../../src/agent/catalog.js');

    listQueries(document);
    // `listQueries` computes every query's execution requirements internally,
    // so the cache-rebuild and unavailable-query diagnostics fire during this call.
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:catalog]',
      { event: 'cache-rebuild', reason: 'new' }
    );
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:catalog]',
      { event: 'query-execution', queryId: 'missing-store-query', local: false, missingCount: 1 }
    );

    output.debug.mockClear();
    describeQuery(document, 'not-a-real-query');
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:catalog]',
      { event: 'describe-query', queryId: 'not-a-real-query', status: 'not-found' }
    );

    output.debug.mockClear();
    // Already cached by the earlier `listQueries` call; the requirement is
    // returned from cache and no further log is emitted for the same key.
    const requirements = queryExecutionRequirements(document, 'missing-store-query');
    expect(requirements.local).toBe(false);
    expect(output.debug).not.toHaveBeenCalled();
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
          actual.createDebug(category, { search: () => '?debug=catalog', output })
      };
    });
    vi.resetModules();
    const { listQueries, describeQuery, queryExecutionRequirements } = await import('../../src/agent/catalog.js');

    listQueries(document);
    describeQuery(document, 'not-a-real-query');
    queryExecutionRequirements(document, 'missing-store-query');

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('nonexistent-store');
      expect(JSON.stringify(payload)).not.toContain('does not provide');
    }
  });
});
