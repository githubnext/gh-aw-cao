import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { renderCloseButton } from './ui-primitives.js';

/**
 * @param {() => void} retry
 * @returns {HTMLElement}
 */
export function renderRefreshError(retry) {
  const element = h(
    'section',
    { className: 'source-refresh-error', role: 'alert' },
    h(
      'div',
      { className: 'source-refresh-error-message' },
      h('strong', null, 'Dashboard data could not be refreshed.'),
      h('p', null, 'Some views may be unavailable. You are seeing the most recent cached data.')
    ),
    h(
      'div',
      { className: 'source-refresh-actions' },
      h(
        'button',
        {
          type: 'button',
          className: 'refresh-button source-refresh-retry',
          onclick: retry
        },
        octicon('sync'),
        h('span', null, 'Retry')
      ),
      renderCloseButton({
        className: 'source-refresh-dismiss',
        label: 'Dismiss partial data warning',
        onClick: () => element.remove()
      })
    )
  );
  return element;
}
