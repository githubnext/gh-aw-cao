import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { DashboardServerError } from '../remote-data-backend.js';

/**
 * @param {unknown} error
 * @param {() => void} retry
 * @returns {HTMLElement}
 */
export function renderPageLoadError(error, retry) {
  const limited = error instanceof DashboardServerError && error.code === 'query_plan_too_large';
  return h('div', { className: 'page-load-error', role: 'alert' },
    octicon('alert'),
    h('div', { className: 'page-load-error-body' },
      h('h2', null, limited ? 'This page needs more data than the server can process' : 'Unable to load this page'),
      h('p', null, limited
        ? 'Try a shorter time range or contact your dashboard administrator if this continues.'
        : 'The page could not be loaded. Please try again.'),
      limited && error.queryId ? h('p', { className: 'page-load-error-detail' }, `Query: ${error.queryId}`) : null,
      h('button', { type: 'button', className: 'button', onclick: retry }, 'Try again')
    )
  );
}
