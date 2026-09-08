import { h } from '../dom.js';
import { isFailureConclusion } from './run-classification.js';
import { rowsFor } from './source-rows.js';
import { formatMediumUtcDateTime } from './ui-primitives.js';

/** @param {unknown} value */
function timestamp(value) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/** @param {number} value */
function compactAge(value) {
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - value) / 60_000));
  if (elapsedMinutes < 1) return '<1m ago';
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
  if (elapsedMinutes < 1_440) return `${Math.floor(elapsedMinutes / 60)}h ago`;
  return `${Math.floor(elapsedMinutes / 1_440)}d ago`;
}

/** @param {Record<string, unknown>[]} rows @param {string[]} fields */
function timestampRange(rows, fields) {
  return rows.flatMap((row) => fields.map((field) => timestamp(row[field])).filter((value) => value !== null));
}

/** @param {Record<string, unknown>[]} rows @param {string} emptyLabel */
function waitingDetail(rows, emptyLabel) {
  if (rows.length === 0) return emptyLabel;
  const timestamps = timestampRange(rows, ['waiting-since', 'started-at', 'observed-at']);
  return timestamps.length > 0 ? `Oldest waiting ${compactAge(Math.min(...timestamps))}` : 'Waiting time unavailable';
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

/** @param {'complete'|'incomplete'|'unavailable'} state @param {string} completeDetail @param {string} subject */
function metricDetail(state, completeDetail, subject) {
  if (state === 'unavailable') return `${subject} evidence unavailable`;
  if (state === 'incomplete') return 'Incomplete evidence';
  return completeDetail;
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
  const awaitingReview = workItems.filter((row) => ['review', 'pending-review'].includes(String(row['lifecycle-state'])));
  const failureTimestamps = timestampRange(failedRuns, ['started-at', 'ended-at']);
  const criticalFindings = securityFindings.filter((row) => String(row['smell-severity']).toLowerCase() === 'critical').length;
  const highFindings = securityFindings.filter((row) => String(row['smell-severity']).toLowerCase() === 'high').length;
  const classifiedFindings = securityFindings.filter((row) => String(row['smell-severity'] ?? '').trim().length > 0).length;
  const metrics = [
    {
      count: metricCount(failedRuns.length, runEvidence),
      label: 'Failed runs',
      detail: metricDetail(runEvidence, failedRuns.length === 0
        ? 'No current failures'
        : failureTimestamps.length > 0 ? `Latest ${compactAge(Math.max(...failureTimestamps))}` : 'Recency unavailable', 'Run'),
      href: '#page-overview-failed-runs',
      tone: 'danger'
    },
    {
      count: metricCount(blockedWork.length, workEvidence),
      label: 'Blocked work',
      detail: metricDetail(workEvidence, waitingDetail(blockedWork, 'No blocked work'), 'Work'),
      href: '#page-overview-blocked-work',
      tone: 'attention'
    },
    {
      count: metricCount(awaitingReview.length, workEvidence),
      label: 'Awaiting review',
      detail: metricDetail(workEvidence, waitingDetail(awaitingReview, 'No reviews waiting'), 'Work'),
      href: '#page-overview-awaiting-review',
      tone: 'attention'
    },
    {
      count: metricCount(securityFindings.length, securityEvidence),
      label: 'Security findings',
      detail: metricDetail(securityEvidence, securityFindings.length === 0
        ? 'No current findings'
        : classifiedFindings > 0 ? `${criticalFindings} critical · ${highFindings} high` : 'Severity unavailable', 'Security'),
      href: '#page-overview-security-findings',
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
    h('h2', null, `${attentionCount} needs your attention`),
    quietState ? h('div', { className: `home-attention-empty home-attention-empty-${quietState.state}` },
      h('strong', null, quietState.title),
      h('p', null, quietState.detail)
    ) : null,
    h('div', { className: 'home-attention-metrics' },
      ...metrics.map((metric) => h('a', {
        className: `home-attention-metric home-attention-metric-${metric.tone}`,
        href: metric.href
      },
      h('span', { className: 'home-attention-label' }, metric.label),
      h('strong', null, metric.count),
      h('small', { className: 'home-attention-detail' }, metric.detail)))));
}