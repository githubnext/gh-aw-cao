/**
 * Compact operational-value small multiples and aligned run-success context.
 */

import { h } from '../dom.js';

const LEFT = 92;
const RIGHT = 1180;
const TOP = 24;
const BOTTOM = 286;
const WIDTH = RIGHT - LEFT;
const HEIGHT = BOTTOM - TOP;
const SUCCESS_Y = 306;
const MAX_TICKS = 5;

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   unit?: string,
 *   direction?: 'increase'|'decrease'|'maintain'|'target',
 *   points: Array<{ x: string, y: number, key?: string }>
 * }} TemporalMetric
 * @typedef {{ date: string, successfulRuns: number, failedRuns: number, successRate: number, concludedRuns: number }} OutcomeContext
 * @typedef {{
 *   startValue: number,
 *   endValue: number,
 *   delta: number,
 *   relativePercent: number|null,
 *   observedDirection: string,
 *   assessment: string,
 *   observationCount: number
 * }} TemporalTrend
 */

/**
 * @param {{
 *   title: string,
 *   mode: 'baseline-comparable'|'attainment-only',
 *   adoptionAt: string,
 *   metrics: TemporalMetric[],
 *   outcomes?: OutcomeContext[],
 *   trend?: TemporalTrend,
 *   provisional?: boolean
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
  const values = metrics.flatMap((metric) => metric.points.map((point) => Number(point.y)));
  const observedMinimum = Math.min(...values);
  const observedMaximum = Math.max(...values);
  const observedSpan = observedMaximum - observedMinimum;
  const padding = observedSpan > 0
    ? observedSpan * 0.1
    : Math.max(Math.abs(observedMaximum) * 0.1, 1);
  const domainMinimum = observedMinimum >= 0 ? 0 : observedMinimum - padding;
  const domainMaximum = Math.max(observedMaximum + padding, domainMinimum + 1);
  /** @param {string} time */
  const x = (time) => LEFT + (((Date.parse(time) - start) / span) * WIDTH);
  /** @param {number} value */
  const y = (value) => BOTTOM - (((Number(value) - domainMinimum)
    / (domainMaximum - domainMinimum)) * HEIGHT);
  const yTicks = Array.from({ length: 4 }, (_, index) => (
    index === 3
      ? domainMinimum
      : domainMaximum - (((domainMaximum - domainMinimum) * index) / 3)
  ));
  const ticks = selectTicks(observationTimes, MAX_TICKS);
  const unit = metrics.length === 1 ? (metrics[0]?.unit ?? 'value') : 'native value';
  const direction = metrics.length === 1 ? metrics[0]?.direction : undefined;
  const directionLabel = direction === 'decrease'
    ? 'Lower is better'
    : direction === 'increase'
      ? 'Higher is better'
      : direction === 'maintain'
        ? 'Stability is better'
        : direction === 'target'
          ? 'Closer to target is better'
          : '';
  const latestValue = Number.isFinite(options.trend?.endValue)
    ? Number(options.trend?.endValue)
    : Number(metrics[0]?.points.at(-1)?.y);
  const modeLabel = options.mode === 'attainment-only' ? 'attainment' : 'value';
  const provisionalDescription = options.provisional
    ? ' The plotted values are interim and are not yet mature.'
    : '';
  const firstDay = firstObservation.slice(0, 10);
  const lastDay = lastObservation.slice(0, 10);
  const outcomes = (options.outcomes ?? []).filter((outcome) => (
    outcome.date >= firstDay
    && outcome.date <= lastDay
    && Number.isFinite(outcome.successfulRuns)
    && Number.isFinite(outcome.failedRuns)
    && Number.isFinite(outcome.successRate)
    && Number.isFinite(outcome.concludedRuns)
  )).toSorted((left, right) => Date.parse(left.date) - Date.parse(right.date));
  const outcomeHalfWidth = Math.min(
    70,
    Math.max(14, (WIDTH * 86_400_000) / span / 2)
  );
  const observationByDay = new Map(observationTimes.map((time) => [time.slice(0, 10), time]));
  /** @param {string} date */
  const outcomeX = (date) => {
    const matchingObservation = observationByDay.get(date);
    if (matchingObservation) return x(matchingObservation);
    return Math.max(LEFT, Math.min(RIGHT, x(`${date}T12:00:00Z`)));
  };

  return h('article', {
    className: `temporal-metric-plot${options.provisional ? ' temporal-metric-plot-provisional' : ''}`,
    'data-maturity-state': options.provisional ? 'not-yet-mature' : 'matured'
  },
  h('header', { className: 'temporal-plot-heading' },
    h('div', { className: 'temporal-plot-heading-copy' },
      h('h3', null, options.title),
      h('p', null, directionLabel || displayUnit(unit))),
    h('div', { className: 'temporal-plot-summary' },
      h('p', { className: 'temporal-plot-current' },
        h('strong', null, formatCurrentValue(latestValue, unit)),
        displayUnit(unit) ? h('span', null, displayUnit(unit)) : null),
      renderTrendSummary(options.trend, unit, options.provisional))),
  h('svg', {
    viewBox: '0 0 1280 366',
    role: 'img',
    'aria-label': `${options.title} workflow ${modeLabel} timeline${options.provisional ? ', not yet mature' : ''}`
  },
  h('title', null, `${options.title} workflow ${modeLabel} timeline`),
  h('desc', null, `Native repository outcome metric with nearby daily run outcomes shown as a green success and red failure rail below the x-axis. The rail shows temporal proximity and does not imply causation.${provisionalDescription}`),
  options.mode === 'baseline-comparable' && showAdoption
    ? h('rect', {
      className: 'temporal-plot-baseline',
      x: LEFT,
      y: TOP,
      width: Math.max(0, x(options.adoptionAt) - LEFT),
      height: HEIGHT
    })
    : null,
  ...yTicks.flatMap((value) => [
    h('line', { className: 'temporal-plot-grid', x1: LEFT, y1: y(value), x2: RIGHT, y2: y(value) }),
    h('text', {
      x: LEFT - 16,
      y: y(value) + 6,
      'text-anchor': 'end',
      className: 'temporal-plot-axis'
    }, formatValue(value))
  ]),
  ...ticks.flatMap((time) => [
    h('line', { className: 'temporal-plot-grid', x1: x(time), y1: TOP, x2: x(time), y2: BOTTOM }),
    h('text', {
      x: x(time),
      y: 346,
      'text-anchor': 'middle',
      className: 'temporal-plot-axis'
    }, formatDate(time))
  ]),
  showAdoption ? h('line', {
    className: 'temporal-plot-adoption',
    x1: x(options.adoptionAt),
    y1: TOP,
    x2: x(options.adoptionAt),
    y2: BOTTOM,
    'data-chart-temporal-marker': options.adoptionAt
  }) : null,
  ...metrics.flatMap((metric, index) => {
    const className = `chart-series-${(index % 12) + 1}`;
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
        'aria-label': `${metric.label}: ${formatValue(point.y)} ${metric.unit ?? ''} at ${point.x}${options.provisional ? '; not yet mature interim observation' : ''}`
      }, h('title', null, `${metric.label}: ${point.y} at ${point.x}${options.provisional ? ' · Not yet mature' : ''}`)))
    ];
  }),
  outcomes.length > 0 ? h('g', { className: 'temporal-plot-success-context' },
    h('line', {
      className: 'temporal-plot-run-outcome-track',
      x1: LEFT,
      y1: SUCCESS_Y,
      x2: RIGHT,
      y2: SUCCESS_Y
    }),
    ...outcomes.map((outcome) => {
      const markerX = outcomeX(outcome.date);
      const trackStart = Math.max(LEFT, markerX - outcomeHalfWidth);
      const trackEnd = Math.min(RIGHT, markerX + outcomeHalfWidth);
      const successEnd = trackStart + ((outcome.successfulRuns / outcome.concludedRuns) * (trackEnd - trackStart));
      const failureEnd = successEnd + ((outcome.failedRuns / outcome.concludedRuns) * (trackEnd - trackStart));
      return h('g', {
        className: 'temporal-plot-run-outcome',
        tabIndex: 0,
        role: 'img',
        'aria-label': `${formatValue(outcome.successfulRuns)} successful and ${formatValue(outcome.failedRuns)} failed runs out of ${formatValue(outcome.concludedRuns)} concluded runs on ${outcome.date}`
      },
      outcome.successfulRuns > 0 ? h('line', {
        className: 'temporal-plot-run-outcome-success',
        x1: trackStart,
        y1: SUCCESS_Y,
        x2: successEnd,
        y2: SUCCESS_Y
      }) : null,
      outcome.failedRuns > 0 ? h('line', {
        className: 'temporal-plot-run-outcome-failure',
        x1: successEnd,
        y1: SUCCESS_Y,
        x2: failureEnd,
        y2: SUCCESS_Y
      }) : null,
      h('title', null, `${outcome.date}: ${formatValue(outcome.successfulRuns)} successful, ${formatValue(outcome.failedRuns)} failed (${formatValue(outcome.concludedRuns)} concluded)`));
    }),
    h('text', {
      x: RIGHT,
      y: TOP + 18,
      'text-anchor': 'end',
      className: 'temporal-plot-run-outcome-legend'
    },
    h('tspan', { className: 'temporal-plot-run-outcome-legend-label' }, 'Runs: '),
    h('tspan', { className: 'temporal-plot-run-outcome-legend-success' }, 'success'),
    h('tspan', { className: 'temporal-plot-run-outcome-legend-label' }, ' · '),
    h('tspan', { className: 'temporal-plot-run-outcome-legend-failure' }, 'failed'))) : null));
}

/**
 * @param {TemporalTrend | undefined} trend
 * @param {string} unit
 * @param {boolean | undefined} provisional
 */
function renderTrendSummary(trend, unit, provisional) {
  if (!trend || trend.observationCount < 2 || !Number.isFinite(trend.delta)) {
    return h('p', { className: 'temporal-plot-trend temporal-plot-trend-insufficient' }, 'No trend yet');
  }
  const arrow = trend.observedDirection === 'up' ? '↑' : trend.observedDirection === 'down' ? '↓' : '→';
  const assessment = provisional
    ? 'Interim'
    : trend.assessment === 'improving'
      ? 'Improving'
      : trend.assessment === 'worsening'
        ? 'Worsening'
        : trend.assessment === 'stable'
          ? 'Stable'
          : 'Changed';
  const nativeDelta = formatDelta(trend.delta, unit);
  const relative = Number.isFinite(trend.relativePercent)
    ? `${Number(trend.relativePercent) > 0 ? '+' : ''}${formatValue(Number(trend.relativePercent))}%`
    : nativeDelta;
  return h('p', {
    className: `temporal-plot-trend temporal-plot-trend-${provisional ? 'interim' : trend.assessment}`,
    title: `${nativeDelta} across ${trend.observationCount} observations`,
    'aria-label': `${assessment}: ${trend.observedDirection}, ${nativeDelta} across ${trend.observationCount} observations`
  },
  h('span', { className: 'temporal-plot-trend-arrow', 'aria-hidden': 'true' }, arrow),
  h('strong', null, assessment),
  h('span', null, relative));
}

/**
 * @param {string[]} times
 * @param {number} maximum
 */
function selectTicks(times, maximum) {
  if (times.length <= maximum) return times;
  const step = Math.ceil((times.length - 1) / (maximum - 1));
  const selected = times.filter((_, index) => index % step === 0);
  if (selected.at(-1) !== times.at(-1)) selected.push(times.at(-1) ?? '');
  return selected;
}

/**
 * @param {number} value
 * @param {string} unit
 */
function formatCurrentValue(value, unit) {
  return unit === 'percent' ? `${formatValue(value)}%` : formatValue(value);
}

/**
 * @param {number} value
 * @param {string} unit
 */
function formatDelta(value, unit) {
  const sign = value > 0 ? '+' : '';
  return unit === 'percent'
    ? `${sign}${formatValue(value)} pp`
    : `${sign}${formatValue(value)} ${displayUnit(unit) || unit}`;
}

/** @param {string} unit */
function displayUnit(unit) {
  if (unit === 'percent') return '';
  if (unit === 'aic-per-run') return 'AIC/run';
  return unit;
}

/** @param {string} value */
function formatDate(value) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: '2-digit',
    timeZone: 'UTC'
  }).format(new Date(value));
}

/** @param {number} value */
function formatValue(value) {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2
  }).format(value);
}
