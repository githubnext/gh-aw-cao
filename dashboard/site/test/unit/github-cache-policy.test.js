// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGitHubDataService } from '../../src/data/github-service.js';
import { deleteCanonicalDatabase, readTransactions } from '../../src/data/storage/indexeddb.js';

/** @type {AbortController[]} */
let controllers = [];
beforeEach(async () => {
  controllers = [];
  await deleteCanonicalDatabase(indexedDB);
});
afterEach(() => {
  for (const controller of controllers) controller.abort();
});

/** @param {ReturnType<typeof createGitHubDataService>} service */
function subscribe(service) {
  const controller = new AbortController();
  controllers.push(controller);
  const listener = vi.fn();
  service.subscribe({ owner: 'githubnext', repo: 'gh-cao' }, {
    baseUrl: 'https://dashboard.example/api/v1/github/',
    cacheIdentity: 'test-principal:cache-policy-session'
  }, listener, { signal: controller.signal });
  return { controller, listener };
}

const data = { full_name: 'githubnext/gh-cao', stargazers_count: 42 };

it('subtracts backend Age instead of granting a fresh cache-hit lifetime', async () => {
  const now = Date.now();
  const fetch = vi.fn(async () => Response.json(data, { headers: {
    ETag: '"v1"', Age: '299', 'Cache-Control': 'private, max-age=300, stale-while-revalidate=86400'
  } }));
  const { listener } = subscribe(createGitHubDataService({ fetch, now: () => now }));
  await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(expect.objectContaining({ source: 'network' })));
  const [receipt] = await readTransactions(indexedDB);
  expect(receipt.freshUntil).toBe(now + 1000);
  expect(receipt.staleUntil).toBe(now + 86_401_000);
});

it('honors Retry-After on stale 200 responses without extending the original retention deadline', async () => {
  let now = Date.now();
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json(data, { headers: {
      ETag: '"v1"', 'Cache-Control': 'private, max-age=300, stale-while-revalidate=86400'
    } }))
    .mockResolvedValueOnce(Response.json(data, { headers: {
      ETag: '"v1"', Age: '301', Warning: '110 - "Response is stale"',
      'Cache-Control': 'private, max-age=0, stale-while-revalidate=86400', 'Retry-After': '120'
    } }));
  const first = subscribe(createGitHubDataService({ fetch, now: () => now }));
  await vi.waitFor(() => expect(first.listener).toHaveBeenCalledWith(expect.objectContaining({ source: 'network' })));
  const [original] = await readTransactions(indexedDB);
  first.controller.abort();
  now += 301_000;
  const second = subscribe(createGitHubDataService({ fetch, now: () => now }));
  await vi.waitFor(() => expect(second.listener).toHaveBeenLastCalledWith(expect.objectContaining({
    source: 'network', status: 'stale', retryAt: now + 120_000
  })));
  expect(second.listener.mock.calls[0]?.[0]).toMatchObject({ source: 'cache', status: 'stale', data });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({ 'If-None-Match': '"v1"' });
  const receipts = await readTransactions(indexedDB);
  expect(receipts).toHaveLength(1);
  const [updated] = receipts;
  expect(updated.id).toBe(original.id);
  expect(updated.freshUntil).toBe(now);
  expect(updated.staleUntil).toBeLessThanOrEqual(original.staleUntil);
});
