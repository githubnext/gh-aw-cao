/**
 * @typedef {'static'|'hosted'} DashboardDataBackend
 */

/** @param {Document} [document] @returns {DashboardDataBackend} */
export function dashboardDataBackend(document = globalThis.document) {
  return document?.querySelector?.('meta[name="dashboard-data-backend"]')?.getAttribute('content') === 'server-http'
    ? 'hosted'
    : 'static';
}

/** @param {unknown} view @param {DashboardDataBackend} backend */
export function viewBackendAvailable(view, backend) {
  if (typeof view !== 'object' || view === null || Array.isArray(view)) return true;
  const requirement = /** @type {Record<string, unknown>} */ (view).requires;
  if (requirement === undefined) return true;
  if (typeof requirement !== 'object' || requirement === null || Array.isArray(requirement)) return false;
  return /** @type {Record<string, unknown>} */ (requirement).backend === backend;
}

/** @param {unknown} view @param {DashboardDataBackend} backend @returns {string | undefined} */
export function viewBackendUnavailableMessage(view, backend) {
  if (viewBackendAvailable(view, backend)) return undefined;
  const requirement = /** @type {{ requires?: { message?: unknown } }} */ (view)?.requires;
  return typeof requirement?.message === 'string' && requirement.message.trim()
    ? requirement.message
    : 'This view is unavailable on the current dashboard backend.';
}
