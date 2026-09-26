/**
 * Route-aware workflow runtime view.
 */

import { h } from '../dom.js';
import { formatNumber } from '../view-formatters.js';
import { renderChartWidget, renderPieLegend } from './chart-elements.js';
import { isApprovalConclusion, isFailureConclusion } from './run-classification.js';
import { coverageWindowHours, renderVitalStat } from './ui-primitives.js';
import { finiteNumber, formatCount, text } from './count-formatters.js';
import { renderWorkflowRoutePage } from './workflow-route-page.js';
import { rowsFor } from './source-rows.js';

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
  const repository = qualifiedRepository(workflow);
  const workflowPath = text(workflow.workflow);
  const runs = matchingRows(context, 'runs', repository, workflowPath);
  const usage = matchingRows(context, 'usage', repository, workflowPath);

  return h(
    'div',
    null,
    renderRuntimeMetrics(context, workflow, runs, usage)
  );
}

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @param {Record<string, unknown>} workflow
 * @param {Array<Record<string, unknown>>} runs
 * @param {Array<Record<string, unknown>>} usage
 */
function renderRuntimeMetrics(context, workflow, runs, usage) {
  const runMetadata = context.sources.runs?.metadata;
  const usageMetadata = context.sources.usage?.metadata;
  const healthAvailable = runMetadata?.availability === 'available';
  const usageAvailable = usageMetadata?.availability === 'available';
  const health = summarizeRunHealth(runs);
  const usageTotal = usage.reduce((total, row) => total + finiteNumber(row.aic), 0);
  const usageMeasured = usage.length > 0 || usageMetadata?.completeness === 'complete';
  const registration = text(workflow['workflow-active']) === 'true'
    ? 'active'
    : text(workflow['workflow-active']) === 'false' ? 'disabled' : 'unknown';

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
          ? `${formatCount(usage.length)} ${usage.length === 1 ? 'run' : 'runs'} with AIC telemetry; ${coverageLabel(usageMetadata)}`
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

/** @param {Array<Record<string, unknown>>} runs */
function summarizeRunHealth(runs) {
  const health = { total: runs.length, successful: 0, failed: 0, approval: 0, pending: 0, other: 0 };
  for (const run of runs) {
    const conclusion = run['run-conclusion'];
    const status = text(run['run-status']);
    if (conclusion === 'success') health.successful += 1;
    else if (isFailureConclusion(conclusion)) health.failed += 1;
    else if (isApprovalConclusion(conclusion)) health.approval += 1;
    else if (status && status !== 'completed') health.pending += 1;
    else health.other += 1;
  }
  return health;
}

/** @param {import('../presenter.js').SourceMetadata | undefined} metadata */
function coverageLabel(metadata) {
  if (metadata?.availability !== 'available') return 'Actions run data unavailable';
  const hours = coverageWindowHours(metadata);
  return `${hours ? `${hours}-hour ` : ''}Actions run window`;
}

/** @param {string} label @param {import('../presenter.js').SourceMetadata | undefined} metadata */
function recentMetricLabel(label, metadata) {
  const hours = coverageWindowHours(metadata);
  return hours ? `${label} (last ${hours}h)` : `Recent ${label}`;
}

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @param {string} sourceName
 * @param {string} repository
 * @param {string} workflow
 */
function matchingRows(context, sourceName, repository, workflow) {
  return rowsFor(context.sources, sourceName).filter((row) => matchesWorkflow(row, repository, workflow));
}

/** @param {Record<string, unknown>} row @param {string} repository @param {string} workflow */
function matchesWorkflow(row, repository, workflow) {
  return qualifiedRepository(row).toLowerCase() === repository.toLowerCase()
    && text(row.workflow) === workflow;
}

/** @param {Record<string, unknown>} row */
function qualifiedRepository(row) {
  const repository = text(row.repository);
  return repository.includes('/') ? repository : `${text(row.organization)}/${repository}`.replace(/^\/|\/$/g, '');
}

