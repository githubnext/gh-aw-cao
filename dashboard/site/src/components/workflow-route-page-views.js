/**
 * Shared Dashboard Language view factories for workflow-route pages.
 */

import { workflowRoutePageConfigForBody } from './workflow-route-page-config.js'

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
      sources: options.sources,
    },
    mark: 'element',
    element: 'workflow-route-page',
    config: { body: workflowRoutePageConfigForBody(options.body).body },
    ...(options.layout ? { layout: options.layout } : {}),
  }
}
