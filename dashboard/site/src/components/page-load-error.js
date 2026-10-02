import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { DashboardServerError } from '../remote-data-backend.js';
import { createDebug } from '../debug.js';

const debugPageLoadError = createDebug('page-load-error');

/** @type {Record<string, { title: string, description: string, boundaries?: Record<string, string> }>} */
const ERROR_PRESENTATIONS = {
  query_plan_too_large: {
    title: 'This page needs more data than the server can process',
    description: 'Try a shorter time range or contact your dashboard administrator if this continues.',
    boundaries: {
      retained_bytes: 'Retained data'
    }
  }
};
/** @type {{ title: string, description: string, boundaries?: Record<string, string> }} */
const DEFAULT_PRESENTATION = {
  title: 'Unable to load this page',
  description: 'The page could not be loaded. Please try again.'
};

/**
 * @param {unknown} error
 * @param {() => void} retry
 * @returns {HTMLElement}
 */
export function renderPageLoadError(error, retry) {
  const serverError = error instanceof DashboardServerError ? error : null;
  const matched = Boolean(serverError && Object.hasOwn(ERROR_PRESENTATIONS, serverError.code));
  const presentation = matched ? ERROR_PRESENTATIONS[/** @type {DashboardServerError} */ (serverError).code] : DEFAULT_PRESENTATION;
  const boundary = serverError && presentation.boundaries
    && Object.hasOwn(presentation.boundaries, serverError.boundary)
    ? presentation.boundaries[serverError.boundary]
    : undefined;
  debugPageLoadError({
    event: 'classified',
    errorKind: serverError ? 'server' : 'generic',
    code: serverError?.code,
    matched,
    hasBoundary: boundary !== undefined,
    ...(serverError?.traceId ? { traceId: serverError.traceId } : {})
  });
  return h('div', { className: 'page-load-error', role: 'alert' },
    octicon('alert'),
    h('div', { className: 'page-load-error-body' },
      h('h2', null, presentation.title),
      h('p', null, presentation.description),
      presentation !== DEFAULT_PRESENTATION && serverError?.queryId
        ? h('p', { className: 'page-load-error-detail' }, `Query: ${serverError.queryId}`) : null,
      boundary ? h('p', { className: 'page-load-error-detail' }, `Limit type: ${boundary}`) : null,
      serverError?.traceId
        ? h('p', { className: 'page-load-error-detail' }, `Request ID: ${serverError.traceId}`) : null,
      h('button', {
        type: 'button',
        className: 'button',
        onclick: () => {
          debugPageLoadError({ event: 'retry-requested' });
          retry();
        }
      }, 'Try again')
    )
  );
}
