/**
 * Shared workflow route parsing and formatting helpers.
 */

/**
 * @typedef {{ repository: string, workflow: string }} WorkflowRoute
 */

/**
 * Parses a workflow route value into repository and workflow identity.
 * @param {unknown} value
 * @returns {WorkflowRoute | null}
 */
export function parseWorkflowRoute(value) {
  if (typeof value !== 'string' || value.length > 700) return null;
  const separator = value.indexOf(':');
  if (separator <= 0) return null;
  const repository = value.slice(0, separator);
  const workflow = value.slice(separator + 1);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,98}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/.test(repository)) return null;
  if (!workflow.startsWith('.github/workflows/') || !workflow.endsWith('.md')) return null;
  if ([...workflow].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)) return null;
  if (workflow.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  return { repository, workflow };
}

/**
 * Formats repository and workflow identity for route parameters.
 * @param {string} repository
 * @param {string} workflow
 * @returns {string}
 */
export function workflowRouteValue(repository, workflow) {
  return `${repository}:${workflow}`;
}
