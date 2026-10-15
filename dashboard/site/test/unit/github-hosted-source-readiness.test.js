// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { deleteCanonicalDatabase } from '../../src/data/storage/indexeddb.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('waits for hosted canonical dependencies before publishing a mixed GitHub query', async () => {
  vi.resetModules();
  await deleteCanonicalDatabase(indexedDB);
  /** @type {((event: { data: Record<string, unknown> }) => void) | undefined} */
  let onMessage;
  const postMessage = vi.fn();
  vi.stubGlobal('self', {
    addEventListener: (/** @type {string} */ _type, /** @type {typeof onMessage} */ listener) => { onMessage = listener; },
    postMessage
  });
  const fetch = vi.fn(async () => Response.json({ full_name: 'githubnext/gh-aw-cao', stargazers_count: 42 }));
  vi.stubGlobal('fetch', fetch);
  await import('../../src/data-worker.js');
  const subscriptionId = 'hosted-readiness';
  onMessage?.({ data: {
    operation: 'subscribe-canonical-dashboard', subscriptionId,
    sourceNames: ['joined'], hostedSources: {},
    githubConfiguration: { baseUrl: 'https://dashboard.example/api/v1/github/' },
    context: {
      pages: [], dashboardRepository: 'githubnext/gh-aw-cao',
      queries: [{
        name: 'joined', from: 'repositories',
        joins: [{
          source: 'github-repository', on: [{ left: 'repository', right: 'full_name' }],
          fields: [{ field: 'stargazers_count', as: 'stars' }]
        }],
        select: [{ field: 'repository' }, { field: 'stars' }]
      }]
    }
  } });
  try {
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(postMessage.mock.calls.filter(([message]) => message.subscriptionId === subscriptionId)).toEqual([]);
    onMessage?.({ data: {
      operation: 'update-github-dashboard-sources', subscriptionId,
      sources: {
        repositories: {
          source: 'repositories', rows: [{ repository: 'githubnext/gh-aw-cao' }],
          metadata: {
            'source-id': 'repositories', 'source-kind': 'database', 'as-of': '', 'retrieved-at': '',
            availability: 'available', completeness: 'complete', freshness: 'fresh'
          }
        }
      }
    } });
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      subscriptionId,
      data: expect.objectContaining({
        joined: expect.objectContaining({ rows: [{ repository: 'githubnext/gh-aw-cao', stars: 42 }] })
      })
    })));
  } finally {
    onMessage?.({ data: { operation: 'unsubscribe-canonical-dashboard', subscriptionId } });
  }
});
