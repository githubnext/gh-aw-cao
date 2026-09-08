import { h } from '../dom.js';
import { isFailureConclusion } from './run-classification.js';
import { rowsFor } from './source-rows.js';

/** @param {import('../presenter.js').SourceMetadata | undefined} metadata */
function isSourceUnavailable(metadata) {
  return !metadata || metadata.availability === 'unavailable';
}

/** @param {import('./ui-elements.js').ElementRenderContext} context */
export function renderHomeAttentionSummary(context) {
  const runs = rowsFor(context.sources, 'runs');
  const workItems = rowsFor(context.sources, 'work-items');
  const securityFindings = rowsFor(context.sources, 'security-findings');
  const runsUnavailable = isSourceUnavailable(context.sources.runs?.metadata);
  const workItemsUnavailable = isSourceUnavailable(context.sources['work-items']?.metadata);
  const securityFindingsUnavailable = isSourceUnavailable(context.sources['security-findings']?.metadata);
  const metrics = [
    {
      count: runs.filter((row) => isFailureConclusion(row['run-conclusion'])).length,
      unavailable: runsUnavailable,
      label: 'Failed runs',
      href: '#page-runs',
      tone: 'danger'
    },
    {
      count: workItems.filter((row) => row['lifecycle-state'] === 'blocked').length,
      unavailable: workItemsUnavailable,
      label: 'Blocked work',
      href: '#page-work-tasks',
      tone: 'attention'
    },
    {
      count: workItems.filter((row) => row['lifecycle-state'] === 'review').length,
      unavailable: workItemsUnavailable,
      label: 'Awaiting review',
      href: '#page-work-tasks',
      tone: 'attention'
    },
    {
      count: securityFindings.length,
      unavailable: securityFindingsUnavailable,
      label: 'Security findings',
      href: '#page-security',
      tone: 'danger'
    }
  ];

  return h('section', { className: 'home-attention-summary', 'aria-label': 'Needs your attention' },
    h('h2', null, 'Needs your attention'),
    h('div', { className: 'home-attention-metrics' },
      ...metrics.map((metric) => h('a', {
        className: `home-attention-metric home-attention-metric-${metric.tone}`,
        href: metric.href
      },
      h('strong', null, metric.unavailable ? '—' : String(metric.count)),
      h('span', null, metric.label)))));
}