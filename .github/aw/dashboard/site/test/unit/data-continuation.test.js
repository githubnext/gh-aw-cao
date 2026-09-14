import { describe, expect, it, vi } from 'vitest';
import {
  bindSourceContinuations,
  continuationRequests,
  sourceContinuation
} from '../../src/data/continuation.js';

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

describe('client continuation protocol', () => {
  it('creates bounded requests and binds a validated source loader', async () => {
    const loadPage = vi.fn()
      .mockResolvedValueOnce({
        runs: {
          source: 'runs',
          rows: [{ run: '1' }],
          continuationToken: 'page-3',
          metadata: metadata(3)
        }
      })
      .mockResolvedValueOnce({
      runs: {
        source: 'runs',
        rows: [],
        metadata: metadata(3)
      }
      });
    const sources = bindSourceContinuations({
      runs: {
        source: 'runs',
        rows: [{ run: '3' }, { run: '2' }],
        continuationToken: 'page-2',
        metadata: metadata(3)
      }
    }, ['runs'], loadPage, 2);

    const next = await sources.runs.loadContinuation?.('page-2');
    await sources.runs.loadContinuation?.('page-3');

    expect(continuationRequests(['runs'], 2)).toEqual({ runs: { limit: 2 } });
    expect(loadPage).toHaveBeenCalledWith(
      ['runs'],
      { runs: { limit: 2, continuationToken: 'page-2' } }
    );
    expect(next?.rows).toEqual([{ run: '1' }]);
    expect(sourceContinuation(sources.runs)?.totalRows).toBe(3);
  });

  it('rejects old tokens and stale continuation responses', async () => {
    const source = {
      source: 'runs',
      rows: [{ run: '3' }],
      continuationToken: 'current',
      metadata: metadata(2)
    };
    const stale = bindSourceContinuations(
      { runs: source },
      ['runs'],
      async () => ({
        runs: {
          source: 'runs',
          rows: [{ run: '2' }],
          metadata: metadata(3)
        }
      })
    ).runs;

    await expect(stale.loadContinuation?.('old'))
      .rejects.toThrow('Continuation token for "runs" is not current.');
    await expect(stale.loadContinuation?.('current'))
      .rejects.toThrow('Continuation data for "runs" is stale.');
  });

  it('rejects malformed continuation responses', async () => {
    expect(() => bindSourceContinuations({
      runs: {
        source: 'usage',
        rows: [],
        continuationToken: 'next',
        metadata: metadata(1)
      }
    }, ['runs'], async () => ({}))).toThrow('Invalid continuation response');
    expect(() => continuationRequests(['runs'], 0))
      .toThrow('Continuation page size must be a positive integer.');
    expect(sourceContinuation({
      source: 'runs',
      rows: [],
      continuationToken: 'next',
      metadata: metadata(1)
    })).toBeUndefined();
  });

  it('deduplicates concurrent requests for the current token', async () => {
    let resolvePage = () => {};
    const loadPage = vi.fn(() => new Promise((resolve) => {
      resolvePage = () => resolve({
        runs: { source: 'runs', rows: [], metadata: metadata(1) }
      });
    }));
    const source = bindSourceContinuations({
      runs: {
        source: 'runs',
        rows: [{ run: '1' }],
        continuationToken: 'next',
        metadata: metadata(1)
      }
    }, ['runs'], loadPage).runs;

    const first = source.loadContinuation?.('next');
    const second = source.loadContinuation?.('next');
    resolvePage();

    await expect(first).resolves.toBeDefined();
    await expect(second).resolves.toBeDefined();
    expect(loadPage).toHaveBeenCalledTimes(1);
  });
});
