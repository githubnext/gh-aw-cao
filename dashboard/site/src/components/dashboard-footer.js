import { h } from '../dom.js';
import { formatMediumUtcDateTimeWithSuffix } from './ui-primitives.js';

/** @param {{ evaluatedAt: string, commitSha?: string | null }} options */
export function renderDashboardFooter({ evaluatedAt, commitSha }) {
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
    commitSha && commitSha !== 'development'
      ? h(
          'span',
          { className: 'report-footer-version', title: commitSha },
          'Version ',
          /^[0-9a-f]{40}$/.test(commitSha)
            ? h('a', { href: `https://github.com/githubnext/gh-aw-cao/commit/${commitSha}`, 'aria-label': `View commit ${commitSha} on GitHub` }, h('code', null, commitSha.slice(0, 7)))
            : h('code', null, commitSha.slice(0, 7))
        )
      : null
  );
}