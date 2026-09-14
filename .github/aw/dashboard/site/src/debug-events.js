import { createDebug } from './debug.js';

export const DASHBOARD_RENDER_EVENT = 'dashboard-render';
export const DASHBOARD_DATA_EVENT = 'dashboard-data';

const debugRender = createDebug('render');
const debugData = createDebug('data');

/**
 * @param {Document} document
 * @param {string} type
 * @param {Record<string, unknown>} detail
 */
export function emitDashboardDebugEvent(document, type, detail) {
  const EventConstructor = document.defaultView?.CustomEvent;
  if (typeof EventConstructor !== 'function') return;
  document.dispatchEvent(new EventConstructor(type, { detail }));
  const metadata = {
    kind: detail.kind,
    status: detail.status,
    pageId: detail.pageId,
    viewId: detail.viewId
  };
  if (type === DASHBOARD_RENDER_EVENT) debugRender(metadata);
  if (type === DASHBOARD_DATA_EVENT) debugData(metadata);
}
