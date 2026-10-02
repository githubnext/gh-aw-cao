/**
 * Shared workflow role and campaign-membership badge strip.
 */

import { h } from '../dom.js';
import { text, titleCase } from './count-formatters.js';
import { createDebug } from '../debug.js';

const debugWorkflowBadges = createDebug('workflow-badges');

/**
 * @typedef {{
 *   roleClassName?: string,
 *   membershipClassName?: string,
 *   containerClassName?: string,
 *   campaignPage?: string
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
    campaignPage = 'campaign-insights'
  } = options;
  const role = workflowRole(workflow);
  const memberships = workflowCampaignMemberships(workflow);
  return h(
    'span',
    { className: containerClassName },
    h('span', { className: `${roleClassName} workflow-badge-${role}` }, titleCase(role)),
    ...memberships.map((membership) => h(
      'a',
      {
        className: membershipClassName,
        href: `#page-${campaignPage}?campaign=${encodeURIComponent(membership.id)}`
      },
      `Campaign · ${membership.name}`
    ))
  );
}

/** @param {Record<string, unknown>} workflow */
export function workflowRole(workflow) {
  const role = text(workflow['workflow-role']).toLowerCase();
  if (['orchestrator', 'worker', 'standalone'].includes(role)) return role;
  const membershipCount = workflowCampaignMemberships(workflow).length;
  const resolved = membershipCount > 0 ? 'operation' : 'unknown';
  debugWorkflowBadges({ event: 'role-fallback', resolved, membershipCount });
  return resolved;
}

/** @param {Record<string, unknown>} workflow */
export function workflowCampaignMemberships(workflow) {
  const memberships = Array.isArray(workflow['campaign-memberships'])
    ? workflow['campaign-memberships']
    : workflow.campaign
      ? [{ id: workflow.campaign, name: workflow['campaign-name'] ?? workflow.campaign }]
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

