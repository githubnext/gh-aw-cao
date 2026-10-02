import { h } from '../dom.js';
import { effect, state } from '../reactive.js';
import { fetchServerLogs, usesRemoteDataBackend } from '../remote-data-backend.js';
import { errorMessage } from './count-formatters.js';
import { createFactoryScope } from './factory-elements.js';
import { renderFileContent } from './file-content.js';
import { renderEmptyMessage, renderLoadingMessage } from './ui-primitives.js';

/** @param {() => void} onOpen */
export function renderServerLogsSetting(onOpen) {
  if (!usesRemoteDataBackend()) return null;
  const scope = createFactoryScope();
  const section = h('section', { className: 'configuration-browser-settings', hidden: true, 'aria-labelledby': 'configuration-logs-heading' },
    h('div', { className: 'configuration-browser-settings-heading' },
      h('h3', { id: 'configuration-logs-heading' }, 'Logs')),
    h('div', { className: 'configuration-setting-row' },
      h('div', { className: 'configuration-setting-copy' },
        h('span', null, 'Server logs'),
        h('p', null, 'Inspect recent server diagnostics. Available to administrators only.')),
      h('button', { id: 'configuration-server-logs-link', className: 'configuration-transactions-button', type: 'button', onClick: onOpen }, 'Server logs')
    )
  );
  fetchServerLogs(scope.signal).then((snapshot) => {
    if (!scope.signal.aborted && Array.isArray(snapshot?.logs)) section.hidden = false;
  }).catch(() => {});
  scope.bind(section);
  return section;
}

/** @param {() => void} onBack */
export function renderServerLogsView(onBack) {
  const scope = createFactoryScope();
  const content = state(/** @type {{ status: string, text: string }} */ ({ status: 'loading', text: '' }));
  const body = h('div', { className: 'memory-file-body', 'aria-live': 'polite' });
  const refresh = /** @type {HTMLButtonElement} */ (h('button', {
    className: 'configuration-transactions-button', type: 'button', onClick: load
  }, 'Refresh'));
  const root = h('section', { className: 'configuration-server-logs-view', 'aria-labelledby': 'server-logs-heading' },
    h('div', { className: 'configuration-server-logs-toolbar' },
      h('button', { className: 'configuration-transactions-button', type: 'button', onClick: onBack }, 'Back to settings'),
      h('h2', { id: 'server-logs-heading' }, 'Server logs'),
      refresh
    ),
    body
  );
  let request = /** @type {AbortController | null} */ (null);
  function load() {
    request?.abort();
    request = new AbortController();
    const current = request;
    content.set({ status: 'loading', text: '' });
    fetchServerLogs(current.signal).then((snapshot) => {
      if (current.signal.aborted) return;
      if (!snapshot || !Array.isArray(snapshot.logs)) throw new Error('Server logs are unavailable.');
      content.set({ status: 'ready', text: JSON.stringify(snapshot, null, 2) });
    }).catch((error) => {
      if (!current.signal.aborted) content.set({ status: 'error', text: errorMessage(error) });
    });
  }
  scope.signal.addEventListener('abort', () => request?.abort(), { once: true });
  effect(() => {
    const current = content.get();
    refresh.disabled = current.status === 'loading';
    body.replaceChildren(current.status === 'loading'
      ? renderLoadingMessage('Loading server logs...')
      : current.status === 'error'
        ? renderEmptyMessage(`Unable to load server logs. ${current.text}`, { role: 'alert' })
        : renderFileContent(current.text));
  }, { signal: scope.signal });
  scope.bind(root);
  load();
  return root;
}
