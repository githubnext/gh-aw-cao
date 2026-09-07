/**
 * Shared Dashboard Language view factories for workflow-route pages.
 */

import { workflowRoutePageBody } from './workflow-route-page-body.js';

/**
 * @typedef {'insights'|'reports'|'runs'} WorkflowRoutePageBody
 */

/**
 * @param {{
 *   id: string,
 *   title: string,
 *   body: WorkflowRoutePageBody,
 *   sources: string[],
 *   layout?: 'full'|'wide'|'compact'
 * }} options
 */
export function createWorkflowRoutePageView(options) {
  return {
    id: options.id,
    title: options.title,
    data: {
      sources: options.sources
    },
    mark: 'element',
    element: 'workflow-route-page',
    config: { body: workflowRoutePageBody(options.body) },
    ...(options.layout ? { layout: options.layout } : {})
  };
}
