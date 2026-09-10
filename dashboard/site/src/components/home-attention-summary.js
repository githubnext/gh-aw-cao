import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { isFailureConclusion } from './run-classification.js';
import { rowsFor } from './source-rows.js';
import { formatMediumUtcDateTime } from './ui-primitives.js';

/** @param {unknown} value */
function timestamp(value) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/** @param {import('../presenter.js').LogicalSourceInput | undefined} source */
function evidenceState(source) {
  if (!source || source.metadata?.availability !== 'available') return 'unavailable';
  if (source.metadata.completeness !== 'complete' || source.metadata.freshness !== 'fresh') return 'incomplete';
  return 'complete';
}

/** @param {number} count @param {'complete'|'incomplete'|'unavailable'} state */
function metricCount(count, state) {
  return state === 'unavailable' ? '—' : String(count);
}

/** @param {Record<string, unknown> | undefined} time */
function effectiveInterval(time) {
  const start = timestamp(time?.start);
  const end = timestamp(time?.end);
  return start !== null && end !== null
    ? `${formatMediumUtcDateTime(start)} UTC to ${formatMediumUtcDateTime(end)} UTC`
    : 'the selected dashboard horizon';
}

/** @param {import('./ui-elements.js').ElementRenderContext} context */
export function renderHomeAttentionSummary(context) {
  const interval = effectiveInterval(context.time);
  const runEvidence = evidenceState(context.sources.runs);
  const workEvidence = evidenceState(context.sources['work-items']);
  const securityEvidence = evidenceState(context.sources['security-findings']);
  const runs = rowsFor(context.sources, 'runs');
  const workItems = rowsFor(context.sources, 'work-items');
  const securityFindings = rowsFor(context.sources, 'security-findings');
  const failedRuns = runs.filter((row) => isFailureConclusion(row['run-conclusion']));
  const blockedWork = workItems.filter((row) => row['lifecycle-state'] === 'blocked');
  const awaitingReview = workItems.filter((row) => row['lifecycle-state'] === 'review');
  const metrics = [
    {
      count: metricCount(failedRuns.length, runEvidence),
      label: 'Failed runs',
      href: '#page-overview-failed-runs',
      icon: 'x-circle',
      tone: 'danger'
    },
    {
      count: metricCount(blockedWork.length, workEvidence),
      label: 'Blocked work',
      href: '#page-overview-blocked-work',
      icon: 'stop',
      tone: 'attention'
    },
    {
      count: metricCount(awaitingReview.length, workEvidence),
      label: 'Awaiting review',
      href: '#page-overview-awaiting-review',
      icon: 'person',
      tone: 'review'
    },
    {
      count: metricCount(securityFindings.length, securityEvidence),
      label: 'Security findings',
      href: '#page-overview-security-findings',
      icon: 'shield',
      tone: 'danger'
    }
  ];
  const attentionCount = failedRuns.length + blockedWork.length + awaitingReview.length + securityFindings.length;
  const hasObservedAttention = attentionCount > 0;
  const evidenceGaps = [
    [runEvidence, 'failed runs'],
    [workEvidence, 'blocked work and review waits'],
    [securityEvidence, 'security findings']
  ].filter(([state]) => state !== 'complete').map(([, label]) => label);
  const quietState = hasObservedAttention ? null : evidenceGaps.length === 0
    ? {
        title: 'Nothing needs your attention',
        detail: `No failed runs, blocked work, review waits, or security findings were observed from ${interval}.`,
        state: 'complete'
      }
    : {
        title: 'No attention observed in available evidence',
        detail: `${evidenceGaps.join(', ')} could not be fully evaluated from ${interval}.`,
        state: 'incomplete'
      };

  return h('section', { className: 'home-attention-summary', 'aria-label': 'Needs your attention' },
    h(context.headingTag, null, attentionCount === 1 ? '1 item needs your attention' : `${attentionCount} items need your attention`),
    quietState ? h('div', { className: `home-attention-empty home-attention-empty-${quietState.state}` },
      h('strong', null, quietState.title),
      h('p', null, quietState.detail)
    ) : null,
    h('div', { className: 'home-attention-metrics' },
      ...metrics.map((metric) => {
        const hasItems = Number(metric.count) > 0;
        const isEmpty = metric.count === '0';
        return h(isEmpty ? 'div' : 'a', {
          className: `home-attention-metric${hasItems ? ` home-attention-metric-${metric.tone} home-attention-metric-active` : ''}${isEmpty ? ' home-attention-metric-empty' : ''}`,
          ...(isEmpty ? {} : { href: metric.href })
        },
        h('strong', {
          className: hasItems ? 'home-attention-count-active' : ''
        }, metric.count),
        h('span', {
          className: `home-attention-label${hasItems ? ' home-attention-label-active' : ''}`
        }, metric.label),
        h('span', {
          className: `home-attention-icon${hasItems ? ' home-attention-icon-active' : ''}`
        }, octicon(metric.icon)));
      })));
}