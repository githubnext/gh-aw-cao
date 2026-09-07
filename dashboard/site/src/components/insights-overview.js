import { h } from '../dom.js';
import { formatNumber } from '../view-formatters.js';
import { listChartSeries, renderChartWidget, renderPieLegend } from './chart-elements.js';
import { rowsFor } from './source-rows.js';

const FAILURE_CONCLUSIONS = new Set(['failure', 'timed-out', 'startup-failure', 'action-required']);

/** @param {import('./ui-elements.js').ElementRenderContext} context */
export function renderInsightsOverview(context) {
  const values = rowsFor(context.sources, 'operational-values');
  const outcomes = rowsFor(context.sources, 'outcomes');
  const usage = rowsFor(context.sources, 'usage');
  const runs = rowsFor(context.sources, 'runs');
  const detections = rowsFor(context.sources, 'detection-observations');
  const experiments = rowsFor(context.sources, 'experiments');

  const valuePoints = values.flatMap((row, index) => {
    const value = Number(row['operational-value']);
    const observed = String(row['observed-at'] || '');
    return Number.isFinite(value) && Number.isFinite(Date.parse(observed))
      ? [{ x: observed, y: value, color: String(row['operational-value-definition'] || 'Attainment'), key: `value-${index}`, source: row }]
      : [];
  });
  const valueSeries = listChartSeries(valuePoints);
  const meanValue = mean(valuePoints.map((point) => point.y));
  const acceptedOutcomes = outcomes.filter((row) => String(row['outcome-state']) === 'accepted').length;
  const matureValues = values.filter((row) => String(row['maturity-status']) === 'matured').length;

  const outcomeEntries = counts(outcomes, (row) => String(row['outcome-state'] || 'unknown'));
  const usagePoints = dailyPoints(usage, 'observed-at', (row) => Number(row.aic), () => 'AI Credits');
  const usageSeries = listChartSeries(usagePoints);
  const totalAic = usage.reduce((total, row) => total + finiteNumber(row.aic), 0);

  const activeStatuses = new Set(['queued', 'in-progress', 'in_progress', 'waiting', 'pending']);
  const completedRuns = runs.filter((row) => {
    const status = String(row['run-status'] || '');
    const conclusion = String(row['run-conclusion'] || '');
    return status === 'completed' || (!activeStatuses.has(status) && Boolean(conclusion) && conclusion !== 'unknown');
  });
  const successfulRuns = completedRuns.filter((row) => String(row['run-conclusion']) === 'success').length;
  const failedRuns = completedRuns.filter((row) => FAILURE_CONCLUSIONS.has(String(row['run-conclusion']))).length;
  const activeRuns = runs.filter((row) => activeStatuses.has(String(row['run-status']))).length;
  const runPoints = runs.flatMap((row, index) => {
    const observed = String(row['started-at'] || '');
    const conclusion = String(row['run-conclusion'] || '');
    return Number.isFinite(Date.parse(observed)) && ['success', 'failure', 'timed-out', 'startup-failure', 'action-required', 'cancelled', 'skipped'].includes(conclusion)
      ? [{ x: observed, y: 1, color: conclusion, category: conclusion, key: `run-${index}`, source: row }]
      : [];
  });

  const detectionEntries = counts(detections, (row) => String(row['detection-state-label'] || row['detection-state'] || 'Unknown'));
  const usableVerdicts = mean(detections.map((row) => Number(row['usable-verdict-percent'])).filter(Number.isFinite));
  const experimentEntries = counts(experiments, (row) => String(row.decision || row.readiness || 'Pending'));
  const decisionReady = experiments.filter((row) => ['PROMOTE', 'REJECT', 'READY'].includes(String(row.decision || row.readiness).toUpperCase())).length;
  const valueChart = h('div', { className: 'insights-value-chart' }, renderChartWidget('line', valuePoints, valueSeries));

  return h('section', { className: 'insights-overview', 'aria-label': context.title },
    h('section', { className: 'insights-value-lead', 'aria-labelledby': 'insights-value-title' },
      h('div', { className: 'insights-section-heading' },
        h('div', null,
          h('span', { className: 'insights-eyebrow' }, 'Value created'),
          h('h2', { id: 'insights-value-title' }, 'Operational value attainment'),
          h('p', null, 'Measured attainment and accepted repository outcomes, without inferring unsupported ROI.')),
        h('dl', { className: 'insights-lead-metrics' },
          metric(meanValue === null ? '—' : `${Math.round(meanValue * 100)}%`, 'mean attainment'),
          metric(formatNumber(acceptedOutcomes), 'accepted outcomes'),
          metric(formatNumber(matureValues), 'mature observations'))),
      valueSeries.length > 1 ? renderValueSeriesSelector(valuePoints, valueSeries, valueChart) : null,
      valueChart),

    h('div', { className: 'insights-plot-grid' },
      insightPanel('Outcome disposition', 'What happened to retained outputs.',
        renderChartWidget('pie', [], [], pieSummary(outcomeEntries), 'Outcomes'),
        renderPieLegend(outcomeEntries, sumEntries(outcomeEntries))),
      insightPanel('AI Credit allocation', 'Daily measured allocation, not monetary cost.',
        renderChartWidget('line', usagePoints, usageSeries),
        h('div', { className: 'insights-panel-stat' }, h('strong', null, formatNumber(totalAic)), h('span', null, 'AIC observed'))),
      insightPanel('Execution health', 'Recent completed workflow-run conclusions.',
        renderChartWidget('swimlane', runPoints, listChartSeries(runPoints)),
        h('dl', { className: 'insights-inline-metrics' },
          metric(completedRuns.length ? `${Math.round((successfulRuns / completedRuns.length) * 100)}%` : '—', 'successful'),
          metric(formatNumber(failedRuns), 'failed'),
          metric(formatNumber(activeRuns), 'active'))),
      insightPanel('Threat detection', 'Usable verdicts remain distinct from unavailable evidence.',
        renderChartWidget('pie', [], [], pieSummary(detectionEntries), 'Observations'),
        h('div', { className: 'insights-panel-stat' }, h('strong', null, usableVerdicts === null ? '—' : `${Math.round(usableVerdicts)}%`), h('span', null, 'usable verdict coverage')))),

    h('section', { className: 'insights-experiment-band', 'aria-labelledby': 'insights-experiments-title' },
      h('div', { className: 'insights-section-heading' },
        h('div', null,
          h('span', { className: 'insights-eyebrow' }, 'Change confidence'),
          h('h2', { id: 'insights-experiments-title' }, 'Experiment decisions'),
          h('p', null, 'Observed decisions and readiness, without treating workflow execution as experiment success.')),
        h('strong', { className: 'insights-decision-count' }, formatNumber(decisionReady), h('small', null, ' decision-ready'))),
      renderChartWidget('bar', entryPoints(experimentEntries), listChartSeries(entryPoints(experimentEntries)))));
}

/**
 * @param {Array<{ x: string, y: number, color: string, key: string, source: Record<string, unknown> }>} points
 * @param {Array<{ name: string, className: string }>} series
 * @param {HTMLElement} chartHost
 */
function renderValueSeriesSelector(points, series, chartHost) {
  const selected = new Set(series.map((item) => item.name));
  const count = h('span', { className: 'insights-series-count' });
  /** @type {HTMLInputElement[]} */
  const inputs = [];
  const update = () => {
    count.textContent = `${selected.size} of ${series.length}`;
    const visibleSeries = series.filter((item) => selected.has(item.name));
    const visiblePoints = points.filter((point) => selected.has(point.color));
    chartHost.replaceChildren(renderChartWidget('line', visiblePoints, visibleSeries));
  };
  const options = series.map((item) => {
    const input = /** @type {HTMLInputElement} */ (h('input', {
      type: 'checkbox',
      checked: true,
      onChange: () => {
        if (input.checked) selected.add(item.name);
        else selected.delete(item.name);
        update();
      }
    }));
    inputs.push(input);
    return h('label', null,
      input,
      h('i', { className: item.className, 'aria-hidden': 'true' }),
      h('span', null, item.name));
  });
  /** @param {boolean} enabled */
  const setAll = (enabled) => {
    selected.clear();
    for (const [index, input] of inputs.entries()) {
      input.checked = enabled;
      if (enabled) selected.add(series[index].name);
    }
    update();
  };
  update();
  return h('details', { className: 'insights-series-selector' },
    h('summary', null, h('span', null, 'Series'), count),
    h('div', { className: 'insights-series-menu' },
      h('div', { className: 'insights-series-actions' },
        h('button', { type: 'button', onClick: () => setAll(true) }, 'All'),
        h('button', { type: 'button', onClick: () => setAll(false) }, 'None')),
      h('fieldset', null, h('legend', null, 'Operational value series'), ...options)));
}

/** @param {string} title @param {string} description @param {...(Node | string | null)} children */
function insightPanel(title, description, ...children) {
  return h('section', { className: 'insights-plot-panel' },
    h('header', null, h('h2', null, title), h('p', null, description)),
    ...children);
}

/** @param {string} value @param {string} label */
function metric(value, label) {
  return h('div', null, h('dt', null, label), h('dd', null, value));
}

/** @param {number[]} values */
function mean(values) {
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

/** @param {unknown} value */
function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/** @param {Record<string, unknown>[]} rows @param {(row: Record<string, unknown>) => string} label */
function counts(rows, label) {
  const totals = new Map();
  for (const row of rows) {
    const key = label(row);
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  return [...totals.entries()].sort((left, right) => right[1] - left[1]);
}

/** @param {Array<[string, number]>} entries */
function sumEntries(entries) {
  return entries.reduce((total, [, value]) => total + value, 0);
}

/** @param {Array<[string, number]>} entries */
function pieSummary(entries) {
  return { entries, total: sumEntries(entries) };
}

/** @param {Array<[string, number]>} entries */
function entryPoints(entries) {
  return entries.map(([label, value], index) => ({ x: label, y: value, color: label, key: `entry-${index}` }));
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {string} dateField
 * @param {(row: Record<string, unknown>) => number} value
 * @param {(row: Record<string, unknown>) => string} series
 */
function dailyPoints(rows, dateField, value, series) {
  const totals = new Map();
  for (const row of rows) {
    const timestamp = Date.parse(String(row[dateField] || ''));
    const amount = value(row);
    if (!Number.isFinite(timestamp) || !Number.isFinite(amount)) continue;
    const day = new Date(timestamp).toISOString().slice(0, 10);
    const color = series(row);
    const key = `${day}:${color}`;
    totals.set(key, { x: `${day}T00:00:00Z`, y: (totals.get(key)?.y ?? 0) + amount, color });
  }
  return [...totals.values()].map((point, index) => ({ ...point, key: `daily-${index}` }));
}