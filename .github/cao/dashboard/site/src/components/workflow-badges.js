/**
 * Shared workflow role and package-membership badge strip.
 */

import { h } from '../dom.js';
import { text, titleCase } from './count-formatters.js';

/**
 * @typedef {{
 *   roleClassName?: string,
 *   membershipClassName?: string,
 *   containerClassName?: string,
 *   packagePage?: string
 * }} WorkflowBadgeOptions
 */

/**
 * @param {Record<string, unknown>} workflow
 * @param {WorkflowBadgeOptions} [options]
 * @returns {HTMLElement}
 */
export function renderWorkflowBadges(workflow, options = {}) {
  const {
    roleClassName = 'workflow-badge',
    membershipClassName = 'workflow-badge workflow-badge-operation',
    containerClassName = 'workflow-badges',
    packagePage = 'package-insights'
  } = options;
  const role = workflowRole(workflow);
  const memberships = workflowPackageMemberships(workflow);
  return h(
    'span',
    { className: containerClassName },
    h('span', { className: `${roleClassName} workflow-badge-${role}` }, titleCase(role)),
    ...memberships.map((membership) => h(
      'a',
      {
        className: membershipClassName,
        href: `#page-${packagePage}?package=${encodeURIComponent(membership.id)}`
      },
      `Package · ${membership.name}`
    ))
  );
}

/** @param {Record<string, unknown>} workflow */
export function workflowRole(workflow) {
  const role = text(workflow['workflow-role']).toLowerCase();
  return ['orchestrator', 'worker', 'standalone'].includes(role)
    ? role
    : workflowPackageMemberships(workflow).length > 0 ? 'operation' : 'unknown';
}

/** @param {Record<string, unknown>} workflow */
export function workflowPackageMemberships(workflow) {
  const memberships = Array.isArray(workflow['package-memberships'])
    ? workflow['package-memberships']
    : workflow.package
      ? [{ id: workflow.package, name: workflow['package-name'] ?? workflow.package }]
      : [];
  const unique = new Map();
  for (const membership of memberships) {
    if (!membership || typeof membership !== 'object' || Array.isArray(membership)) continue;
    const id = text(membership.id).trim();
    const name = text(membership.name).trim();
    if (id && name) unique.set(id, { id, name });
  }
  return [...unique.values()].sort((left, right) => left.name.localeCompare(right.name));
}

