import { h } from '../dom.js';
import { isFailureConclusion } from './run-classification.js';
import { rowsFor } from './source-rows.js';

/** @param {import('./ui-elements.js').ElementRenderContext} context */
export function renderHomeAttentionSummary(context) {
  const runs = rowsFor(context.sources, 'runs');
  const workItems = rowsFor(context.sources, 'work-items');
  const securityFindings = rowsFor(context.sources, 'security-findings');
  const metrics = [
    {
      count: runs.filter((row) => isFailureConclusion(row['run-conclusion'])).length,
      label: 'Failed runs',
      href: '#page-runs',
      tone: 'danger'
    },
    {
      count: workItems.filter((row) => row['lifecycle-state'] === 'blocked').length,
      label: 'Blocked work',
      href: '#page-work-tasks',
      tone: 'attention'
    },
    {
      count: workItems.filter((row) => ['review', 'pending-review'].includes(String(row['lifecycle-state']))).length,
      label: 'Awaiting review',
      href: '#page-work-tasks',
      tone: 'attention'
    },
    {
      count: securityFindings.length,
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
      h('strong', null, String(metric.count)),
      h('span', null, metric.label)))));
}