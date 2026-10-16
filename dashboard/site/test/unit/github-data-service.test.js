// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGitHubDataService, githubResourcePath } from '../../src/data/github-service.js';
import { deleteCanonicalDatabase, readTransactions, readCollection } from '../../src/data/storage/indexeddb.js';

const resource = { owner: 'githubnext', repo: 'gh-aw-cao' };
const configuration = { baseUrl: 'https://dashboard.example/api/v1/github/', cacheIdentity: 'test-principal:session-one' };
const repository = { full_name: 'githubnext/gh-aw-cao', description: 'Catalog', stargazers_count: 42 };
/** @type {AbortController[]} */
let controllers = [];

/** @param {ReturnType<typeof createGitHubDataService>} service @param {import('../../src/data/github-service.js').GitHubBackendConfiguration} [config] @param {import('../../src/data/github-service.js').GitHubResource} [target] */
function subscribe(service, config = configuration, target = resource) {
  const controller = new AbortController();
  controllers.push(controller);
  const listener = vi.fn();
  const stop = service.subscribe(target, config, listener, { signal: controller.signal });
  return { controller, listener, stop };
}

/** @param {unknown} [data] @param {string} [etag] */
function response(data = repository, etag = '"v1"') {
  return Response.json(data, { headers: { ETag: etag, 'Cache-Control': 'private, max-age=300, stale-while-revalidate=86400' } });
}

beforeEach(async () => {
  controllers = [];
  await deleteCanonicalDatabase(indexedDB);
});
afterEach(() => {
  for (const controller of controllers) controller.abort();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('worker GitHub resource service', () => {
  it('reports IndexedDB read failures without fetching or using a memory-only fallback', async () => {
    vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new Error('private database detail'); });
    const fetch = vi.fn(async () => response());
    const { listener } = subscribe(createGitHubDataService({ fetch }));
    await vi.waitFor(() => expect(listener).toHaveBeenLastCalledWith({
      data: null, status: 'unavailable', source: 'none', error: 'storage-unavailable', retryAt: null
    }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not publish a successful network result when IndexedDB persistence fails', async () => {
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => { throw new Error('private write detail'); });
    const fetch = vi.fn(async () => response());
    const { listener } = subscribe(createGitHubDataService({ fetch }));
    await vi.waitFor(() => expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({
      data: null, status: 'unavailable', source: 'none', error: 'storage-unavailable'
    })));
    expect(listener).not.toHaveBeenCalledWith(expect.objectContaining({ source: 'network' }));
  });

  it('only calls the configured backend and persists normalized ancillary receipts, not entities or credentials', async () => {
    const fetch = vi.fn(/** @type {typeof globalThis.fetch} */ (async () => response({ ...repository, secret_field: 'discard' })));
    const { listener } = subscribe(createGitHubDataService({ fetch }));
    await vi.waitFor(() => expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'network', status: 'available' })));
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://dashboard.example/api/v1/github/repos/githubnext/gh-aw-cao');
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ credentials: 'same-origin' });
    expect(fetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty('Authorization');
    const receipts = await readTransactions(indexedDB);
    expect(receipts).toHaveLength(1);
    expect(JSON.stringify(receipts)).not.toContain('Authorization');
    expect(JSON.stringify(receipts)).not.toContain('secret_field');
    expect(await readCollection(indexedDB, 'repositories')).toEqual([]);
  });

  it('serves a fresh persistent cached result without another request, including after worker recreation', async () => {
    const fetch = vi.fn(async () => response());
    const first = subscribe(createGitHubDataService({ fetch }));
    await vi.waitFor(() => expect(first.listener).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'network' })));
    first.stop();
    const second = subscribe(createGitHubDataService({ fetch }));
    await vi.waitFor(() => expect(second.listener).toHaveBeenCalledWith(expect.objectContaining({ source: 'cache', data: repository })));
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('emits stale cache first, conditionally revalidates a 304, then publishes changed data', async () => {
    let now = Date.now();
    const fetch = vi.fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(new Response(null, { status: 304, headers: { ETag: '"v1"' } }))
      .mockResolvedValueOnce(response({ ...repository, stargazers_count: 43 }, '"v2"'));
    const first = subscribe(createGitHubDataService({ fetch, now: () => now }));
    await vi.waitFor(() => expect(first.listener).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'network' })));
    first.stop();
    now += 300_001;
    const second = subscribe(createGitHubDataService({ fetch, now: () => now }));
    await vi.waitFor(() => expect(second.listener).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'network', status: 'available', data: repository })));
    expect(second.listener.mock.calls[0]?.[0]).toMatchObject({ source: 'cache', status: 'stale', data: repository });
    expect(fetch.mock.calls[1]?.[1].headers).toMatchObject({ 'If-None-Match': '"v1"' });
    second.stop();
    now += 300_001;
    const third = subscribe(createGitHubDataService({ fetch, now: () => now }));
    await vi.waitFor(() => expect(third.listener).toHaveBeenLastCalledWith(expect.objectContaining({
      source: 'network', data: { ...repository, stargazers_count: 43 }
    })));
  });

  it('deduplicates concurrent subscribers and only aborts the request after the final subscriber leaves', async () => {
    /** @type {AbortSignal | undefined} */
    let requestSignal;
    const fetch = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      requestSignal = init.signal;
      init.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')));
    }));
    const service = createGitHubDataService({ fetch });
    const first = subscribe(service);
    const second = subscribe(service);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    first.controller.abort();
    expect(requestSignal?.aborted).toBe(false);
    second.stop();
    expect(requestSignal?.aborted).toBe(true);
    const count = second.listener.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(second.listener).toHaveBeenCalledTimes(count);
  });

  it('does not start work for an already aborted lifetime or publish after immediate cleanup', async () => {
    const fetch = vi.fn(async () => response());
    const service = createGitHubDataService({ fetch });
    const controller = new AbortController();
    controller.abort();
    const listener = vi.fn();
    service.subscribe(resource, configuration, listener, { signal: controller.signal });
    const active = subscribe(service);
    active.stop();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetch).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(active.listener).not.toHaveBeenCalled();
  });

  it('isolates duplicate callback lifetimes and makes cleanup idempotent across replacement subscriptions', async () => {
    const fetch = vi.fn().mockResolvedValue(response());
    const service = createGitHubDataService({ fetch });
    const first = subscribe(service);
    await vi.waitFor(() => expect(first.listener).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'network' })));
    first.stop();
    const second = subscribe(service);
    first.stop();
    const controller = new AbortController();
    controllers.push(controller);
    const stop = service.subscribe(resource, configuration, second.listener, { signal: controller.signal });
    await vi.waitFor(() => expect(second.listener).toHaveBeenCalledWith(expect.objectContaining({ source: 'cache' })));
    second.stop();
    const third = subscribe(service);
    await vi.waitFor(() => expect(third.listener).toHaveBeenCalledWith(expect.objectContaining({ source: 'cache' })));
    stop();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('does not call a backend in unconfigured Pages mode', async () => {
    const fetch = vi.fn();
    const { listener } = subscribe(createGitHubDataService({ fetch }), { baseUrl: null });
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith({
      data: null, status: 'unavailable', source: 'none', error: 'backend-unconfigured', retryAt: null
    }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('retains stale data offline and retries with bounded exponential backoff', async () => {
    let now = Date.now();
    const fetch = vi.fn().mockResolvedValueOnce(response()).mockRejectedValue(new TypeError('offline'));
    const first = subscribe(createGitHubDataService({ fetch, now: () => now }));
    await vi.waitFor(() => expect(first.listener).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'network' })));
    first.stop();
    now += 300_001;
    const second = subscribe(createGitHubDataService({ fetch, now: () => now }));
    await vi.waitFor(() => expect(second.listener).toHaveBeenLastCalledWith(expect.objectContaining({
      data: repository, status: 'stale', error: 'unavailable', retryAt: now + 1000
    })));
  });

  it('does not expose cached data to another credential or beyond the stale window', async () => {
    let now = Date.now();
    const fetch = vi.fn().mockResolvedValueOnce(response()).mockRejectedValue(new Error('offline'));
    const first = subscribe(createGitHubDataService({ fetch, now: () => now }));
    await vi.waitFor(() => expect(first.listener).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'network' })));
    first.stop();
    const second = subscribe(createGitHubDataService({ fetch, now: () => now }), { ...configuration, cacheIdentity: 'test-principal:session-two' });
    await vi.waitFor(() => expect(second.listener).toHaveBeenLastCalledWith(expect.objectContaining({ data: null, status: 'unavailable', error: 'unavailable' })));
    second.stop();
    now += 86_700_001;
    const third = subscribe(createGitHubDataService({ fetch, now: () => now }));
    await vi.waitFor(() => expect(third.listener).toHaveBeenLastCalledWith(expect.objectContaining({ data: null, status: 'unavailable', error: 'unavailable' })));
  });

  it('honors Retry-After globally and cancels retry timers when subscriptions end', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 429, headers: { 'Retry-After': '60' } }));
    const service = createGitHubDataService({ fetch });
    const first = subscribe(service);
    await vi.waitFor(() => expect(first.listener).toHaveBeenLastCalledWith(expect.objectContaining({ error: 'http-429', retryAt: expect.any(Number) })));
    expect(first.listener.mock.lastCall?.[0].retryAt).toBeGreaterThan(Date.now() + 59_000);
    first.stop();
    const second = subscribe(service, configuration, { ...resource, resource: 'latest-release' });
    await vi.waitFor(() => expect(second.listener).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(fetch).toHaveBeenCalledOnce();
    second.controller.abort();
  });

  it('times out stalled requests and reports retryable unavailability', async () => {
    const fetch = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')));
    }));
    const { listener } = subscribe(createGitHubDataService({ fetch, timeoutMs: 5 }));
    await vi.waitFor(() => expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ error: 'unavailable', retryAt: expect.any(Number) })));
  });

  it('refreshes active subscriptions when freshness expires and cancels future refreshes on cleanup', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const fetch = vi.fn().mockResolvedValueOnce(response()).mockResolvedValue(response({ ...repository, stargazers_count: 100 }));
    const active = subscribe(createGitHubDataService({ fetch }));
    await vi.waitFor(() => expect(active.listener).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'network' })));
    await vi.advanceTimersByTimeAsync(300_001);
    await vi.waitFor(() => expect(active.listener).toHaveBeenLastCalledWith(expect.objectContaining({ data: { ...repository, stargazers_count: 100 } })));
    expect(fetch).toHaveBeenCalledTimes(2);
    active.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('backs off retries and recovers an active subscription after an extended outage', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const fetch = vi.fn().mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(response());
    const active = subscribe(createGitHubDataService({ fetch }));
    await vi.waitFor(() => expect(active.listener).toHaveBeenLastCalledWith(expect.objectContaining({ error: 'unavailable' })));
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(4000);
    expect(fetch).toHaveBeenCalledTimes(4);
    const retryAt = active.listener.mock.lastCall?.[0].retryAt ?? Date.now();
    await vi.advanceTimersByTimeAsync(retryAt - Date.now() - 1);
    expect(fetch).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(active.listener).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'network', data: repository })));
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it('drops stale data at its expiry even while a server cooldown delays revalidation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(repository, {
      headers: { ETag: '"v1"', 'Cache-Control': 'private, max-age=0, stale-while-revalidate=1' }
    })).mockResolvedValue(new Response(null, { status: 429, headers: { 'Retry-After': '60' } }));
    const active = subscribe(createGitHubDataService({ fetch }));
    await vi.waitFor(() => expect(active.listener).toHaveBeenLastCalledWith(expect.objectContaining({ data: repository, source: 'network' })));
    await vi.advanceTimersByTimeAsync(1001);
    expect(active.listener).toHaveBeenLastCalledWith(expect.objectContaining({ data: null, status: 'unavailable' }));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('honors HTTP-date Retry-After, avoids retrying 404s, and validates response shapes', async () => {
    const date = new Date(Date.now() + 60_000).toUTCString();
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503, headers: { 'Retry-After': date } }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(response({ ...repository, stargazers_count: {} }));
    const first = subscribe(createGitHubDataService({ fetch }));
    await vi.waitFor(() => expect(first.listener).toHaveBeenLastCalledWith(expect.objectContaining({ error: 'http-503', retryAt: Date.parse(date) })));
    first.stop();
    const second = subscribe(createGitHubDataService({ fetch }));
    await vi.waitFor(() => expect(second.listener).toHaveBeenLastCalledWith(expect.objectContaining({ error: 'http-404', retryAt: null })));
    second.stop();
    const third = subscribe(createGitHubDataService({ fetch }));
    await vi.waitFor(() => expect(third.listener).toHaveBeenLastCalledWith(expect.objectContaining({ data: null, error: 'unavailable' })));
  });

  it('supports safe normalized latest releases and refuses direct GitHub URLs and invalid resource paths', async () => {
    const fetch = vi.fn(/** @type {typeof globalThis.fetch} */ (async () => response({ tag_name: 'v1', name: 'Release', body: 'not retained', draft: false })));
    const service = createGitHubDataService({ fetch });
    const { listener } = subscribe(service, configuration, { ...resource, resource: 'latest-release' });
    await vi.waitFor(() => expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ data: { tag_name: 'v1', name: 'Release', draft: false } })));
    expect(String(fetch.mock.calls[0]?.[0])).toMatch(/\/releases\/latest$/);
    expect(() => subscribe(service, { baseUrl: 'https://api.github.com/' })).toThrow(/backend URL/);
    expect(() => githubResourcePath({ owner: 'a/b', repo: 'test' })).toThrow();
    expect(() => githubResourcePath({ owner: 'test', repo: '..' })).toThrow();
  });

  it('keys persistent receipts only by backend and opaque principal/session scope, not credential material', async () => {
    const fetch = vi.fn(async () => response());
    const active = subscribe(createGitHubDataService({ fetch }));
    await vi.waitFor(() => expect(active.listener).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'network' })));
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([
      configuration.baseUrl, 'omit', configuration.cacheIdentity
    ])));
    const partition = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    expect((await readTransactions(indexedDB))[0]?.id).toBe(`github-resource:${partition}:repos/githubnext/gh-aw-cao`);
  });

  it('clears active private results on logout and cannot reuse them under a new session or backend', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ ...repository, visibility: 'private' }))
      .mockRejectedValue(new Error('offline'));
    const service = createGitHubDataService({ fetch });
    const first = subscribe(service);
    await vi.waitFor(() => expect(first.listener).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'network' })));
    service.invalidateAuthentication();
    expect(first.listener).toHaveBeenLastCalledWith({
      data: null, status: 'unavailable', source: 'none', error: 'authentication-changed', retryAt: null
    });
    const second = subscribe(service, { ...configuration, cacheIdentity: 'another-principal:another-session' });
    await vi.waitFor(() => expect(second.listener).toHaveBeenLastCalledWith(expect.objectContaining({ data: null, error: 'unavailable' })));
    const third = subscribe(service, { ...configuration, baseUrl: 'https://another-dashboard.example/api/v1/github/' });
    await vi.waitFor(() => expect(third.listener).toHaveBeenLastCalledWith(expect.objectContaining({ data: null, error: 'unavailable' })));
  });

  it('removes cached private data after an authoritative permission denial and never resurrects it offline', async () => {
    let now = Date.now();
    const fetch = vi.fn().mockResolvedValueOnce(response({ ...repository, visibility: 'private' }))
      .mockResolvedValueOnce(new Response(null, { status: 403 })).mockRejectedValue(new Error('offline'));
    const first = subscribe(createGitHubDataService({ fetch, now: () => now }));
    await vi.waitFor(() => expect(first.listener).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'network' })));
    first.stop();
    now += 300_001;
    const denied = subscribe(createGitHubDataService({ fetch, now: () => now }));
    await vi.waitFor(() => expect(denied.listener).toHaveBeenLastCalledWith(expect.objectContaining({ data: null, status: 'unavailable', error: 'http-403' })));
    denied.stop();
    const offline = subscribe(createGitHubDataService({ fetch, now: () => now }));
    await vi.waitFor(() => expect(offline.listener).toHaveBeenLastCalledWith(expect.objectContaining({ data: null, error: 'unavailable' })));
  });

  it('subtracts Age from 304 freshness and honors stale Warning plus Retry-After without extending stale retention', async () => {
    let now = Date.now();
    const fetch = vi.fn().mockResolvedValueOnce(response())
      .mockResolvedValueOnce(new Response(null, { status: 304, headers: {
        Age: '100', 'Cache-Control': 'private, max-age=300, stale-while-revalidate=86400'
      } }))
      .mockResolvedValueOnce(Response.json(repository, { headers: {
        Age: '600', Warning: '110 - "Response is stale"', 'Retry-After': '60',
        'Cache-Control': 'private, max-age=0, stale-while-revalidate=86400'
      } }));
    const first = subscribe(createGitHubDataService({ fetch, now: () => now }));
    await vi.waitFor(() => expect(first.listener).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'network' })));
    first.stop();
    now += 300_001;
    const validated = subscribe(createGitHubDataService({ fetch, now: () => now }));
    await vi.waitFor(() => expect(validated.listener).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'network', status: 'available' })));
    const receipt = (await readTransactions(indexedDB))[0];
    expect(receipt?.freshUntil).toBe(now + 200_000);
    expect(receipt?.staleUntil).toBe(now + 86_600_000);
    validated.stop();
    now += 200_001;
    const stale = subscribe(createGitHubDataService({ fetch, now: () => now }));
    await vi.waitFor(() => expect(stale.listener).toHaveBeenLastCalledWith(expect.objectContaining({
      data: repository, status: 'stale', error: 'stale-response', retryAt: now + 60_000
    })));
    const staleReceipt = (await readTransactions(indexedDB))[0];
    expect(staleReceipt?.freshUntil).toBe(now);
    expect(Number(staleReceipt?.staleUntil)).toBeLessThanOrEqual(Number(receipt?.staleUntil));
  });
});
