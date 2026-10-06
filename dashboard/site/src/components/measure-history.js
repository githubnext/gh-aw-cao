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
import { findLink } from './link-content.js';
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
  const selectedRoute = context.routeParameter ? context.routeParameters?.[context.routeParameter] : '';
  if (context.routeParameter && !selectedRoute) {
    return h('section', { className: 'measure-history', 'aria-label': context.title },
      renderVisualizationEmptyMessage('Select a campaign to view its operational value.'));
  }
  const bindings = bindFactorySources({}, context.sourceNames, {
    pageId: context.pageId,
    viewId: context.viewId,
    viewIndex: context.viewIndex,
    sourceNames: context.sourceNames,
    routeParameters: context.routeParameters,
    queryContext: context.queryContext
  }, { bindingScope: selectedRoute });
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
 *   points: Array<{ x: string, y: number, key: string, link?: Record<string, unknown> }>
 * }} OperationalValueSeries
 */

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 */
export function renderMeasureHistory(context) {
  const sourceName = context.sourceNames[0] ?? '';
  const metrics = context.sources[sourceName]?.rows ?? [];
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
  const campaignOutcomeSource = context.sourceNames[1] ?? '';
  const evidenceStateSource = context.sourceNames[2] ?? '';
  const campaignOutcomes = /** @type {import('./temporal-metric-plot.js').OutcomeContext[]} */ (
    context.sources[campaignOutcomeSource]?.rows ?? []
  );
  const evidenceState = context.sources[evidenceStateSource]?.rows[0];
  const state = String(evidenceState?.['evidence-state'] || 'unavailable');
  const observationCount = Number(evidenceState?.['observation-count']);
  if (state === 'interim-evidence' && !Number.isFinite(observationCount)) {
    debugMeasureHistory({ event: 'observation-count-unavailable' });
  }
  const panels = rows.map((row) => {
    const label = String(row['operational-value-name'] || row['metric-name'] || row.metric);
    const series = /** @type {OperationalValueSeries[]} */ (Array.isArray(row.series) ? row.series : []);
    const metrics = series.map((entry) => ({
      ...entry,
      unit: String(row['operational-value-unit'] || 'value'),
      direction: /** @type {'increase'|'decrease'|'maintain'|'target'} */ (row['operational-value-direction']),
      points: entry.points.map((point) => ({ ...point, link: findLink(point, 'link') }))
    }));
    return h('div', {
      className: 'insights-plot-panel insights-temporal-plot-panel',
      'data-operational-value-metric': String(row.metric),
      'data-operational-value-state': state
    },
    renderTemporalMetricPlot({
        title: label,
        mode: row['evaluation-mode'] === 'attainment-only' ? 'attainment-only' : 'baseline-comparable',
        adoptionAt: String(row['adoption-at'] || ''),
        metrics,
        outcomes: campaignOutcomes,
        provisional: state !== 'observed-value',
        connectPoints: false
      }),
    series.length > 1
      ? renderChartLegend(series.map((series, index) => ({
        name: series.label,
        className: `chart-series-${(index % 12) + 1}`
      })), 'dot')
      : null);
  });

  return h('section', { className: 'measure-history measure-history-operational-value', 'aria-label': context.title },
    h('div', { className: 'insights-section-heading' },
      h('div', null,
        h('div', { className: 'insights-measure-heading' },
          h('h2', null, 'Operational value')),
        h('p', null, state === 'unavailable'
          ? 'Operational-value maturity evidence is unavailable. Observations are provisional.'
          : state === 'interim-evidence'
            ? `${Number.isFinite(observationCount) ? `${formatNumber(observationCount)} interim` : 'Interim'} observations in each measure’s native units. Amber points are not mature evidence.`
            : 'Repository-level observations in each measure’s native units; campaign rollups are omitted so anomalies remain visible. Points are not connected across missing observations.'))),
    ...panels);
}

/**
 * @param {Record<string, unknown>} metric
 * @param {'operational-value'|'operational-grader'} measureSource
 * @returns {HTMLElement}
 */
function renderMeasureRow(metric, measureSource) {
  const points = /** @type {Array<{ x: string, y: number, color: string, key: string }>} */ (
    Array.isArray(metric.points) ? metric.points : []
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
  const scope = createFactoryScope();
  scope.bind(chart);

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
  }, { signal: scope.signal });

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
