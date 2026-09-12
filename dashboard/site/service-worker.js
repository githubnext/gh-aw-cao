const VERSION = '1';
const DATA_CACHE = `central-agentic-ops-dashboard-data-${VERSION}`;
const CONFIG_CACHE = 'central-agentic-ops-dashboard-config';
const CONFIG_URL = new URL('./.dashboard-data-update-config', self.registration.scope).href;
const PERIODIC_SYNC_TAG = 'central-agentic-ops-dashboard-data';
const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;
const DATA_FILES = new Set(['gh-aw-logs.jsonl', 'inventory-sources.json']);

function isDashboardDataUrl(value) {
  try {
    const url = new URL(value, self.location.href);
    return url.origin === self.location.origin
      && DATA_FILES.has(url.pathname.split('/').at(-1));
  } catch {
    return false;
  }
}

async function downloadData(urls) {
  const requested = [...new Set(urls)].filter(isDashboardDataUrl);
  if (!requested.some((url) => new URL(url).pathname.endsWith('/gh-aw-logs.jsonl'))) {
    throw new Error('Dashboard data URL is missing.');
  }
  const responses = await Promise.all(requested.map(async (url) => {
    const response = await fetch(url, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    });
    const optionalInventory = new URL(url).pathname.endsWith('/inventory-sources.json');
    if (!response.ok && !(optionalInventory && response.status === 404)) {
      throw new Error(`Dashboard data download returned ${response.status}.`);
    }
    return { url, response, optionalInventory };
  }));
  const cache = await caches.open(DATA_CACHE);
  await Promise.all(responses.map(({ url, response, optionalInventory }) => (
    optionalInventory && response.status === 404
      ? cache.delete(url)
      : cache.put(url, response.clone())
  )));
}

async function storeDataUrls(urls) {
  const requested = [...new Set(urls)].filter(isDashboardDataUrl);
  if (!requested.some((url) => new URL(url).pathname.endsWith('/gh-aw-logs.jsonl'))) {
    throw new Error('Dashboard data URL is missing.');
  }
  const cache = await caches.open(CONFIG_CACHE);
  await cache.put(CONFIG_URL, new Response(JSON.stringify(requested), {
    headers: { 'content-type': 'application/json' }
  }));
}

async function downloadConfiguredData() {
  const connection = self.navigator?.connection;
  if (connection?.saveData || connection?.metered || connection?.type === 'cellular') return;
  if (typeof self.navigator?.getBattery === 'function') {
    const battery = await self.navigator.getBattery();
    if (!battery.charging && battery.level <= 0.2) return;
  }
  const cache = await caches.open(CONFIG_CACHE);
  const response = await cache.match(CONFIG_URL);
  if (!response) return;
  const urls = await response.json();
  if (Array.isArray(urls)) await downloadData(urls);
}

self.addEventListener('install', () => {
  // Updated workers wait until the page canaries them before activation.
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith('central-agentic-ops-dashboard-data-') && key !== DATA_CACHE)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || !isDashboardDataUrl(event.request.url)) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      if (response.ok) {
        const cache = await caches.open(DATA_CACHE);
        await cache.put(event.request, response.clone());
      }
      return response;
    } catch (error) {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      throw error;
    }
  })());
});

self.addEventListener('periodicsync', (event) => {
  if (event.tag !== PERIODIC_SYNC_TAG) return;
  event.waitUntil(downloadConfiguredData());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'CANARY') {
    event.ports[0]?.postMessage({ type: 'CANARY_OK', version: VERSION });
    return;
  }
  if (event.data?.type === 'ACTIVATE') {
    void self.skipWaiting();
    return;
  }
  if (event.data?.type === 'CONFIGURE_BACKGROUND_DATA' && Array.isArray(event.data.urls)) {
    const task = storeDataUrls(event.data.urls).then(
      () => event.ports[0]?.postMessage({ type: 'BACKGROUND_DATA_CONFIGURED', version: VERSION }),
      (error) => event.ports[0]?.postMessage({
        type: 'BACKGROUND_DATA_CONFIGURATION_FAILED',
        message: error instanceof Error ? error.message : String(error)
      })
    );
    event.waitUntil(task);
    return;
  }
  if (event.data?.type !== 'DOWNLOAD_DATA' || !Array.isArray(event.data.urls)) return;
  const task = downloadData(event.data.urls).then(
    () => event.ports[0]?.postMessage({ type: 'DOWNLOAD_COMPLETE', version: VERSION }),
    (error) => event.ports[0]?.postMessage({
      type: 'DOWNLOAD_FAILED',
      message: error instanceof Error ? error.message : String(error)
    })
  );
  event.waitUntil(task);
});
