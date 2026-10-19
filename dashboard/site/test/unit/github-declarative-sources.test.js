// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deleteCanonicalDatabase } from '../../src/data/storage/indexeddb.js';
import { QUERY_SOURCE_FIELDS } from '../../src/specification.js';

const context = {
  pages: [], dashboardRepository: 'githubnext/gh-cao',
  queries: [{
    name: 'repository-summary', from: 'github-repository',
    select: [
      { field: 'full_name', as: 'repository' },
      { field: 'stargazers_count', as: 'stars' }
    ]
  }]
};
const githubConfiguration = { baseUrl: 'https://dashboard.example/api/v1/github/' };

/** @param {Parameters<typeof import('../../src/data-worker.js').processDataRequest>[0]} request */
async function queryWorker(request) {
  const { processDataRequest } = await import('../../src/data-worker.js');
  return /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (await processDataRequest(request));
}

beforeEach(async () => {
  vi.resetModules();
  await deleteCanonicalDatabase(indexedDB);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('registers GitHub source schemas and executes projection through the production canonical worker query boundary', async () => {
  expect(QUERY_SOURCE_FIELDS['github-repository']).toContain('stargazers_count');
  expect(QUERY_SOURCE_FIELDS['github-latest-release']).toContain('tag_name');
  const fetch = vi.fn(async () => Response.json({ full_name: 'githubnext/gh-cao', stargazers_count: 42 }));
  vi.stubGlobal('fetch', fetch);
  const result = await queryWorker({
    operation: 'query-canonical-dashboard', sourceNames: ['repository-summary'], context, githubConfiguration
  });
  expect(result['repository-summary'].rows).toEqual([{ repository: 'githubnext/gh-cao', stars: 42 }]);
  expect(fetch).toHaveBeenCalledOnce();
  const cached = await queryWorker({
    operation: 'query-canonical-dashboard', sourceNames: ['repository-summary'], context, githubConfiguration
  });
  expect(cached['repository-summary'].rows).toEqual(result['repository-summary'].rows);
  expect(fetch).toHaveBeenCalledOnce();
});

it('fails closed without a configured backend or repository instead of synthesizing rows', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const result = await queryWorker({
    operation: 'query-canonical-dashboard', sourceNames: ['repository-summary'], context
  });
  expect(result['repository-summary'].rows).toEqual([]);
  expect(result['repository-summary'].metadata.availability).toBe('unavailable');
  const missing = await queryWorker({
    operation: 'query-canonical-dashboard', sourceNames: ['github-repository'],
    context: { pages: [] }, githubConfiguration
  });
  expect(missing['github-repository'].rows).toEqual([]);
  expect(missing['github-repository'].metadata.availability).toBe('unavailable');
  expect(fetch).not.toHaveBeenCalled();
});

it('joins hosted canonical inputs with the resource in the worker declarative engine, not JavaScript business code', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ full_name: 'githubnext/gh-cao', stargazers_count: 42 })));
  const result = await queryWorker({
    operation: 'query-canonical-dashboard', sourceNames: ['joined'], githubConfiguration,
    context: {
      ...context,
      queries: [{
        name: 'joined', from: 'repositories',
        joins: [{
          source: 'github-repository', on: [{ left: 'repository', right: 'full_name' }],
          fields: [{ field: 'stargazers_count', as: 'stars' }]
        }],
        select: [{ field: 'repository' }, { field: 'stars' }]
      }]
    },
    hostedSources: {
      repositories: {
        source: 'repositories', rows: [{ repository: 'githubnext/gh-cao' }],
        metadata: {
          'source-id': 'repositories', 'source-kind': 'database', 'as-of': '', 'retrieved-at': '',
          availability: 'available', completeness: 'complete', freshness: 'fresh'
        }
      }
    }
  });
  expect(result.joined.rows).toEqual([{ repository: 'githubnext/gh-cao', stars: 42 }]);
});

it('keeps declared view subscriptions reactive to network refresh and aborts resource ownership on unsubscribe', async () => {
  /** @type {((event: { data: Record<string, unknown> }) => void) | undefined} */
  let onMessage;
  const postMessage = vi.fn();
  vi.stubGlobal('self', {
    addEventListener: (/** @type {string} */ _type, /** @type {(event: { data: Record<string, unknown> }) => void} */ listener) => { onMessage = listener; },
    postMessage
  });
  /** @type {(response: Response) => void} */
  let complete = () => {};
  /** @type {AbortSignal | undefined} */
  let requestSignal;
  vi.stubGlobal('fetch', vi.fn((_url, init) => {
    requestSignal = init.signal;
    return new Promise((resolve) => { complete = resolve; });
  }));
  await import('../../src/data-worker.js');
  onMessage?.({ data: {
    operation: 'subscribe-canonical-dashboard', subscriptionId: 'github-view',
    sourceNames: ['repository-summary'], context, githubConfiguration, hostedSources: {}
  } });
  await vi.waitFor(() => expect(requestSignal).toBeDefined());
  complete(Response.json({ full_name: 'githubnext/gh-cao', stargazers_count: 42 }));
  await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
    subscriptionId: 'github-view',
    data: expect.objectContaining({
      'repository-summary': expect.objectContaining({ rows: [{ repository: 'githubnext/gh-cao', stars: 42 }] })
    })
  })));
  onMessage?.({ data: { operation: 'unsubscribe-canonical-dashboard', subscriptionId: 'github-view' } });
  const count = postMessage.mock.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(postMessage).toHaveBeenCalledTimes(count);
});
