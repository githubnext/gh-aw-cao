import { h } from '../dom.js';
import { formatMediumUtcDateTimeWithSuffix } from './ui-primitives.js';
import { createDebug } from '../debug.js';

const debugDashboardFooter = createDebug('dashboard-footer');

/** @param {{ evaluatedAt: string, commitSha?: string | null, githubUrlBase: string, dashboardRepository: string | null }} options */
export function renderDashboardFooter({ evaluatedAt, commitSha, githubUrlBase, dashboardRepository }) {
  const hasVersion = Boolean(commitSha) && commitSha !== 'development';
  const validShaFormat = hasVersion && /^[0-9a-f]{40}$/.test(/** @type {string} */ (commitSha));
  const linked = hasVersion && validShaFormat && Boolean(dashboardRepository);
  debugDashboardFooter({
    event: 'rendered',
    hasVersion,
    validShaFormat,
    hasRepository: Boolean(dashboardRepository),
    linked
  });
  return h(
    'footer',
    { className: 'report-footer' },
    h(
      'div',
      { className: 'report-footer-status' },
      h('span', null, 'Last updated'),
      h('time', { dateTime: evaluatedAt }, formatMediumUtcDateTimeWithSuffix(new Date(evaluatedAt))),
      h('span', { className: 'report-footer-provenance' }, '· Generated deterministically from dashboard data.')
    ),
    hasVersion
      ? h(
          'span',
          { className: 'report-footer-version', title: /** @type {string} */ (commitSha) },
          'Version ',
          linked
            ? h('a', { href: `${githubUrlBase}/${dashboardRepository}/commit/${commitSha}`, 'aria-label': `View commit ${commitSha} on GitHub` }, h('code', null, /** @type {string} */ (commitSha).slice(0, 7)))
            : h('code', null, /** @type {string} */ (commitSha).slice(0, 7))
        )
      : null
  );
}