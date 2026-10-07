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
  const membership = workflowCampaignMembership(workflow);
  return h(
    'span',
    { className: containerClassName },
    h('span', { className: `${roleClassName} workflow-badge-${role}` }, titleCase(role)),
    membership
      ? h(
        'a',
        {
          className: membershipClassName,
          href: `#page-${campaignPage}?campaign=${encodeURIComponent(membership.id)}`
        },
        `Campaign · ${membership.name}`
      )
      : null
  );
}

/** @param {Record<string, unknown>} workflow */
export function workflowRole(workflow) {
  const role = text(workflow['workflow-role']).toLowerCase();
  if (['orchestrator', 'worker', 'standalone'].includes(role)) return role;
  const hasMembership = workflowCampaignMembership(workflow) !== null;
  const resolved = hasMembership ? 'operation' : 'unknown';
  debugWorkflowBadges({ event: 'role-fallback', resolved, hasMembership });
  return resolved;
}

/**
 * The canonical `workflows` query always resolves at most one campaign per
 * workflow (`campaignId` is a singular schema reference), so this returns a
 * single optional membership rather than a list.
 * @param {Record<string, unknown>} workflow
 * @returns {{ id: string, name: string } | null}
 */
export function workflowCampaignMembership(workflow) {
  const id = text(workflow.campaign).trim();
  const name = text(workflow['campaign-name'] ?? workflow.campaign).trim();
  return id && name ? { id, name } : null;
}

