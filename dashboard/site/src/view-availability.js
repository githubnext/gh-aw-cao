import { createDebug } from './debug.js';

/**
 * @typedef {'static'|'hosted'} DashboardDataBackend
 */

const debugViewAvailability = createDebug('view-availability');

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
  if (typeof requirement !== 'object' || requirement === null || Array.isArray(requirement)) {
    debugViewAvailability({ event: 'malformed-requirement', backend });
    return false;
  }
  return /** @type {Record<string, unknown>} */ (requirement).backend === backend;
}

/** @param {unknown} view @param {DashboardDataBackend} backend @returns {string | undefined} */
export function viewBackendUnavailableMessage(view, backend) {
  if (viewBackendAvailable(view, backend)) return undefined;
  const requirement = /** @type {{ requires?: { backend?: unknown, message?: unknown } }} */ (view)?.requires;
  const requiredBackend = typeof requirement?.backend === 'string' ? requirement.backend : 'unknown';
  const hasCustomMessage = typeof requirement?.message === 'string' && requirement.message.trim().length > 0;
  debugViewAvailability({ event: 'view-unavailable', requiredBackend, currentBackend: backend, hasCustomMessage });
  return hasCustomMessage
    ? /** @type {string} */ (requirement.message)
    : 'This view is unavailable on the current dashboard backend.';
}
