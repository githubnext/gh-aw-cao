/**
 * Shared workflow identity strip.
 */

import { h } from '../dom.js';
import { text } from './count-formatters.js';
import { findLink, renderExternalLinkOrFallback } from './link-content.js';
import { renderWorkflowBadges } from './workflow-badges.js';

/** @param {Record<string, unknown>} workflow */
export function renderWorkflowIdentity(workflow) {
  const link = findLink(workflow, 'workflow-link');
  const sourceLink = link
    ? { href: link.externalHref ?? link.href, label: 'View authored workflow' }
    : null;
  return h(
    'section',
    { className: 'workflow-identity', 'aria-label': 'Workflow identity' },
    h(
      'div',
      null,
      renderWorkflowBadges(workflow),
      h('p', null, h('code', null, text(workflow.workflow)))
    ),
    renderExternalLinkOrFallback(sourceLink)
  );
}
