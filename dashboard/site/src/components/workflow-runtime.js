/**
 * Route-aware workflow runtime view.
 */

import { h } from '../dom.js';
import { formatNumber } from '../view-formatters.js';
import { renderChartWidget, renderPieLegend } from './chart-elements.js';
import { coverageWindowHours, renderVitalStat } from './ui-primitives.js';
import { finiteNumber, formatCount, text } from './count-formatters.js';
import { renderWorkflowRoutePage } from './workflow-route-page.js';
import { createDebug } from '../debug.js';

const debugWorkflowRuntime = createDebug('workflow-runtime');

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @returns {HTMLElement}
 */
export function renderWorkflowRuntime(context) {
  return renderWorkflowRoutePage({
    ...context,
    elementConfig: context.elementConfig ?? { body: 'insights' }
  });
}

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @param {Record<string, unknown>} workflow
 */
export function renderWorkflowRuntimeBody(context, workflow) {
  return h('div', null, renderRuntimeMetrics(context, workflow));
}

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @param {Record<string, unknown>} workflow
 */
function renderRuntimeMetrics(context, workflow) {
  const runSource = context.sources[context.sourceNames[1]];
  const usageSource = context.sources[context.sourceNames[2]];
  const runMetadata = runSource?.metadata;
  const usageMetadata = usageSource?.metadata;
  const healthAvailable = runMetadata?.availability === 'available' || runMetadata?.availability === 'empty';
  const usageAvailable = usageMetadata?.availability === 'available' || usageMetadata?.availability === 'empty';
  const summary = runSource?.rows[0];
  const health = {
    total: finiteNumber(summary?.total),
    successful: finiteNumber(summary?.successful),
    failed: finiteNumber(summary?.failed),
    approval: finiteNumber(summary?.approval),
    pending: finiteNumber(summary?.pending),
    other: finiteNumber(summary?.other)
  };
  const usage = usageSource?.rows[0];
  const usageTotal = finiteNumber(usage?.aic);
  const telemetryCount = finiteNumber(usage?.['telemetry-count']);
  const usageMeasured = telemetryCount > 0 || usageMetadata?.completeness === 'complete';
  debugWorkflowRuntime({ event: 'body-resolved', runCount: health.total, usageCount: telemetryCount });
  const registration = text(workflow['workflow-active']) === 'true'
    ? 'active'
    : text(workflow['workflow-active']) === 'false' ? 'disabled' : 'unknown';
  debugWorkflowRuntime({
    event: 'metrics-computed',
    healthAvailable,
    usageAvailable,
    usageMeasured,
    failed: health.failed
  });

  return h(
    'section',
    { className: 'repository-workflow-summary workflow-runtime-summary', 'aria-label': 'Workflow execution summary' },
    h(
      'dl',
      { className: 'workflow-runtime-metrics' },
      renderRunHealthMetric(health, healthAvailable, coverageLabel(runMetadata), recentMetricLabel('Run health', runMetadata)),
      renderVitalStat('Registration', registration, 'Current GitHub Actions state'),
      renderVitalStat(
        recentMetricLabel('AI Credits', usageMetadata),
        usageAvailable && usageMeasured ? formatNumber(usageTotal, { name: 'AI Credits', symbol: 'AIC', significant: 0.1, format: 'number' }) : '',
        usageAvailable
          ? `${formatCount(telemetryCount)} ${telemetryCount === 1 ? 'run' : 'runs'} with AIC telemetry; ${coverageLabel(usageMetadata)}`
          : 'AI Credit data unavailable'
      )
    )
  );
}

/**
 * @param {{ total: number, successful: number, failed: number, approval: number, pending: number, other: number }} health
 * @param {boolean} available
 * @param {string} coverage
 * @param {string} label
 */
function renderRunHealthMetric(health, available, coverage, label) {
  if (!available) {
    debugWorkflowRuntime({ event: 'run-health-unavailable' });
    return h(
      'div',
      { className: 'workflow-run-health' },
      h('dt', null, label),
      h('dd', null, ''),
      h('p', null, coverage)
    );
  }
  const entries = [
    ['Successful', health.successful],
    ['Failed', health.failed],
    ['Approval required', health.approval],
    ['Pending', health.pending],
    ['Skipped / neutral / stale / cancelled', health.other]
  ];
  return h(
    'div',
    { className: 'workflow-run-health' },
    h('dt', null, label),
    h(
      'dd',
      { className: 'workflow-health-chart' },
      renderChartWidget(
        'pie',
        entries.map(([label, value]) => ({ x: String(label), y: Number(value), color: null })),
        [],
        { entries: /** @type {Array<[string, number]>} */ (entries), total: health.total },
        'runs'
      ),
      h('span', { className: 'workflow-health-total' }, h('strong', null, formatNumber(health.total)), h('small', null, 'runs'))
    ),
    renderPieLegend(/** @type {Array<[string, number]>} */ (entries), health.total),
    h('p', null, coverage)
  );
}

/** @param {import('../presenter.js').SourceMetadata | undefined} metadata */
function coverageLabel(metadata) {
  if (metadata?.availability !== 'available' && metadata?.availability !== 'empty') return 'Actions run data unavailable';
  const hours = coverageWindowHours(metadata);
  return `${hours ? `${hours}-hour ` : ''}Actions run window`;
}

/** @param {string} label @param {import('../presenter.js').SourceMetadata | undefined} metadata */
function recentMetricLabel(label, metadata) {
  const hours = coverageWindowHours(metadata);
  return hours ? `${label} (last ${hours}h)` : `Recent ${label}`;
}
