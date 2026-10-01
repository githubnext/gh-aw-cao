/**
 * Shared declarative workflow route page configuration.
 */

import { selectNamedComposition } from './route-composition.js';
import { createDebug } from '../debug.js';

const debugWorkflowRoutePageConfig = createDebug('workflow-route-page-config');

/**
 * @typedef {'workflow-runtime'|'workflow-detail'|'workflow-runs'} WorkflowRoutePageId
 */

/**
 * @typedef {{
 *   body: 'insights'|'reports'|'runs',
 *   pageId: 'workflow-runtime'|'workflow-detail'|'workflow-runs'
 * }} WorkflowRoutePageConfig
 */

const WORKFLOW_ROUTE_PAGE_CONFIGS = /** @type {Readonly<Record<WorkflowRoutePageId, WorkflowRoutePageConfig>>} */ ({
  'workflow-runtime': {
    body: 'insights',
    pageId: 'workflow-runtime'
  },
  'workflow-detail': {
    body: 'reports',
    pageId: 'workflow-detail'
  },
  'workflow-runs': {
    body: 'runs',
    pageId: 'workflow-runs'
  }
});

/**
 * @param {unknown} pageId
 * @returns {WorkflowRoutePageConfig}
 */
export function workflowRoutePageConfig(pageId) {
  const recognized = typeof pageId === 'string' && Object.hasOwn(WORKFLOW_ROUTE_PAGE_CONFIGS, pageId);
  if (!recognized) debugWorkflowRoutePageConfig({ event: 'page-id-fallback', pageId });
  return selectNamedComposition(
    WORKFLOW_ROUTE_PAGE_CONFIGS,
    pageId,
    'workflow-detail'
  );
}

const WORKFLOW_ROUTE_PAGE_ID_BY_BODY = /** @type {Readonly<Record<'insights'|'reports'|'runs', WorkflowRoutePageId>>} */ ({
  insights: 'workflow-runtime',
  reports: 'workflow-detail',
  runs: 'workflow-runs'
});

/**
 * @param {unknown} body
 * @returns {WorkflowRoutePageConfig}
 */
export function workflowRoutePageConfigForBody(body) {
  const recognized = typeof body === 'string' && Object.hasOwn(WORKFLOW_ROUTE_PAGE_ID_BY_BODY, body);
  if (!recognized) debugWorkflowRoutePageConfig({ event: 'body-fallback', body });
  return selectNamedComposition(
    WORKFLOW_ROUTE_PAGE_CONFIGS,
    recognized
      ? WORKFLOW_ROUTE_PAGE_ID_BY_BODY[/** @type {'insights'|'reports'|'runs'} */ (body)]
      : 'workflow-detail',
    'workflow-detail'
  );
}
