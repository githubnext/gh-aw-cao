import { afterEach, expect, it, vi } from 'vitest';

class ResourceWorker {
  /** @type {ResourceWorker | undefined} */
  static current;
  /** @type {Map<string, (event: { data?: unknown, message?: string }) => void>} */
  listeners = new Map();
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { ResourceWorker.current = this; }
  /** @param {string} type @param {(event: { data?: unknown, message?: string }) => void} listener */
  addEventListener(type, listener) { this.listeners.set(type, listener); }
}

afterEach(() => {
  document.head.innerHTML = '';
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

it('uses worker transport even in hosted mode, passes backend auth, and cleans up abort-scoped subscriptions', async () => {
  vi.stubGlobal('Worker', ResourceWorker);
  document.head.innerHTML = '<meta name="dashboard-data-backend" content="server-http"><meta name="dashboard-api-base" content="https://dashboard.example/">';
  localStorage.setItem('cao-dashboard-access-token', 'dashboard-test-token');
  const { subscribeGitHubResource } = await import('../../src/data-processor.js');
  const controller = new AbortController();
  const notify = vi.fn();
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const stop = subscribeGitHubResource({ owner: 'githubnext', repo: 'gh-aw-cao' }, notify, { signal: controller.signal });
  const worker = ResourceWorker.current;
  const message = worker?.postMessage.mock.calls[0]?.[0];
  expect(message).toMatchObject({
    operation: 'subscribe-github-resource',
    configuration: { baseUrl: 'https://dashboard.example/api/v1/github/', token: 'dashboard-test-token', credentials: 'omit' }
  });
  const snapshot = { data: { full_name: 'githubnext/gh-aw-cao' }, status: 'available', source: 'cache', error: null, retryAt: null };
  worker?.listeners.get('message')?.({ data: { type: 'github-resource', subscriptionId: message.subscriptionId, snapshot } });
  expect(notify).toHaveBeenCalledWith(snapshot);
  controller.abort();
  stop();
  expect(worker?.postMessage).toHaveBeenCalledTimes(2);
  expect(worker?.postMessage).toHaveBeenLastCalledWith({ operation: 'unsubscribe-github-resource', subscriptionId: message.subscriptionId });
  worker?.listeners.get('message')?.({ data: { type: 'github-resource', subscriptionId: message.subscriptionId, snapshot } });
  expect(notify).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
});

it('leaves static Pages unconfigured and never attaches bearer credentials in OAuth mode', async () => {
  const { githubWorkerBackendConfiguration } = await import('../../src/remote-data-backend.js');
  expect(githubWorkerBackendConfiguration().baseUrl).toBeNull();
  document.head.innerHTML = '<meta name="dashboard-data-backend" content="server-http"><meta name="cao-auth-mode" content="github">';
  localStorage.setItem('cao-dashboard-access-token', 'unused-token');
  expect(githubWorkerBackendConfiguration()).toMatchObject({ credentials: 'same-origin', token: '' });
  expect(githubWorkerBackendConfiguration().cacheIdentity).toBe(githubWorkerBackendConfiguration().cacheIdentity);
});

it('reports worker failure and removes listeners, and does nothing for an already aborted signal', async () => {
  vi.stubGlobal('Worker', ResourceWorker);
  const { subscribeGitHubResource } = await import('../../src/data-processor.js');
  const controller = new AbortController();
  const onError = vi.fn();
  subscribeGitHubResource({ owner: 'a', repo: 'b' }, vi.fn(), { signal: controller.signal, onError });
  const worker = ResourceWorker.current;
  worker?.listeners.get('error')?.({ message: 'worker failed' });
  expect(onError).toHaveBeenCalledOnce();
  const count = worker?.postMessage.mock.calls.length;
  controller.abort();
  subscribeGitHubResource({ owner: 'a', repo: 'b' }, vi.fn(), { signal: controller.signal });
  expect(worker?.postMessage).toHaveBeenCalledTimes(count ?? 0);
  expect(worker?.terminate).toHaveBeenCalledOnce();
});

it('routes GitHub-only declarative page queries and subscriptions through the worker in hosted mode', async () => {
  vi.stubGlobal('Worker', ResourceWorker);
  document.head.innerHTML = '<meta name="dashboard-data-backend" content="server-http">';
  const remote = await import('../../src/remote-data-backend.js');
  const queryRemote = vi.spyOn(remote, 'queryRemoteDashboard');
  const { loadCanonicalDashboardPage, subscribeCanonicalDashboardView } = await import('../../src/data-processor.js');
  const context = {
    pages: [], dashboardRepository: 'githubnext/gh-aw-cao',
    queries: [{ name: 'stars', from: 'github-repository', select: [{ field: 'stargazers_count' }] }]
  };
  const loaded = loadCanonicalDashboardPage(['stars'], context);
  await vi.waitFor(() => expect(ResourceWorker.current?.postMessage).toHaveBeenCalled());
  const worker = ResourceWorker.current;
  const request = worker?.postMessage.mock.calls[0]?.[0];
  expect(request).toMatchObject({
    operation: 'query-canonical-dashboard', sourceNames: ['stars'], hostedSources: {},
    githubConfiguration: { baseUrl: expect.stringContaining('/api/v1/github/') }
  });
  worker?.listeners.get('message')?.({ data: { id: request.id, data: { stars: { rows: [{ stargazers_count: 42 }] } } } });
  await expect(loaded).resolves.toMatchObject({ stars: { rows: [{ stargazers_count: 42 }] } });
  const controller = new AbortController();
  subscribeCanonicalDashboardView('github-query', ['stars'], context, vi.fn(), undefined, { signal: controller.signal });
  expect(worker?.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
    operation: 'subscribe-canonical-dashboard', hostedSources: {}, githubConfiguration: expect.any(Object)
  }));
  expect(queryRemote).not.toHaveBeenCalled();
  controller.abort();
  worker?.listeners.get('error')?.({ message: 'cleanup' });
});

it('forwards only raw hosted inputs to the worker for mixed declarative queries and releases the revision subscription', async () => {
  vi.stubGlobal('Worker', ResourceWorker);
  document.head.innerHTML = '<meta name="dashboard-data-backend" content="server-http">';
  const remote = await import('../../src/remote-data-backend.js');
  const sources = { repositories: { rows: [{ repository: 'githubnext/gh-aw-cao' }] } };
  const queryRemote = vi.spyOn(remote, 'queryRemoteDashboard').mockResolvedValue({ sources, revision: 1, healthRevision: 1 });
  const stopRevision = vi.fn();
  vi.spyOn(remote, 'subscribeRemoteRevision').mockReturnValue(stopRevision);
  const { subscribeCanonicalDashboardView } = await import('../../src/data-processor.js');
  const controller = new AbortController();
  const context = {
    pages: [], dashboardRepository: 'githubnext/gh-aw-cao',
    queries: [{
      name: 'joined', from: 'repositories',
      joins: [{ source: 'github-repository', on: [{ left: 'repository', right: 'full_name' }], fields: [{ field: 'stargazers_count', as: 'stars' }] }]
    }]
  };
  subscribeCanonicalDashboardView('mixed-github', ['joined'], context, vi.fn(), undefined, { signal: controller.signal });
  await vi.waitFor(() => expect(ResourceWorker.current?.postMessage).toHaveBeenCalledWith({
    operation: 'update-github-dashboard-sources', subscriptionId: 'mixed-github', sources
  }));
  expect(queryRemote).toHaveBeenCalledWith(['repositories'], expect.objectContaining({ pages: [], queries: [] }), undefined, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  controller.abort();
  expect(stopRevision).toHaveBeenCalledOnce();
  ResourceWorker.current?.listeners.get('error')?.({ message: 'cleanup' });
});
