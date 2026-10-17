import { h } from '../dom.js';
import { usesRemoteDataBackend } from '../backend-mode.js';
import { createDebug } from '../debug.js';

const debugStorageInfo = createDebug('storage-info');

/** Deployment configuration, not a projection over activity evidence.
 * @param {import('./ui-elements.js').ElementRenderContext} context
 */
export function renderStorageInfo(context) {
  const configured = document.querySelector('meta[name="dashboard-storage-backend"]')?.getAttribute('content');
  const backend = configured ?? (usesRemoteDataBackend() ? 'unknown' : 'indexeddb');
  const descriptions = new Map([
    ['indexeddb', ['Browser-local storage (IndexedDB)', 'Dashboard data is stored in this browser, not in localStorage. Clearing site data removes this disposable copy; source activity is unchanged.']],
    ['sqlite', ['Local server storage (SQLite)', 'Dashboard data is stored in a SQLite database on the local preview server, not in this browser.']],
    ['postgres', ['Server storage (PostgreSQL)', 'Dashboard data is stored in PostgreSQL on the server, not in this browser.']]
  ]);
  const [label, description] = descriptions.get(backend)
    ?? ['Storage engine unknown', 'The deployment has not declared a recognized storage engine.'];
  debugStorageInfo({
    event: 'backend-resolved',
    backend: descriptions.has(backend) ? backend : 'unrecognized',
    declared: configured != null
  });
  return h('div', { 'aria-label': context.title },
    h('p', null, h('strong', null, label)),
    h('p', { className: 'muted' }, description)
  );
}
