import { h } from '../dom.js';
import { formatNumber } from '../view-formatters.js';
import { finiteNumber, formatCountOf, formatRoundedPercent } from './count-formatters.js';
import { listChartSeries, renderChartLegend, renderChartWidget, renderPieLegend } from './chart-elements.js';
import { renderLazyView } from './lazy-view.js';
import { rowsFor } from './source-rows.js';
import { renderDlRow } from './ui-primitives.js';

const FAILURE_CONCLUSIONS = new Set(['failure', 'timed-out', 'startup-failure', 'action-required']);
const SELECT_POINT_MESSAGE = 'Select a point to inspect that observation.';

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 */
export function renderCampaignOperationalValueHistory(context) {
  const metrics = rowsFor(context.sources, 'campaign-operational-value-series');
  if (metrics.length === 0) {
    return h('section', { className: 'campaign-value-history', 'aria-label': context.title },
      h('p', { className: 'empty-message' }, 'No operational-value extracts were observed for this campaign in the selected horizon.'));
  }

  return h('section', { className: 'campaign-value-history', 'aria-label': context.title },
    h('div', { className: 'insights-section-heading' },
      h('div', null,
        h('span', { className: 'insights-eyebrow' }, 'Selected horizon'),
        h('h2', null, 'Measure and diagnostic history'),
        h('p', null, 'Each measure occupies its own row, preserves every retained extract, keeps workflow series separate, and supports selecting individual observations.'))),
    h('div', { className: 'insights-measure-rows' }, ...metrics.map((metric) => renderMeasureRow(metric))));
}

/**
 * Renders one operational-value measure as a full-width row: a titled and
 * described panel, an axis-labelled time-series plot, and a readout for the
 * currently selected observation.
 * @param {Record<string, unknown>} metric
 * @returns {HTMLElement}
 */
function renderMeasureRow(metric) {
  const points = /** @type {Array<{ x: string, y: number, color: string, key: string }>} */ (
    (Array.isArray(metric.points) ? metric.points : []).slice().sort((left, right) => Date.parse(left.x) - Date.parse(right.x))
  );
  const series = listChartSeries(points);
  const kind = String(metric['metric-kind']);
  const name = String(metric['metric-name'] || metric.metric || 'Metric');
  const title = kind === 'primary' ? humanizeIdentifier(name) : name;
  const chart = renderChartWidget('line', points, series);
  const readout = h('p', { className: 'insights-point-readout', role: 'status' }, SELECT_POINT_MESSAGE);
  attachPointSelection(chart, points, readout);
  return h('section', { className: 'insights-plot-panel insights-measure-row', 'data-metric-kind': kind },
    h('header', null,
      h('h3', null, title),
      h('p', null, describeMeasure(kind, title, points, series.length))),
    h('div', { className: 'insights-measure-plot' },
      h('span', { className: 'insights-axis-label insights-axis-y' }, `${title} (measured value)`),
      h('div', { className: 'insights-measure-canvas' }, chart),
      h('span', { className: 'insights-axis-label insights-axis-x' }, 'Observation time (UTC)')),
    series.length > 1 ? renderChartLegend(series, 'line') : null,
    readout);
}

/**
 * Describes one measure: what it records, how many extracts it retains, how
 * many workflow series it separates, and the observed horizon.
 * @param {string} kind
 * @param {string} title
 * @param {Array<{ x: string, y: number }>} points
 * @param {number} seriesCount
 * @returns {string}
 */
function describeMeasure(kind, title, points, seriesCount) {
  const lead = kind === 'primary'
    ? `Primary operational-value measure “${title}” extracted by this package's workflows.`
    : `Diagnostic measure “${title}” reported alongside the primary operational value.`;
  const extracts = `${formatNumber(points.length)} ${points.length === 1 ? 'extract' : 'extracts'}`;
  const seriesText = `${formatNumber(seriesCount)} workflow series`;
  const first = points[0] ? formatInstant(points[0].x) : '';
  const last = points.length > 1 ? formatInstant(points[points.length - 1].x) : '';
  const horizon = first && last ? ` observed from ${first} to ${last}` : first ? ` observed at ${first}` : '';
  return `${lead} ${extracts} across ${seriesText}${horizon}. The horizontal axis is observation time and the vertical axis is the measured value.`;
}

/**
 * Makes individual time-series points selectable: pointer and keyboard
 * activation toggles one selected observation and reports its time, value,
 * and workflow series in the row readout.
 * @param {HTMLElement} chart
 * @param {Array<{ x: string, y: number, color: string, key: string }>} points
 * @param {HTMLElement} readout
 */
function attachPointSelection(chart, points, readout) {
  const marks = [...chart.querySelectorAll('.chart-point[data-chart-point-key]')];
  if (marks.length === 0) return;
  /** @type {Map<Element, { x: string, y: number, color: string, key: string }>} */
  const pointsByMark = new Map();
  const unmatched = [...points];
  for (const mark of marks) {
    mark.setAttribute('role', 'button');
    mark.setAttribute('aria-pressed', 'false');
    const key = mark.getAttribute('data-chart-point-key');
    const seriesName = mark.getAttribute('data-chart-point-series');
    const index = unmatched.findIndex((point) => point.key === key && point.color === seriesName);
    if (index >= 0) pointsByMark.set(mark, unmatched.splice(index, 1)[0]);
  }
  /** @type {Element | null} */
  let selectedMark = null;
  /** @param {Element} mark */
  const select = (mark) => {
    selectedMark = selectedMark === mark ? null : mark;
    for (const candidate of marks) {
      const pressed = candidate === selectedMark;
      candidate.setAttribute('aria-pressed', pressed ? 'true' : 'false');
      if (pressed) candidate.setAttribute('data-selected', 'true');
      else candidate.removeAttribute('data-selected');
    }
    const point = selectedMark ? pointsByMark.get(selectedMark) : undefined;
    if (!point) {
      readout.replaceChildren(SELECT_POINT_MESSAGE);
      return;
    }
    const seriesLabel = String(mark.getAttribute('data-chart-point-series') || '');
    readout.replaceChildren(...[
      h('strong', null, formatNumber(point.y)),
      h('span', null, formatInstant(point.x)),
      ...(seriesLabel ? [h('span', null, seriesLabel)] : [])
    ]);
  };
  chart.addEventListener('click', (event) => {
    const mark = /** @type {Element | null} */ (event.target instanceof Element ? event.target.closest('.chart-point[data-chart-point-key]') : null);
    if (mark) select(mark);
  });
  chart.addEventListener('keydown', (event) => {
    if (!(event instanceof KeyboardEvent) || (event.key !== 'Enter' && event.key !== ' ')) return;
    const mark = /** @type {Element | null} */ (event.target instanceof Element ? event.target.closest('.chart-point[data-chart-point-key]') : null);
    if (!mark) return;
    event.preventDefault();
    select(mark);
  });
}

/** @param {string} value */
function formatInstant(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? `${new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(timestamp))} UTC`
    : '';
}

/** @param {import('./ui-elements.js').ElementRenderContext} context */
export function renderInsightsOverview(context) {
  const values = rowsFor(context.sources, 'operational-values');
  const outcomes = rowsFor(context.sources, 'outcomes');
  const usage = rowsFor(context.sources, 'usage');
  const runs = rowsFor(context.sources, 'runs');
  const detections = rowsFor(context.sources, 'detection-observations');
  const experiments = rowsFor(context.sources, 'experiments');

  const valuePoints = values.flatMap((row, index) => {
    const value = nativeMetricValue(row['operational-value']);
    const observed = String(row['observed-at'] || '');
    return value !== null && Number.isFinite(Date.parse(observed))
      ? [{ x: observed, y: value, color: String(row['operational-value-definition'] || 'Attainment'), key: `value-${index}`, source: row }]
      : [];
  });
  const valueSeries = listChartSeries(valuePoints);
  const meanValue = mean(valuePoints.map((point) => point.y));
  const acceptedOutcomes = outcomes.filter((row) => String(row['outcome-state']) === 'accepted').length;

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
          h('h2', { id: 'insights-value-title' }, 'Operational value metrics'),
          h('p', null, 'Native gh-aw metrics and accepted repository outcomes, without inferring unsupported ROI.')),
        h('dl', { className: 'insights-lead-metrics' },
          renderDlRow('mean primary value', meanValue === null ? '' : formatNumber(meanValue)),
          renderDlRow('accepted outcomes', formatNumber(acceptedOutcomes)),
          renderDlRow('metric observations', formatNumber(valuePoints.length)))),
      valueSeries.length > 1 ? renderValueSeriesSelector(valuePoints, valueSeries, valueChart) : null,
      valueChart),

    h('div', { className: 'insights-plot-grid' },
      insightPanel('Outcome disposition', 'What happened to retained outputs.',
        renderChartWidget('pie', [], [], pieSummary(outcomeEntries), 'Outcomes'),
        renderPieLegend(outcomeEntries, sumEntries(outcomeEntries))),
      renderLazyPanel('AI Credit allocation', () => insightPanel('AI Credit allocation', 'Daily measured allocation, not monetary cost.',
        renderChartWidget('line', usagePoints, usageSeries),
        h('div', { className: 'insights-panel-stat' }, h('strong', null, usage.length > 0 ? formatNumber(totalAic) : ''), h('span', null, 'AIC observed')))),
      renderLazyPanel('Execution health', () => insightPanel('Execution health', 'Recent completed workflow-run conclusions.',
        renderChartWidget('swimlane', runPoints, listChartSeries(runPoints)),
        h('dl', { className: 'insights-inline-metrics' },
          renderDlRow('successful', completedRuns.length ? formatRoundedPercent(successfulRuns / completedRuns.length) : ''),
          renderDlRow('failed', formatNumber(failedRuns)),
          renderDlRow('active', formatNumber(activeRuns))))),
      renderLazyPanel('Threat detection', () => insightPanel('Threat detection', 'Usable verdicts remain distinct from unavailable evidence.',
        renderChartWidget('pie', [], [], pieSummary(detectionEntries), 'Observations'),
        h('div', { className: 'insights-panel-stat' }, h('strong', null, usableVerdicts === null ? '' : `${Math.round(usableVerdicts)}%`), h('span', null, 'usable verdict coverage'))))),

    renderLazyPanel('Experiment decisions', () => h('section', { className: 'insights-experiment-band', 'aria-labelledby': 'insights-experiments-title' },
      h('div', { className: 'insights-section-heading' },
        h('div', null,
          h('span', { className: 'insights-eyebrow' }, 'Change confidence'),
          h('h2', { id: 'insights-experiments-title' }, 'Experiment decisions'),
          h('p', null, 'Observed decisions and readiness, without treating workflow execution as experiment success.')),
        h('strong', { className: 'insights-decision-count' }, formatNumber(decisionReady), h('small', null, ' decision-ready'))),
      renderChartWidget('bar', entryPoints(experimentEntries), listChartSeries(entryPoints(experimentEntries)))), 220));
}

/**
 * Renders a secondary insights panel lazily, deferring chart/table hydration until
 * it nears the viewport, is disclosed, or receives keyboard focus.
 * @param {string} label
 * @param {() => HTMLElement} render
 * @param {number} [minHeight]
 * @returns {HTMLElement}
 */
function renderLazyPanel(label, render, minHeight = 260) {
  return renderLazyView({ label, headingLevel: 'h4', minHeight, render });
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
    count.textContent = formatCountOf(selected.size, series.length);
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

/** @param {string} value */
function humanizeIdentifier(value) {
  const words = value.replaceAll(/[-_]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Operational value';
}

/** @param {unknown} value */
function nativeMetricValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** @param {number[]} values */
function mean(values) {
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) / values.length : null;
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