/**
 * Shared workflow identity strip.
 */

import { h } from '../dom.js';
import { text } from './count-formatters.js';
import { findLink, renderExternalLinkOrFallback } from './link-content.js';
import { renderWorkflowBadges } from './workflow-badges.js';
import { createDebug } from '../debug.js';

const debugWorkflowIdentity = createDebug('workflow-identity');

/** @param {Record<string, unknown>} workflow */
export function renderWorkflowIdentity(workflow) {
  const link = findLink(workflow, 'workflow-link');
  const sourceLink = link
    ? { href: link.externalHref ?? link.href, label: 'View authored workflow' }
    : null;
  debugWorkflowIdentity({ event: 'render', hasSourceLink: Boolean(sourceLink) });
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
