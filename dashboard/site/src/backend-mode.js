/** @param {Document} [document] */
export function usesRemoteDataBackend(document = globalThis.document) {
  return document?.querySelector?.('meta[name="dashboard-data-backend"]')?.getAttribute("content") === "server-http";
}

/**
 * Removes static-dashboard PWA state before server-backed startup.
 * @param {{ serviceWorkers?: ServiceWorkerContainer, cacheStorage?: CacheStorage }} [dependencies]
 */
export async function disableRemoteDashboardPwa(dependencies = {}) {
  const serviceWorkers = dependencies.serviceWorkers ?? globalThis.navigator?.serviceWorker;
  const cacheStorage = dependencies.cacheStorage ?? globalThis.caches;
  const registrations = await serviceWorkers?.getRegistrations?.().catch(() => []) ?? [];
  await Promise.allSettled(registrations.map((registration) => registration.unregister()));
  const keys = await cacheStorage?.keys?.().catch(() => []) ?? [];
  await Promise.allSettled(keys
    .filter((key) => key.startsWith("central-agentic-ops-dashboard-"))
    .map((key) => cacheStorage.delete(key)));
}
