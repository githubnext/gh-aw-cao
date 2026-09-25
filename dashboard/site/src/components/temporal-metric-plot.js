/**
 * Reusable operational-value timeline matching the deterministic report SVG.
 */

import { h } from '../dom.js';

const LEFT = 120;
const RIGHT = 1160;
const TOP = 110;
const BOTTOM = 460;
const WIDTH = RIGHT - LEFT;
const HEIGHT = BOTTOM - TOP;
const MAX_TICKS = 9;

/**
 * @typedef {{ id: string, label: string, points: Array<{ x: string, y: number, key?: string }> }} TemporalMetric
 * @typedef {{ createdAt: string, conclusion: string }} TemporalRun
 */

/**
 * @param {{
 *   title: string,
 *   mode: 'baseline-comparable'|'attainment-only',
 *   adoptionAt: string,
 *   metrics: TemporalMetric[],
 *   runs?: TemporalRun[]
 * }} options
 * @returns {HTMLElement}
 */
export function renderTemporalMetricPlot(options) {
  const metrics = options.metrics.map((metric) => ({
    ...metric,
    points: metric.points
      .filter((point) => Number.isFinite(Date.parse(point.x)) && Number.isFinite(Number(point.y)))
      .toSorted((left, right) => Date.parse(left.x) - Date.parse(right.x))
  })).filter((metric) => metric.points.length > 0);
  const observationTimes = [...new Set(metrics.flatMap((metric) => metric.points.map((point) => point.x)))]
    .toSorted((left, right) => Date.parse(left) - Date.parse(right));
  if (observationTimes.length === 0) {
    return h('p', { className: 'empty-message' }, 'No data is available for this visualization.');
  }

  const firstObservation = observationTimes[0] ?? '';
  const lastObservation = observationTimes.at(-1) ?? firstObservation;
  const start = Date.parse(firstObservation);
  const end = Date.parse(lastObservation);
  const span = Math.max(1, end - start);
  const adoption = Date.parse(options.adoptionAt);
  const showAdoption = Number.isFinite(adoption) && adoption >= start && adoption <= end;
  /** @param {string} time */
  const x = (time) => LEFT + (((Date.parse(time) - start) / span) * WIDTH);
  /** @param {number} value */
  const y = (value) => BOTTOM - (Math.max(0, Math.min(1, Number(value))) * HEIGHT);
  const tickStep = Math.max(1, Math.ceil((observationTimes.length - 1) / (MAX_TICKS - 1)));
  const ticks = observationTimes.filter((_, index) => index % tickStep === 0);
  if (ticks.at(-1) !== lastObservation) ticks.push(lastObservation);
  const legendRows = Math.ceil(metrics.length / 2);
  const legendBottom = 540 + (legendRows * 40);
  const runsTitleY = legendBottom + 62;
  const runsTop = runsTitleY + 18;
  const runsBottom = runsTop + 46;
  const runLegendY = runsBottom + 45;
  const viewBoxHeight = runLegendY + 29;
  const runs = (options.runs ?? []).filter((run) => {
    const time = Date.parse(run.createdAt);
    return Number.isFinite(time) && time >= start && time <= end;
  });
  const modeLabel = options.mode === 'attainment-only' ? 'attainment' : 'value';

  return h('div', { className: 'temporal-metric-plot' },
    h('svg', {
      viewBox: `0 0 1280 ${viewBoxHeight}`,
      role: 'img',
      'aria-label': `${options.title} workflow ${modeLabel} timeline`
    },
    h('title', null, `${options.title} workflow ${modeLabel} timeline`),
    h('desc', null, `Goal-oriented repository outcome metrics ${options.mode === 'attainment-only' ? 'after workflow adoption' : 'before and after workflow adoption'}, with workflow run conclusions over time.`),
    h('text', { x: LEFT, y: 48, className: 'temporal-plot-title' }, `${options.title} ${modeLabel} over time`),
    options.mode === 'baseline-comparable' && showAdoption
      ? h('g', null,
        h('rect', {
          className: 'temporal-plot-baseline',
          x: LEFT,
          y: 78,
          width: Math.max(0, x(options.adoptionAt) - LEFT),
          height: BOTTOM - 78
        }),
        h('text', { x: LEFT + 20, y: 100, className: 'temporal-plot-section' }, 'Pre-adoption baseline'),
        h('text', { x: x(options.adoptionAt) + 18, y: 100, className: 'temporal-plot-section' }, 'Post-adoption history'))
      : h('text', { x: LEFT, y: 100, className: 'temporal-plot-section' },
        options.mode === 'attainment-only' ? 'Post-adoption attainment' : 'Collected history'),
    ...[1, 0.75, 0.5, 0.25, 0].flatMap((value) => [
      h('line', { className: 'temporal-plot-grid', x1: LEFT, y1: y(value), x2: RIGHT, y2: y(value) }),
      h('text', { x: 102, y: y(value) + 6, 'text-anchor': 'end', className: 'temporal-plot-axis' }, String(value))
    ]),
    ...ticks.flatMap((time) => [
      h('line', { className: 'temporal-plot-grid', x1: x(time), y1: TOP, x2: x(time), y2: BOTTOM }),
      h('text', { x: x(time), y: 490, 'text-anchor': 'middle', className: 'temporal-plot-axis' }, formatDate(time))
    ]),
    h('text', {
      transform: 'translate(36 285) rotate(-90)',
      'text-anchor': 'middle',
      className: 'temporal-plot-axis temporal-plot-axis-title'
    }, 'Goal measure'),
    showAdoption ? h('line', {
      className: 'temporal-plot-adoption',
      x1: x(options.adoptionAt),
      y1: 78,
      x2: x(options.adoptionAt),
      y2: BOTTOM,
      'data-chart-temporal-marker': options.adoptionAt
    }) : null,
    ...metrics.flatMap((metric, index) => {
      const className = `chart-series-${(index % 12) + 1}`;
      const legendX = LEFT + ((index % 2) * 520);
      const legendY = 540 + (Math.floor(index / 2) * 40);
      return [
        h('polyline', {
          className: `temporal-plot-metric ${className}`,
          points: metric.points.map((point) => `${x(point.x)},${y(point.y)}`).join(' '),
          fill: 'none',
          'data-temporal-metric': metric.id
        }),
        ...metric.points.map((point) => h('circle', {
          className: `temporal-plot-point ${className}`,
          cx: x(point.x),
          cy: y(point.y),
          r: 6,
          tabIndex: 0,
          role: 'img',
          'aria-label': `${metric.label}: ${point.y} at ${point.x}`
        }, h('title', null, `${metric.label}: ${point.y} at ${point.x}`))),
        h('line', {
          className: `temporal-plot-legend-line ${className}`,
          x1: legendX,
          y1: legendY,
          x2: legendX + 34,
          y2: legendY
        }),
        h('text', { x: legendX + 46, y: legendY + 7, className: 'temporal-plot-legend-label' }, metric.label)
      ];
    }),
    showAdoption ? h('g', { className: 'temporal-plot-adoption-key' },
      h('line', { x1: 640, y1: legendBottom - 20, x2: 674, y2: legendBottom - 20 }),
      h('text', { x: 686, y: legendBottom - 13 }, 'Workflow adopted')) : null,
    h('text', { x: LEFT, y: runsTitleY, className: 'temporal-plot-section temporal-plot-runs-title' }, 'Workflow runs'),
    h('rect', { className: 'temporal-plot-runs-track', x: LEFT, y: runsTop, width: WIDTH, height: 46 }),
    ...runs.map((run) => h('line', {
      className: `temporal-plot-run temporal-plot-run-${runClass(run.conclusion)}`,
      x1: x(run.createdAt),
      y1: runsTop,
      x2: x(run.createdAt),
      y2: runsBottom,
      'aria-hidden': 'true'
    })),
    ...[
      [126, 'success', 'Success'],
      [292, 'failure', 'Failure'],
      [448, 'other', 'Other']
    ].flatMap(([legendX, status, label]) => [
      h('circle', { className: `temporal-plot-run-key temporal-plot-run-${status}`, cx: legendX, cy: runLegendY, r: 6 }),
      h('text', { x: Number(legendX) + 16, y: runLegendY + 7, className: 'temporal-plot-axis' }, label)
    ])));
}

/** @param {string} conclusion */
function runClass(conclusion) {
  if (conclusion === 'success') return 'success';
  if (['failure', 'timed_out', 'cancelled', 'startup-failure'].includes(conclusion)) return 'failure';
  return 'other';
}

/** @param {string} value */
function formatDate(value) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: '2-digit',
    timeZone: 'UTC'
  }).format(new Date(value));
}
