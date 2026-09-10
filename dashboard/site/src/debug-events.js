export const DASHBOARD_RENDER_EVENT = 'dashboard-render';
export const DASHBOARD_DATA_EVENT = 'dashboard-data';

/**
 * @param {Document} document
 * @param {string} type
 * @param {Record<string, unknown>} detail
 */
export function emitDashboardDebugEvent(document, type, detail) {
  const EventConstructor = document.defaultView?.CustomEvent;
  if (typeof EventConstructor !== 'function') return;
  document.dispatchEvent(new EventConstructor(type, { detail }));
}
