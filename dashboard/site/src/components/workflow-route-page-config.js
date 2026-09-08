/**
 * Shared declarative workflow route page configuration.
 */

import { createElementCompositionConfig, selectElementComposition } from './view-element-composition.js';
import { WORKFLOW_ROUTE_PAGE_BODY_VALUES } from './route-body-specification.js';

/** @typedef {'insights'|'reports'|'runs'} WorkflowRoutePageBody */

/**
 * @typedef {{
 *   body: WorkflowRoutePageBody,
 *   pageId: 'workflow-runtime'|'workflow-detail'|'workflow-runs'
 * }} WorkflowRoutePageConfig
 */

const WORKFLOW_ROUTE_PAGE_CONFIG = createElementCompositionConfig(
  /** @type {readonly WorkflowRoutePageBody[]} */ (WORKFLOW_ROUTE_PAGE_BODY_VALUES),
  /** @type {WorkflowRoutePageBody} */ ('reports')
);

const WORKFLOW_ROUTE_PAGE_CONFIGS = /** @type {Readonly<Record<WorkflowRoutePageBody, WorkflowRoutePageConfig>>} */ ({
  insights: {
    body: 'insights',
    pageId: 'workflow-runtime'
  },
  reports: {
    body: 'reports',
    pageId: 'workflow-detail'
  },
  runs: {
    body: 'runs',
    pageId: 'workflow-runs'
  }
});

/**
 * @param {unknown} body
 * @returns {WorkflowRoutePageConfig}
 */
export function workflowRoutePageConfigForBody(body) {
  return selectElementComposition(WORKFLOW_ROUTE_PAGE_CONFIGS, WORKFLOW_ROUTE_PAGE_CONFIG, body);
}
