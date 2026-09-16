import { h } from '../dom.js';
import { formatMediumUtcDateTime } from './ui-primitives.js';

/** @param {{ evaluatedAt: string, commitSha?: string | null }} options */
export function renderDashboardFooter({ evaluatedAt, commitSha }) {
  return h(
    'footer',
    { className: 'report-footer' },
    h(
      'div',
      { className: 'report-footer-status' },
      h('span', null, 'Last updated'),
      h('time', { dateTime: evaluatedAt }, `${formatMediumUtcDateTime(new Date(evaluatedAt))} UTC`),
      h('span', { className: 'report-footer-provenance' }, '· Generated deterministically from dashboard data.')
    ),
    commitSha && commitSha !== 'development'
      ? h('span', { className: 'report-footer-version', title: commitSha }, 'Version ', h('code', null, commitSha.slice(0, 7)))
      : null
  );
}