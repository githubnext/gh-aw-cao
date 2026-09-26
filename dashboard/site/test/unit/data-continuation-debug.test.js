import { describe, expect, it, vi } from 'vitest';

/** @param {number} total @returns {import('../../src/presenter.js').SourceMetadata} */
const metadata = (total) => ({
  'source-id': 'runs',
  'source-kind': 'derived',
  'as-of': '2026-09-09T00:00:00Z',
  'retrieved-at': '2026-09-09T00:00:00Z',
  completeness: 'complete',
  freshness: 'fresh',
  availability: 'available',
  'total-row-count': total
});

describe('continuation debug logging', () => {
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
    const { bindSourceContinuations: bind, drainSourceContinuation: drain } =
      await import('../../src/data/continuation.js');

    const loadPage = vi.fn().mockResolvedValue({
      runs: { source: 'runs', rows: [], metadata: metadata(1) }
    });
    const source = bind({
      runs: {
        source: 'runs',
        rows: [{ run: '1' }],
        continuationToken: 'next',
        metadata: metadata(1)
      }
    }, ['runs'], loadPage).runs;

    await expect(source.loadContinuation?.('stale')).rejects.toThrow();
    await drain(source);

    expect(output.debug).not.toHaveBeenCalled();

    vi.doUnmock('../../src/debug.js');
    vi.resetModules();
  });

  it('logs only scalar metadata under its predictable category when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=continuation', output })
      };
    });
    vi.resetModules();
    const { bindSourceContinuations: bind, drainSourceContinuation: drain } =
      await import('../../src/data/continuation.js');

    const source = bind({
      runs: {
        source: 'runs',
        rows: [{ run: '1' }],
        continuationToken: 'current',
        metadata: metadata(2)
      }
    }, ['runs'], async () => ({
      runs: { source: 'runs', rows: [{ run: '2' }], metadata: metadata(2) }
    })).runs;

    await expect(source.loadContinuation?.('stale-token')).rejects.toThrow();
    expect(output.debug).toHaveBeenCalledWith('[cao:continuation]', {
      event: 'stale-token-rejected',
      source: 'runs'
    });

    await source.loadContinuation?.('current');
    expect(output.debug).toHaveBeenCalledWith('[cao:continuation]', {
      event: 'page-loaded',
      source: 'runs',
      rowCount: 1,
      hasMore: false
    });

    const loadPage = vi.fn()
      .mockResolvedValueOnce({
        runs: { source: 'runs', rows: [{ run: '2' }], continuationToken: 'page-2', metadata: metadata(3) }
      })
      .mockResolvedValueOnce({
        runs: { source: 'runs', rows: [{ run: '3' }], metadata: metadata(3) }
      });
    const drainable = bind({
      runs: {
        source: 'runs',
        rows: [{ run: '1' }],
        continuationToken: 'page-1',
        metadata: metadata(3)
      }
    }, ['runs'], loadPage).runs;

    await drain(drainable);
    expect(output.debug).toHaveBeenCalledWith('[cao:continuation]', {
      event: 'drain-completed',
      source: 'runs',
      pagesLoaded: 2,
      rowCount: 3
    });

    for (const call of output.debug.mock.calls) {
      const message = call[1];
      expect(Object.values(message).every((value) => typeof value !== 'object')).toBe(true);
    }

    vi.doUnmock('../../src/debug.js');
    vi.resetModules();
  });
});
