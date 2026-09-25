/**
 * Reusable grouped temporal-measure history.
 */

import { h } from '../dom.js';
import { effect, state } from '../reactive.js';
import { formatNumber } from '../view-formatters.js';
import { renderStatusBadge } from './badge.js';
import { listChartSeries, renderChartLegend, renderChartWidget } from './chart-elements.js';
import { rowsFor } from './source-rows.js';
import { renderTemporalMetricPlot } from './temporal-metric-plot.js';

const SELECT_POINT_MESSAGE = 'Select a point to inspect that observation.';

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   description: string,
 *   rows: Record<string, unknown>[],
 *   repository: string | null
 * }} OperationalValueScope
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
  const repositories = [...new Set(rows.flatMap((row) => (
    Array.isArray(row.points) ? row.points.map((point) => String(point.color || '')) : []
  )).filter(Boolean))].toSorted();
  const rollupSource = context.sourceNames[1] ?? '';
  const rollupRows = rowsFor(context.sources, rollupSource);
  const contributingRepositories = repositories.length;
  const scopes = /** @type {OperationalValueScope[]} */ ([
    ...(rollupRows.length > 0 ? [{
      id: 'campaign-rollup',
      label: 'Campaign rollup',
      description: `${formatNumber(contributingRepositories)} ${contributingRepositories === 1 ? 'repository' : 'repositories'} · weighted by eligible evidence`,
      rows: rollupRows,
      repository: null
    }] : []),
    ...repositories.map((repository) => ({
      id: `repository:${repository}`,
      label: repository,
      description: repository,
      rows,
      repository
    }))
  ]);
  const first = rollupRows[0] ?? rows[0] ?? {};
  const adoptionAt = String(first['adoption-at'] || '');
  const mode = first['evaluation-mode'] === 'attainment-only'
    ? 'attainment-only'
    : 'baseline-comparable';
  const campaignOutcomeSource = context.sourceNames[2] ?? '';
  const hasRepositoryOutcomeSource = context.sourceNames.length >= 5;
  const repositoryOutcomeSource = hasRepositoryOutcomeSource ? context.sourceNames[3] ?? '' : '';
  const evidenceStateSource = hasRepositoryOutcomeSource
    ? context.sourceNames[4] ?? ''
    : context.sourceNames[3] ?? '';
  const campaignOutcomes = outcomeContext(rowsFor(context.sources, campaignOutcomeSource));
  const repositoryOutcomeRows = rowsFor(context.sources, repositoryOutcomeSource);
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
  const selectedScope = state(scopes[0]?.id ?? '');
  const selector = /** @type {HTMLSelectElement} */ (h('select', {
    className: 'operational-value-scope-select',
    'aria-label': 'Operational value repository scope'
  }, ...scopes.map((scope) => h('option', { value: scope.id }, scope.label))));
  const scopeStatus = h('p', {
    className: 'operational-value-scope-status',
    role: 'status'
  });
  const panels = new Map(scopes.map((scope) => {
    const scopeMetrics = metricsForOperationalValueScope(scope);
    const outcomes = scope.repository === null
      ? campaignOutcomes
      : outcomeContext(repositoryOutcomeRows.filter(
        (row) => String(row.repository || '') === scope.repository
      ));
    return [scope.id, h('div', {
      className: 'insights-plot-panel insights-temporal-plot-panel',
      'data-operational-value-scope': scope.id,
      'data-operational-value-state': onlyInterimEvidence
        ? 'interim-evidence'
        : 'observed-value'
    },
    h('div', { className: 'operational-value-native-plots' },
      ...scopeMetrics.map((metric) => renderTemporalMetricPlot({
        title: metric.label,
        mode,
        adoptionAt,
        metrics: [metric],
        outcomes,
        trend: metric.trend,
        provisional: onlyInterimEvidence
      }))))];
  }));
  const lifetime = new AbortController();
  selector.addEventListener('change', () => selectedScope.set(selector.value), {
    signal: lifetime.signal
  });

  const root = h('section', { className: 'measure-history', 'aria-label': context.title },
    h('div', { className: 'insights-section-heading' },
      h('div', null,
        h('div', { className: 'insights-measure-heading' },
          h('h2', null, 'Operational value')),
        h('p', null, onlyInterimEvidence
          ? `${formatNumber(observationCount)} interim observations. Dashed amber lines are not mature evidence.`
          : 'Campaign rollup by eligible evidence. Choose a repository for detail.')),
      h('label', { className: 'operational-value-scope-control' },
        h('span', null, 'Repository scope'),
        selector)),
    scopeStatus,
    ...panels.values());
  effect(() => {
    const activeScope = selectedScope.get();
    selector.value = activeScope;
    for (const [scopeId, panel] of panels) panel.hidden = scopeId !== activeScope;
    scopeStatus.textContent = scopes.find((scope) => scope.id === activeScope)?.description ?? '';
  }, { signal: lifetime.signal });
  let wasConnected = root.isConnected;
  const observer = new MutationObserver(() => {
    if (root.isConnected) wasConnected = true;
    if (wasConnected && !root.isConnected) {
      observer.disconnect();
      lifetime.abort();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  return root;
}

/**
 * @param {OperationalValueScope} scope
 */
function metricsForOperationalValueScope(scope) {
  return scope.rows.flatMap((row) => {
    const points = /** @type {Array<Record<string, unknown>>} */ (
      Array.isArray(row.points) ? row.points : []
    ).filter((point) => scope.repository === null || String(point.color || '') === scope.repository);
    const name = String(row['operational-value-name'] || row['metric-name'] || row.metric || 'Metric');
    return points.length === 0 ? [] : [{
      id: `${String(row.metric || name)}:${scope.id}`,
      label: name,
      unit: String(row['operational-value-unit'] || 'value'),
      direction: /** @type {'increase'|'decrease'|'maintain'|'target'} */ (
        ['increase', 'decrease', 'maintain', 'target'].includes(String(row['operational-value-direction']))
          ? row['operational-value-direction']
          : 'increase'
      ),
      trend: {
        startValue: Number(row['trend-start-value']),
        endValue: Number(row['trend-end-value']),
        delta: Number(row['trend-delta']),
        relativePercent: row['trend-relative-percent'] === null
          ? null
          : Number(row['trend-relative-percent']),
        observedDirection: String(row['trend-observed-direction'] || 'flat'),
        assessment: String(row['trend-assessment'] || 'insufficient'),
        observationCount: Number(row['trend-observation-count']) || 0
      },
      points: points.map((point) => ({
        x: String(point.x),
        y: Number(point.y),
        key: String(point.key || '')
      }))
    }];
  });
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
