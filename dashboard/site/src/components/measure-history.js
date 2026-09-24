/**
 * Reusable grouped temporal-measure history.
 */

import { h } from '../dom.js';
import { formatNumber } from '../view-formatters.js';
import { listChartSeries, renderChartLegend, renderChartWidget } from './chart-elements.js';
import { rowsFor } from './source-rows.js';

const SELECT_POINT_MESSAGE = 'Select a point to inspect that observation.';

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 */
export function renderMeasureHistory(context) {
  const sourceName = context.sourceNames[0] ?? '';
  const metrics = rowsFor(context.sources, sourceName);
  if (metrics.length === 0) {
    return h('section', { className: 'measure-history', 'aria-label': context.title },
      h('p', { className: 'empty-message' }, context.elementConfig?.['empty-message'] ?? 'No measure history was observed in the selected horizon.'));
  }

  return h('section', { className: 'measure-history', 'aria-label': context.title },
    h('div', { className: 'insights-section-heading' },
      h('div', null,
        h('span', { className: 'insights-eyebrow' }, 'Selected horizon'),
        h('h2', null, 'Measure and diagnostic history'),
        h('p', null, 'Each measure occupies its own row, preserves every retained extract, keeps workflow series separate, and supports selecting individual observations.'))),
    h('div', { className: 'insights-measure-rows' }, ...metrics.map((metric) => renderMeasureRow(metric))));
}

/**
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
 * @param {string} kind
 * @param {string} title
 * @param {Array<{ x: string, y: number }>} points
 * @param {number} seriesCount
 * @returns {string}
 */
function describeMeasure(kind, title, points, seriesCount) {
  const lead = kind === 'primary'
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
    const seriesLabel = String(selectedMark?.getAttribute('data-chart-point-series') || '');
    readout.replaceChildren(
      h('strong', null, formatNumber(point.y)),
      h('span', null, formatInstant(point.x)),
      ...(seriesLabel ? [h('span', null, seriesLabel)] : [])
    );
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

/** @param {string} value */
function humanizeIdentifier(value) {
  const normalized = value.replaceAll(/[-_]+/g, ' ').trim();
  return normalized ? `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}` : 'Metric';
}
