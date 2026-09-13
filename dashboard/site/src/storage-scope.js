const SOURCE_PATH_SEGMENT = '/src/';

/**
 * Resolve the deployment path shared by the page and its data worker.
 * @returns {string}
 */
export function dashboardPagePath() {
  const documentPath = globalThis.document?.location?.pathname;
  if (typeof documentPath === 'string' && documentPath) return documentPath;

  const moduleUrl = new URL(import.meta.url);
  const sourceIndex = moduleUrl.protocol.startsWith('http')
    ? moduleUrl.pathname.lastIndexOf(SOURCE_PATH_SEGMENT)
    : -1;
  if (sourceIndex >= 0) return moduleUrl.pathname.slice(0, sourceIndex + 1);
  return '/';
}

/**
 * @param {string} key
 * @param {string} [pathname]
 */
export function scopedStorageKey(key, pathname = dashboardPagePath()) {
  return pathname === '/' ? key : `${key}:${encodeURIComponent(pathname)}`;
}

/**
 * Remove local settings belonging to the current dashboard deployment.
 * @param {Storage} storage
 * @param {string} [pathname]
 */
export function clearScopedStorage(storage, pathname = dashboardPagePath()) {
  const suffix = pathname === '/' ? '' : `:${encodeURIComponent(pathname)}`;
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    const appKey = key?.startsWith('central-agentic-ops.dashboard.') === true;
    const inScope = pathname === '/' ? !key?.includes(':') : key?.endsWith(suffix);
    if (appKey && inScope) {
      storage.removeItem(key);
    }
  }
}
