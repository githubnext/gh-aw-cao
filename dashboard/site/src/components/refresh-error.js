import { h } from '../dom.js';
import { octicon } from '../octicons.js';

/**
 * @param {() => void} retry
 * @returns {HTMLElement}
 */
export function renderRefreshError(retry) {
  return h(
    'section',
    { className: 'source-refresh-error', role: 'alert' },
    h(
      'div',
      { className: 'source-refresh-error-message' },
      h('strong', null, 'Dashboard data could not be refreshed.'),
      h('p', null, 'Some views may be unavailable. You are seeing the most recent cached data.')
    ),
    h(
      'button',
      {
        type: 'button',
        className: 'refresh-button source-refresh-retry',
        onclick: retry
      },
      octicon('sync'),
      h('span', null, 'Retry')
    )
  );
}
