/**
 * Shared workflow-route body registry.
 */

import { renderWorkflowRuntimeBody } from './workflow-runtime.js';

/**
 * @typedef {'insights'|'reports'|'runs'} WorkflowRouteBody
 */

/**
 * @typedef {(args: {
 *   context: import('./ui-elements.js').ElementRenderContext,
 *   route: { repository: string, workflow: string },
 *   workflow: Record<string, unknown>
 * }) => HTMLElement | null} WorkflowRouteBodyRenderer
 */

/** @type {Readonly<Record<WorkflowRouteBody, WorkflowRouteBodyRenderer | undefined>>} */
export const WORKFLOW_ROUTE_BODY_RENDERERS = {
  insights: ({ context, workflow }) => renderWorkflowRuntimeBody(context, workflow),
  reports: undefined,
  runs: undefined
};
