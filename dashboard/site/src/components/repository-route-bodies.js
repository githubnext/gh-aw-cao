/**
 * Shared repository-route body registry.
 */

import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { text } from './count-formatters.js';
import { externalAnchorAttrs, findLink } from './link-content.js';
import { renderDlRow } from './ui-primitives.js';
import { renderDeclaredCliAction } from './cli-actions.js';

/**
 * @param {{ repository: string, activity: Record<string, unknown> }} args
 * @returns {HTMLElement}
 */
export function renderRepositoryOverview({ repository, activity }) {
  const link = findLink(activity, 'repository-link');
  const externalHref = link?.externalHref ?? null;
  return h(
    'section',
    { className: 'repository-overview', 'data-repository': repository },
    h('header', { className: 'repository-overview-header' },
      h('div', { className: 'repository-overview-identity' },
        h('span', { className: 'repository-overview-icon', 'aria-hidden': 'true' }, octicon('repo')),
        h('div', null,
          h('h2', null, repository),
          h('p', null, statusSummary(activity)))),
      externalHref
        ? h('a', externalAnchorAttrs(externalHref, `View ${repository} on GitHub`), octicon('mark-github'), h('span', null, 'View on GitHub'))
        : null),
    h('dl', { className: 'repository-overview-stats' },
      renderDlRow('Workflows', value(activity.workflows)),
      renderDlRow('Runs', value(activity.runs)),
      renderDlRow('Failure rate', value(activity['failure-summary'])),
      renderDlRow('AI Credits', value(activity.aic)),
      renderDlRow('Ingestion', value(activity.ingestion)))
  );
}

/**
 * @param {{ repository: string }} args
 * @returns {HTMLElement}
 */
export function renderRepositorySettings({ repository }) {
  const templateValues = { repository };
  return h(
    'section',
    { className: 'repository-settings', 'data-repository': repository },
    h('h2', null, 'Agentic workflows'),
    h('p', null, `Update installed campaigns and upgrade the gh-aw compiler version for ${repository}.`),
    h('div', { className: 'repository-settings-actions' },
      renderDeclaredCliAction('update-repository', templateValues),
      renderDeclaredCliAction('upgrade-repository', templateValues))
  );
}

/** @param {Record<string, unknown>} activity */
function statusSummary(activity) {
  return text(activity.status) || 'No recent activity';
}

/** @param {unknown} input */
function value(input) {
  const rendered = text(input);
  return rendered.length > 0 ? rendered : '—';
}
