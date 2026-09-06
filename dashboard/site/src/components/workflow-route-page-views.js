/**
 * Shared Dashboard Language view factories for workflow-route pages.
 */

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
    element: 'workflow-route',
    config: {
      body: options.body
    },
    ...(options.layout ? { layout: options.layout } : {})
  };
}
