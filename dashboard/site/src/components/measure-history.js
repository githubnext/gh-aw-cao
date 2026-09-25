/**
 * Reusable grouped temporal-measure history.
 */

import { h } from '../dom.js';
import { formatNumber } from '../view-formatters.js';
import { renderStatusBadge } from './badge.js';
import { listChartSeries, renderChartLegend, renderChartWidget } from './chart-elements.js';
import { rowsFor } from './source-rows.js';
import { renderTemporalMetricPlot } from './temporal-metric-plot.js';

const SELECT_POINT_MESSAGE = 'Select a point to inspect that observation.';

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
    return h('section', { className: 'measure-history', 'aria-label': context.title },
      h('p', { className: 'empty-message' }, context.elementConfig?.['empty-message'] ?? 'No measure history was observed in the selected horizon.'));
  }
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
  const repositories = new Set(rows.flatMap((row) => (
    Array.isArray(row.points) ? row.points.map((point) => String(point.color || '')) : []
  )).filter(Boolean));
  const metrics = rows.flatMap((row) => {
    const points = Array.isArray(row.points) ? row.points : [];
    /** @type {Map<string, Record<string, unknown>[]>} */
    const byRepository = new Map();
    for (const point of points) {
      const repository = String(point.color || 'Repository');
      byRepository.set(repository, [...(byRepository.get(repository) ?? []), point]);
    }
    const name = String(row['operational-value-name'] || row['metric-name'] || row.metric || 'Metric');
    return [...byRepository].map(([repository, repositoryPoints]) => ({
      id: `${String(row.metric || name)}:${repository}`,
      label: repositories.size > 1 ? `${name} · ${repository}` : name,
      points: repositoryPoints.map((point) => ({
        x: String(point.x),
        y: Number(point.y),
        key: String(point.key || '')
      }))
    }));
  });
  const first = rows[0] ?? {};
  const adoptionAt = String(first['adoption-at'] || '');
  const mode = first['evaluation-mode'] === 'attainment-only'
    ? 'attainment-only'
    : 'baseline-comparable';
  const workflowName = String(first['workflow-name'] || context.title || 'Operational value');
  const maturityStatuses = [...new Set(rows.map((row) => String(row['maturity-status'] || 'matured')))];
  const dubious = maturityStatuses.some((status) => status !== 'matured');
  const runSource = context.sourceNames[1] ?? '';
  const runs = rowsFor(context.sources, runSource).map((run) => ({
    createdAt: String(run['started-at'] || ''),
    conclusion: String(run.status || run['run-status'] || 'unknown')
  }));

  return h('section', { className: 'measure-history', 'aria-label': context.title },
    h('div', { className: 'insights-section-heading' },
      h('div', null,
        h('span', { className: 'insights-eyebrow' }, 'Selected horizon'),
        h('div', { className: 'insights-measure-heading' },
          h('h2', null, 'Repository operational-value history'),
          dubious
            ? h('span', { className: 'insights-dubious-flag' },
              h('span', null, 'Dubious'),
              renderStatusBadge(maturityStatuses.join(', ')))
            : null),
        h('p', null, 'Goal-oriented measures before and after adoption, followed by workflow run conclusions over the same temporal horizon. Interim evidence remains visible and marked dubious until it matures.'))),
    h('div', { className: 'insights-plot-panel insights-temporal-plot-panel' },
      renderTemporalMetricPlot({
        title: workflowName,
        mode,
        adoptionAt,
        metrics,
        runs
      })));
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
  const normalized = value.replaceAll(/[-_.]+/g, ' ').trim();
  return normalized ? `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}` : 'Metric';
}
