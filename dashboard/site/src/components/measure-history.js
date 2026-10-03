/**
 * Reusable grouped temporal-measure history.
 */

import { h } from '../dom.js';
import { createDebug } from '../debug.js';
import { effect, render, state } from '../reactive.js';
import { formatNumber } from '../view-formatters.js';
import { renderStatusBadge } from './badge.js';
import { bindFactorySources, createFactoryScope } from './factory-elements.js';
import { listChartSeries, renderChartLegend, renderChartWidget } from './chart-elements.js';
import { rowsFor } from './source-rows.js';
import { renderTemporalMetricPlot } from './temporal-metric-plot.js';
import { formatMediumUtcDateTimeWithSuffix, renderLoadingMessage, renderVisualizationEmptyMessage } from './ui-primitives.js';

const debugMeasureHistory = createDebug('measure-history');

const SELECT_POINT_MESSAGE = 'Select a point to inspect that observation.';

/**
 * Keeps the operational-value plot independent of the campaign route shell.
 * Each declared source is bound to its own worker query and the owned root is
 * updated only when a source used by this element changes.
 * @param {import('./ui-elements.js').ElementRenderContext} context
 */
export function renderBoundMeasureHistory(context) {
  if (context.routeParameter && !context.routeParameters?.[context.routeParameter]) {
    return h('section', { className: 'measure-history', 'aria-label': context.title },
      renderVisualizationEmptyMessage('Select a campaign to view its operational value.'));
  }
  const bindings = bindFactorySources(context.sources, context.sourceNames, {
    pageId: context.pageId,
    viewId: context.viewId,
    viewIndex: context.viewIndex,
    sourceNames: context.sourceNames,
    routeParameters: context.routeParameters,
    queryContext: context.queryContext
  }, { refreshViewSources: true });
  const scope = createFactoryScope();
  const root = h('div', { className: 'measure-history-bound' });
  render(root, () => {
    const sources = /** @type {Record<string, import('../presenter.js').LogicalSourceInput>} */ ({});
    for (const name of context.sourceNames) {
      const source = bindings[name].source();
      if (source) sources[name] = source;
    }
    const series = bindings[context.sourceNames[0]];
    if (series?.pending() && !series.source()) return renderLoadingMessage('Loading repository operational value...');
    if (series?.unavailable()) return renderVisualizationEmptyMessage('Repository operational-value evidence is unavailable.');
    return renderMeasureHistory({ ...context, sources });
  }, { signal: scope.signal });
  scope.bind(root);
  return root;
}

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   unit: string,
 *   direction: 'increase'|'decrease'|'maintain'|'target',
 *   points: Array<{ x: string, y: number, key: string }>
 * }} OperationalValueSeries
 * @typedef {{
 *   id: string,
 *   label: string,
 *   series: Map<string, OperationalValueSeries>
 * }} OperationalValueMetricGroup
 */

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 */
export function renderMeasureHistory(context) {
  const sourceName = context.sourceNames[0] ?? '';
  const metrics = rowsFor(context.sources, sourceName);
  const measureSource = context.elementConfig?.['measure-source'] === 'operational-value'
    ? 'operational-value'
    : 'operational-grader';
  if (metrics.length === 0) {
    debugMeasureHistory({ measureSource, metricCount: 0, status: 'empty' });
    return h('section', { className: 'measure-history', 'aria-label': context.title },
      renderVisualizationEmptyMessage(context.elementConfig?.['empty-message'] ?? 'No measure history was observed in the selected horizon.'));
  }
  debugMeasureHistory({ measureSource, metricCount: metrics.length, status: 'rendered' });
  if (measureSource === 'operational-value') {
    return renderOperationalValueHistory(context, metrics);
  }

  return h('section', { className: 'measure-history', 'aria-label': context.title },
    h('div', { className: 'insights-section-heading' },
      h('div', null,
        h('span', { className: 'insights-eyebrow' }, 'Selected horizon'),
        h('h2', null, 'Measure and diagnostic history'),
        h('p', null, 'Each measure occupies its own row, preserves every retained extract, keeps workflow series separate, and supports selecting individual observations.'))),
    h('div', { className: 'insights-measure-rows' }, ...metrics.map((metric) => renderMeasureRow(metric, measureSource))));
}

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @param {Record<string, unknown>[]} rows
 */
function renderOperationalValueHistory(context, rows) {
  const metricGroups = operationalValueMetricGroups(rows);
  const first = rows[0] ?? {};
  const adoptionAt = String(first['adoption-at'] || '');
  const mode = first['evaluation-mode'] === 'attainment-only'
    ? 'attainment-only'
    : 'baseline-comparable';
  const campaignOutcomeSource = context.sourceNames[1] ?? '';
  const evidenceStateSource = context.sourceNames[2] ?? '';
  const campaignOutcomes = outcomeContext(rowsFor(context.sources, campaignOutcomeSource));
  const evidenceState = rowsFor(context.sources, evidenceStateSource)[0] ?? {};
  const fallbackObservationCount = rows.reduce(
    (total, row) => total + (Array.isArray(row.points) ? row.points.length : 0),
    0
  );
  const fallbackMaturedObservationCount = rows.reduce(
    (total, row) => total + (row['maturity-status'] === 'matured' && Array.isArray(row.points)
      ? row.points.length
      : 0),
    0
  );
  const observationCount = Object.hasOwn(evidenceState, 'observation-count')
    ? Number(evidenceState['observation-count']) || 0
    : fallbackObservationCount;
  const maturedObservationCount = Object.hasOwn(evidenceState, 'matured-observation-count')
    ? Number(evidenceState['matured-observation-count']) || 0
    : fallbackMaturedObservationCount;
  const onlyInterimEvidence = evidenceState['evidence-state'] === 'interim-evidence'
    || (!evidenceState['evidence-state'] && observationCount > 0 && maturedObservationCount === 0);
  const panels = metricGroups.map((group) => h('div', {
      className: 'insights-plot-panel insights-temporal-plot-panel',
      'data-operational-value-metric': group.id,
      'data-operational-value-state': onlyInterimEvidence
        ? 'interim-evidence'
        : 'observed-value'
    },
    renderTemporalMetricPlot({
        title: group.label,
        mode,
        adoptionAt,
        metrics: group.series,
        outcomes: campaignOutcomes,
        provisional: onlyInterimEvidence
      }),
    group.series.length > 1
      ? renderChartLegend(group.series.map((series, index) => ({
        name: series.label,
        className: `chart-series-${(index % 12) + 1}`
      })), 'line')
      : null));

  return h('section', { className: 'measure-history measure-history-operational-value', 'aria-label': context.title },
    h('div', { className: 'insights-section-heading' },
      h('div', null,
        h('div', { className: 'insights-measure-heading' },
          h('h2', null, 'Operational value')),
        h('p', null, onlyInterimEvidence
          ? `${formatNumber(observationCount)} interim observations. Dashed amber lines are not mature evidence.`
          : 'Repository-level evidence only. Each metric compares repository series directly; campaign rollups are omitted so anomalies remain visible.'))),
    ...panels);
}

/**
 * @param {Record<string, unknown>[]} rows
 */
function operationalValueMetricGroups(rows) {
  /** @type {Map<string, OperationalValueMetricGroup>} */
  const groups = new Map();
  for (const row of rows) {
    const points = /** @type {Array<Record<string, unknown>>} */ (
      Array.isArray(row.points) ? row.points : []
    );
    const name = String(row['operational-value-name'] || row['metric-name'] || row.metric || 'Metric');
    const metricId = String(row.metric || name);
    const group = groups.get(metricId) ?? {
      id: metricId,
      label: name,
      series: new Map()
    };
    for (const point of points) {
      const repository = String(point.color || row.repository || '');
      if (!repository) continue;
      const series = group.series.get(repository) ?? {
        id: `${metricId}:${repository}`,
        label: repository,
        unit: String(row['operational-value-unit'] || 'value'),
        direction: /** @type {'increase'|'decrease'|'maintain'|'target'} */ (
          ['increase', 'decrease', 'maintain', 'target'].includes(String(row['operational-value-direction']))
            ? row['operational-value-direction']
            : 'increase'
        ),
        points: []
      };
      series.points.push({
        x: String(point.x),
        y: Number(point.y),
        key: String(point.key || '')
      });
      group.series.set(repository, series);
    }
    groups.set(metricId, group);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      series: [...group.series.values()].toSorted((left, right) => left.label.localeCompare(right.label))
    }))
    .toSorted((left, right) => left.label.localeCompare(right.label));
}

/**
 * @param {Record<string, unknown>[]} rows
 */
function outcomeContext(rows) {
  return rows.flatMap((row) => {
    const date = String(row['run-day'] || '');
    const successfulRuns = Number(row['successful-runs']);
    const failedRuns = Number(row['failed-runs']);
    const successRate = Number(row['success-rate-percent']);
    const concludedRuns = Number(row['concluded-runs']);
    return Number.isFinite(Date.parse(date))
      && Number.isFinite(successfulRuns)
      && Number.isFinite(failedRuns)
      && Number.isFinite(successRate)
      && Number.isFinite(concludedRuns)
      ? [{ date, successfulRuns, failedRuns, successRate, concludedRuns }]
      : [];
  }).toSorted((left, right) => Date.parse(left.date) - Date.parse(right.date));
}

/**
 * @param {Record<string, unknown>} metric
 * @param {'operational-value'|'operational-grader'} measureSource
 * @returns {HTMLElement}
 */
function renderMeasureRow(metric, measureSource) {
  const points = /** @type {Array<{ x: string, y: number, color: string, key: string }>} */ (
    (Array.isArray(metric.points) ? metric.points : []).slice().sort((left, right) => Date.parse(left.x) - Date.parse(right.x))
  );
  const series = listChartSeries(points);
  const kind = String(measureSource === 'operational-value'
    ? metric['operational-value-role'] || metric['metric-kind']
    : metric['metric-kind']);
  const name = String(measureSource === 'operational-value'
    ? metric['operational-value-name'] || metric['metric-name'] || metric.metric || 'Metric'
    : metric['metric-name'] || metric.metric || 'Metric');
  const title = kind === 'primary' ? humanizeIdentifier(name) : name;
  const maturityStatus = String(metric['maturity-status'] || '');
  const dubious = measureSource === 'operational-value' && maturityStatus !== 'matured';
  const adoptionAt = String(metric['adoption-at'] || '');
  const chart = renderChartWidget(
    'line',
    points,
    series,
    null,
    'Total',
    null,
    null,
    null,
    (label) => label,
    measureSource === 'operational-value' && Number.isFinite(Date.parse(adoptionAt))
      ? { at: adoptionAt, label: 'Workflow adopted' }
      : null
  );
  const readout = h('p', { className: 'insights-point-readout', role: 'status' }, SELECT_POINT_MESSAGE);
  attachPointSelection(chart, points, readout);
  return h('section', { className: 'insights-plot-panel insights-measure-row', 'data-metric-kind': kind },
    h('header', null,
      h('div', { className: 'insights-measure-heading' },
        h('h3', null, title),
        dubious
          ? h('span', { className: 'insights-dubious-flag' },
            h('span', null, 'Dubious'),
            renderStatusBadge(maturityStatus || 'interim'))
          : null),
      h('p', null, describeMeasure(kind, title, points, series.length, measureSource, maturityStatus))),
    h('div', { className: 'insights-measure-plot' },
      h('span', { className: 'insights-axis-label insights-axis-y' }, `${title} (measured value)`),
      h('div', { className: 'insights-measure-canvas' }, chart),
      h('span', { className: 'insights-axis-label insights-axis-x' }, 'Observation time (UTC)')),
    series.length > 1 ? renderChartLegend(series, 'line') : null,
    readout);
}

/**
 * @param {string} kind
 * @param {string} title
 * @param {Array<{ x: string, y: number }>} points
 * @param {number} seriesCount
 * @param {'operational-value'|'operational-grader'} measureSource
 * @param {string} maturityStatus
 * @returns {string}
 */
function describeMeasure(kind, title, points, seriesCount, measureSource, maturityStatus) {
  const lead = measureSource === 'operational-value'
    ? `Repository operational-value measure “${title}”.${maturityStatus && maturityStatus !== 'matured' ? ` Its ${maturityStatus} observations are provisional lower bounds, not verified attainment.` : ''}`
    : kind === 'primary'
      ? `Primary operational-grader measure “${title}” extracted from this package's workflow runs.`
      : `Diagnostic measure “${title}” reported alongside the primary operational grader.`;
  const extracts = `${formatNumber(points.length)} ${points.length === 1 ? 'extract' : 'extracts'}`;
  const seriesText = `${formatNumber(seriesCount)} workflow series`;
  const first = points[0] ? formatInstant(points[0].x) : '';
  const last = points.length > 1 ? formatInstant(points[points.length - 1].x) : '';
  const horizon = first && last ? ` observed from ${first} to ${last}` : first ? ` observed at ${first}` : '';
  return `${lead} ${extracts} across ${seriesText}${horizon}. The horizontal axis is observation time and the vertical axis is the measured value.`;
}

/**
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
    const key = mark.getAttribute('data-chart-point-key');
    const seriesName = mark.getAttribute('data-chart-point-series');
    const index = unmatched.findIndex((point) => point.key === key && point.color === seriesName);
    if (index >= 0) pointsByMark.set(mark, unmatched.splice(index, 1)[0]);
  }
  /** @type {import('../reactive.js').State<Element | null>} */
  const selectedMark = state(/** @type {Element | null} */ (null));

  // The smallest DOM update needed from selection state: toggle each mark's
  // pressed/selected attributes and resync the shared readout text.
  effect(() => {
    const selected = selectedMark.get();
    for (const candidate of marks) {
      const pressed = candidate === selected;
      candidate.setAttribute('aria-pressed', pressed ? 'true' : 'false');
      if (pressed) candidate.setAttribute('data-selected', 'true');
      else candidate.removeAttribute('data-selected');
    }
    const point = selected ? pointsByMark.get(selected) : undefined;
    debugMeasureHistory({ event: 'point-selection', selected: Boolean(point) });
    if (!point) {
      readout.replaceChildren(SELECT_POINT_MESSAGE);
      return;
    }
    const seriesLabel = String(selected?.getAttribute('data-chart-point-series') || '');
    readout.replaceChildren(
      h('strong', null, formatNumber(point.y)),
      h('span', null, formatInstant(point.x)),
      ...(seriesLabel ? [h('span', null, seriesLabel)] : [])
    );
  });

  /** @param {Element} mark */
  const select = (mark) => {
    selectedMark.set((current) => (current === mark ? null : mark));
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
  return Number.isFinite(timestamp) ? formatMediumUtcDateTimeWithSuffix(timestamp) : '';
}

/** @param {string} value */
function humanizeIdentifier(value) {
  const normalized = value.replaceAll(/[-_.]+/g, ' ').trim();
  return normalized ? `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}` : 'Metric';
}
