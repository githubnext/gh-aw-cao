/**
 * Compact operational-value small multiples and aligned run-success context.
 */

import { h } from '../dom.js';
import { renderTooltip, renderVisualizationEmptyMessage } from './ui-primitives.js';
import { renderSafeLink } from './link-content.js';
import { createFactoryScope } from './factory-elements.js';
import { createDebug } from '../debug.js';

const debugTemporalMetricPlot = createDebug('temporal-metric-plot');

const LEFT = 92;
const RIGHT = 1180;
const TOP = 24;
const BOTTOM = 286;
const WIDTH = RIGHT - LEFT;
const HEIGHT = BOTTOM - TOP;
const SUCCESS_Y = 306;
const MAX_TICKS = 5;
let tooltipId = 0;

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   unit?: string,
 *   direction?: 'increase'|'decrease'|'maintain'|'target',
 *   points: Array<{ x: string, y: number, key?: string, link?: import('./link-content.js').SafeLink|null, description?: string, continuityKey?: string|null, maxGapDays?: number, provisional?: boolean }>
 * }} TemporalMetric
 * @typedef {{ 'run-day': string, 'successful-runs': number, 'failed-runs': number, 'concluded-runs': number }} OutcomeContext
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
 *   connectPoints?: boolean
 *   maxGapDays?: number
 *   continuityNote?: string
 *   comparisonNote?: string
 *   timeDomain?: { start?: number, end?: number }
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
    debugTemporalMetricPlot({ event: 'render-skipped', reason: 'no-observations', metricCount: options.metrics.length });
    return renderVisualizationEmptyMessage('No data is available for this visualization.');
  }

  const firstObservation = observationTimes[0] ?? '';
  const lastObservation = observationTimes.at(-1) ?? firstObservation;
  const adoption = Date.parse(options.adoptionAt);
  const hasAdoption = Number.isFinite(adoption);
  const start = typeof options.timeDomain?.start === 'number' && Number.isFinite(options.timeDomain.start)
    ? options.timeDomain.start
    : Math.min(Date.parse(firstObservation), hasAdoption ? adoption : Infinity);
  const end = typeof options.timeDomain?.end === 'number' && Number.isFinite(options.timeDomain.end)
    ? options.timeDomain.end
    : Math.max(Date.parse(lastObservation), hasAdoption ? adoption : -Infinity);
  const showAdoption = hasAdoption && adoption >= start && adoption < end;
  const span = Math.max(1, end - start);
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
  const axisTimes = [...new Set([new Date(start).toISOString(), ...observationTimes,
    ...(showAdoption ? [options.adoptionAt] : []), new Date(end).toISOString()]
    .map((time) => new Date(time).toISOString()))]
    .toSorted((left, right) => Date.parse(left) - Date.parse(right));
  const ticks = selectTicks(axisTimes, MAX_TICKS);
  const sameDay = new Date(start).toISOString().slice(0, 10) === new Date(end).toISOString().slice(0, 10);
  const unit = metrics.every((metric) => metric.unit === metrics[0]?.unit)
    ? (metrics[0]?.unit ?? 'value')
    : 'native value';
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
  const multipleSeries = metrics.length > 1;
  const modeLabel = options.mode === 'attainment-only' ? 'attainment' : 'value';
  const provisionalDescription = options.provisional
    ? ' The plotted values are interim and are not yet mature.'
    : '';
  const outcomes = (options.outcomes ?? []).filter((outcome) => (
    Number.isFinite(outcome['successful-runs'])
    && Number.isFinite(outcome['failed-runs'])
    && Number.isFinite(outcome['concluded-runs'])
  ));
  debugTemporalMetricPlot({
    event: 'outcomes-filtered',
    providedCount: options.outcomes?.length ?? 0,
    keptCount: outcomes.length
  });
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

  debugTemporalMetricPlot({
    event: 'render-completed',
    mode: options.mode,
    metricCount: metrics.length,
    observationCount: observationTimes.length,
    provisional: Boolean(options.provisional)
  });

  const scope = createFactoryScope();
  /** @param {TemporalMetric} metric @param {TemporalMetric['points'][number]} point */
  const pointLabel = (metric, point) => `${metric.label}: ${formatValue(point.y)} ${metric.unit ?? ''} at ${point.x}${(point.provisional ?? options.provisional) ? '; not yet mature interim observation' : ''}`;
  const root = h('article', {
    className: `temporal-metric-plot${options.provisional ? ' temporal-metric-plot-provisional' : ''}`,
    'data-maturity-state': options.provisional ? 'not-yet-mature' : 'matured'
  },
  h('header', { className: 'temporal-plot-heading' },
    h('div', { className: 'temporal-plot-heading-copy' },
      h('h3', null, options.title),
      h('p', null, `${directionLabel || displayUnit(unit)}${options.provisional ? ' / Provisional' : ''}`),
      options.comparisonNote ? h('p', { className: 'temporal-plot-latest-date' },
        `Latest observation ${new Date(lastObservation).toISOString().slice(0, 10)} (UTC)`) : null,
      h(options.comparisonNote ? 'details' : 'div', options.comparisonNote
        ? { className: 'temporal-plot-evidence-details' } : null,
      options.comparisonNote ? h('summary', null, 'Evidence details') : null,
      options.comparisonNote ? h('p', { className: 'temporal-plot-comparison-note' }, options.comparisonNote) : null,
      h('p', { className: 'temporal-plot-observation-count' },
        observationTimes.length === 1
          ? '1 observation; trend unavailable. At least two comparable observations are needed.'
          : `${observationTimes.length} observation times; movement does not establish causation.`),
      options.comparisonNote ? h('p', { className: 'temporal-plot-evidence-dates' },
        `Retained observations: ${new Date(firstObservation).toISOString().slice(0, 10)} to ${new Date(lastObservation).toISOString().slice(0, 10)} (UTC). Latest observation is not a live measurement.`) : null,
      hasAdoption ? h('p', null, `Adopted ${new Date(adoption).toISOString().slice(0, 10)} (UTC)`) : null,
      options.mode === 'baseline-comparable'
        ? h('p', null, !hasAdoption
          ? 'Baseline unavailable: adoption context is retained in individual point details.'
          : !observationTimes.some((time) => Date.parse(time) < adoption)
          ? 'Baseline unavailable: no retained pre-adoption observations. Missing periods stay missing.'
          : 'Pre-adoption observations retained; complete baseline-window coverage is not verified.')
        : h('p', null, 'Attainment only: no pre-adoption baseline.'),
      options.continuityNote ? h('p', { className: 'temporal-plot-continuity-note' }, options.continuityNote) : null,
      options.comparisonNote ? h('p', { className: 'temporal-plot-coverage-note' },
        'Source-window coverage is not recorded here. Missing periods may reflect unavailable records, insufficient eligible runs, or incomplete measurement evidence; the stored observations do not identify the reason. Do not infer zero or improvement from a gap.') : null)),
    h('div', { className: 'temporal-plot-summary' },
      multipleSeries
        ? h('p', { className: 'temporal-plot-current' },
          h('strong', null, String(metrics.length)),
          h('span', null, metrics.length === 1 ? 'repository' : 'repositories'))
        : h('p', { className: 'temporal-plot-current' },
          h('strong', null, formatCurrentValue(latestValue, unit)),
          displayUnit(unit) ? h('span', null, displayUnit(unit)) : null),
      multipleSeries || (options.comparisonNote && !options.trend)
        ? null : renderTrendSummary(options.trend, unit, options.provisional))),
  h('div', { className: 'temporal-plot-chart' },
  h('svg', {
    viewBox: '0 0 1280 366',
    role: 'img',
    'aria-label': `${options.title} ${options.connectPoints === false ? 'repository observations' : `workflow ${modeLabel}`} timeline${options.provisional ? ', not yet mature' : ''}`
  },
  h('title', null, `${options.title} ${options.connectPoints === false ? 'repository observations' : `workflow ${modeLabel}`} timeline`),
  h('desc', null, `${options.connectPoints === false ? 'Discrete repository observations' : 'Repository outcome metric'} (${displayUnit(unit)}) with nearby daily run outcomes shown as solid success and hollow failure segments below the x-axis. The rail shows temporal proximity and does not imply causation.${provisionalDescription}`),
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
    }, sameDay ? formatTime(time) : formatDate(time))
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
      ...(options.connectPoints === false ? [] : lineSegments(metric.points, options.maxGapDays)).map((points) => h('polyline', {
        className: `temporal-plot-metric ${className}${points[0]?.provisional ? ' temporal-plot-metric-provisional' : ''}`,
        points: points.map((point) => `${x(point.x)},${y(point.y)}`).join(' '),
        fill: 'none',
        'data-temporal-metric': metric.id
      })),
      ...metric.points.map((point) => h('circle', {
        className: `temporal-plot-point ${className}${point.provisional ? ' temporal-plot-point-provisional' : ''}`,
        cx: x(point.x),
        cy: y(point.y),
        r: 6,
        tabIndex: point.link || point.description ? undefined : 0,
        role: 'img',
        'aria-label': pointLabel(metric, point)
      }, h('title', null, `${pointLabel(metric, point)}${point.description ? `. ${point.description}` : ''}`)))
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
      const markerX = outcomeX(outcome['run-day']);
      const trackStart = Math.max(LEFT, markerX - outcomeHalfWidth);
      const trackEnd = Math.min(RIGHT, markerX + outcomeHalfWidth);
      const successEnd = trackStart + ((outcome['successful-runs'] / outcome['concluded-runs']) * (trackEnd - trackStart));
      const failureEnd = successEnd + ((outcome['failed-runs'] / outcome['concluded-runs']) * (trackEnd - trackStart));
      return h('g', {
        className: 'temporal-plot-run-outcome',
        tabIndex: 0,
        role: 'img',
        'aria-label': `${formatValue(outcome['successful-runs'])} successful and ${formatValue(outcome['failed-runs'])} failed runs out of ${formatValue(outcome['concluded-runs'])} concluded runs on ${outcome['run-day']}`
      },
      outcome['successful-runs'] > 0 ? h('line', {
        className: 'temporal-plot-run-outcome-success',
        x1: trackStart,
        y1: SUCCESS_Y,
        x2: successEnd,
        y2: SUCCESS_Y
      }) : null,
      outcome['failed-runs'] > 0 ? h('line', {
        className: 'temporal-plot-run-outcome-failure',
        x1: successEnd,
        y1: SUCCESS_Y,
        x2: failureEnd,
        y2: SUCCESS_Y
      }) : null,
      outcome['failed-runs'] > 0 ? h('line', {
        className: 'temporal-plot-run-outcome-failure-inset',
        x1: successEnd,
        y1: SUCCESS_Y,
        x2: failureEnd,
        y2: SUCCESS_Y
      }) : null,
      h('title', null, `${outcome['run-day']}: ${formatValue(outcome['successful-runs'])} successful, ${formatValue(outcome['failed-runs'])} failed (${formatValue(outcome['concluded-runs'])} concluded)`));
    }),
    h('g', { className: 'temporal-plot-run-outcome-legend' },
      h('text', { x: RIGHT - 300, y: TOP + 18, className: 'temporal-plot-run-outcome-legend-label' }, 'Runs:'),
      h('line', { className: 'temporal-plot-run-outcome-success', x1: RIGHT - 242, y1: TOP + 12, x2: RIGHT - 220, y2: TOP + 12, 'aria-hidden': 'true' }),
      h('text', { x: RIGHT - 210, y: TOP + 18, className: 'temporal-plot-run-outcome-legend-success' }, 'success'),
      h('line', { className: 'temporal-plot-run-outcome-failure', x1: RIGHT - 110, y1: TOP + 12, x2: RIGHT - 88, y2: TOP + 12, 'aria-hidden': 'true' }),
      h('line', { className: 'temporal-plot-run-outcome-failure-inset', x1: RIGHT - 110, y1: TOP + 12, x2: RIGHT - 88, y2: TOP + 12, 'aria-hidden': 'true' }),
      h('text', { x: RIGHT - 78, y: TOP + 18, className: 'temporal-plot-run-outcome-legend-failure' }, 'failed'))) : null),
  ...metrics.flatMap((metric) => metric.points.flatMap((point) => {
    if (!point.link && !point.description) return [];
    const label = pointLabel(metric, point);
    const tooltip = renderTooltip({
      id: `temporal-point-tooltip-${++tooltipId}`,
      label,
      description: point.description ? `${label}. ${point.description}` : label,
      className: 'temporal-plot-point-tooltip',
      viewportAnchored: true,
      signal: scope.signal,
      trigger: h('button', { type: 'button', className: 'temporal-plot-point-trigger' }),
      ...(point.link ? { content: h('span', null, renderSafeLink('View run report', point.link)) } : {})
    });
    tooltip.style.left = `${(x(point.x) / 1280) * 100}%`;
    tooltip.style.top = `${(y(point.y) / 366) * 100}%`;
    return [tooltip];
  }))));
  scope.bind(root);
  return root;
}

/**
 * @param {TemporalMetric['points']} points
 * @param {number | undefined} maxGapDays
 */
function lineSegments(points, maxGapDays) {
  if (maxGapDays === undefined && !points.some((point) => Object.hasOwn(point, 'continuityKey'))) return [points];
  /** @type {TemporalMetric['points'][]} */
  const segments = [];
  for (const point of points) {
    const segment = segments.at(-1);
    const previous = segment?.at(-1);
    const gapLimit = point.maxGapDays ?? maxGapDays;
    const contextChanged = Object.hasOwn(point, 'continuityKey')
      && (!point.continuityKey || point.continuityKey !== previous?.continuityKey);
    if (!segment || contextChanged || (gapLimit !== undefined && gapLimit <= 0)
      || (previous && gapLimit !== undefined
        && Date.parse(point.x) - Date.parse(previous.x) > gapLimit * 86_400_000)) {
      segments.push([point]);
    } else {
      segment.push(point);
    }
  }
  return segments.filter((segment) => segment.length > 1);
}

/**
 * @param {TemporalTrend | undefined} trend
 * @param {string} unit
 * @param {boolean | undefined} provisional
 */
function renderTrendSummary(trend, unit, provisional) {
  if (!trend || trend.observationCount < 2 || !Number.isFinite(trend.delta)) {
    return h('p', { className: 'temporal-plot-trend temporal-plot-trend-insufficient' },
      'Insufficient comparable observations for a trend.');
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
  if (unit === 'percent/day') return 'pp/day';
  if (unit === 'aic-per-run/day') return 'AIC/run/day';
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

/** @param {string} value */
function formatTime(value) {
  return `${new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC'
  }).format(new Date(value))} UTC`;
}

/** @param {number} value */
function formatValue(value) {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2
  }).format(value);
}
