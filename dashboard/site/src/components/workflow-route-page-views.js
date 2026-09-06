/**
 * Shared Dashboard Language view factories for workflow-route pages.
 */

/**
 * @typedef {'insights'|'reports'|'runs'} WorkflowRouteBody
 */

/**
 * @param {{
 *   id: string,
 *   title: string,
 *   body: WorkflowRouteBody,
 *   sources: string[],
 *   layout?: 'full'|'wide'|'compact'
 * }} options
 */
export function createWorkflowRouteView(options) {
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

export const createWorkflowRoutePageView = createWorkflowRouteView;
