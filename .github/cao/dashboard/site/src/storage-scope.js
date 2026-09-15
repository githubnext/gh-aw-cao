const SOURCE_PATH_SEGMENT = '/src/';

/**
 * Resolve the deployment path shared by the page and its data worker.
 * @param {string} [moduleHref]
 * @param {string | undefined} [documentPath]
 * @returns {string}
 */
export function dashboardPagePath(
  moduleHref = import.meta.url,
  documentPath = globalThis.document?.location?.pathname
) {
  const moduleUrl = new URL(moduleHref);
  const sourceIndex = moduleUrl.protocol.startsWith('http')
    ? moduleUrl.pathname.lastIndexOf(SOURCE_PATH_SEGMENT)
    : -1;
  if (sourceIndex >= 0) return moduleUrl.pathname.slice(0, sourceIndex + 1);
  if (typeof documentPath === 'string' && documentPath) return documentPath;
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
    // Root deployments retain the legacy unsuffixed keys; current base keys contain no colon.
    const inScope = pathname === '/' ? !key?.includes(':') : key?.endsWith(suffix);
    if (appKey && inScope) {
      storage.removeItem(key);
    }
  }
}
