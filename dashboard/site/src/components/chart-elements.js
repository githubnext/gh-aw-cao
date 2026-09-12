/**
 * Reusable presentation-only chart legend and series helpers for dashboard views.
 */

import { h } from '../dom.js';
import { formatNumber, toNumber } from '../view-formatters.js';
import { formatCount, formatCoveragePercent, pluralSuffix } from './count-formatters.js';
import { binHistogramValues } from './histogram.js';
import { renderSafeLink } from './link-content.js';
import { renderEmptyMessage, renderLegendList } from './ui-primitives.js';

const MAX_LINE_POINT_SIZE = 6;
const MIN_LINE_POINT_SIZE = 2;
const MAX_DOT_POINT_RADIUS = 2.5;
const MIN_DOT_POINT_RADIUS = 0.5;
const MIN_RADIUS_POINT_COUNT = 100;
// Some SVG engines collapse zero-length lines before painting their round caps.
const NON_SCALING_POINT_LENGTH = 0.001;
const MAX_INTERACTIVE_LINE_POINTS = 500;
const MAX_RENDERED_LINE_POINTS = 2_000;
const MAX_TIMELINE_TICKS = 5;
const MAX_BAR_AXIS_TICKS = 5;
const BAR_CHART_LEFT = 12;
const BAR_CHART_RIGHT = 100;
const BAR_CHART_BOTTOM = 38;
const BAR_CHART_HEIGHT = 34;
const MAX_HISTOGRAM_X_TICKS = 5;
const MAX_HEATMAP_CELLS = 100;
const MAX_HEATMAP_AXIS_CATEGORIES = 12;
const PIE_CHART_CENTER = 21;
const PIE_CHART_RADIUS = 15.9155;
const PIE_CHART_STROKE_WIDTH = 6;
const PIE_CHART_SEGMENT_GAP = 0.03;
const SWIMLANE_START_X = 25;
const SWIMLANE_END_X = 117;
const MAX_SWIMLANE_SECTIONS_PER_LANE = 120;
const SWIMLANE_DEFINITIONS = [
  ['action-required', 'Action required'],
  ['failure', 'Failure'],
  ['cancelled', 'Cancelled'],
  ['skipped', 'Skipped'],
  ['success', 'Success']
];
const SWIMLANE_FAILURES = new Set(['failure', 'startup-failure', 'stale', 'timed-out']);
const CHART_SERIES_COLOR_COUNT = 12;
const SEMANTIC_SERIES_TERMS = {
  failure: new Set(['0', 'denied', 'error', 'errored', 'fail', 'failed', 'failing', 'failure', 'false', 'invalid', 'no', 'rejected', 'stale', 'timeout', 'unhealthy', 'unsuccessful']),
  success: new Set(['approved', 'complete', 'completed', 'healthy', 'pass', 'passed', 'passing', 'resolved', 'succeed', 'succeeded', 'success', 'successful']),
  waiting: new Set(['awaiting', 'pending', 'queued', 'waiting']),
  attention: new Set(['cancelled', 'canceled', 'degraded', 'warning']),
  neutral: new Set(['disabled', 'dismissed', 'inactive', 'neutral', 'skipped', 'unknown'])
};
const SEMANTIC_SERIES_PHRASES = {
  failure: new Set(['timed out']),
  waiting: new Set(['action required', 'in progress'])
};

/**
 * @typedef {{ name: string, className: string }} ChartSeriesDescriptor
 */

/**
 * @typedef {{
 *   x: string,
 *   y: number,
 *   color: string | null,
 *   highlighted?: boolean | null,
 *   key?: string,
 *   category?: string,
 *   link?: { href: string, label: string } | null,
 *   source?: Record<string, unknown>
 * }} ChartPointLike
 */

/**
 * @param {ChartPointLike[]} points
 * @returns {Array<[string, ChartPointLike[]]>}
 */
export function groupChartSeries(points) {
  const grouped = new Map();
  for (const point of points) {
    const name = point.color ?? 'value';
    const series = grouped.get(name) ?? [];
    series.push(point);
    grouped.set(name, series);
  }
  return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right));
}

/**
 * @param {ChartPointLike[]} points
 * @returns {ChartSeriesDescriptor[]}
 */
export function listChartSeries(points) {
  return groupChartSeries(points).map(([name], index) => ({
    name,
    className: chartSeriesClassName(name, index)
  }));
}

/**
 * Retains a varied fallback palette while adding a stable semantic color when
 * the series name describes a commonly understood status.
 * @param {string} name
 * @param {number} index
 * @returns {string}
 */
export function chartSeriesClassName(name, index) {
  const paletteClass = `chart-series-${(index % CHART_SERIES_COLOR_COUNT) + 1}`;
  const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const terms = new Set(normalized.split(/\s+/).filter(Boolean));
  let meaning = null;

  if (SEMANTIC_SERIES_PHRASES.failure.has(normalized) || hasMatchingTerm(terms, SEMANTIC_SERIES_TERMS.failure)) {
    meaning = 'failure';
  } else if (
    SEMANTIC_SERIES_PHRASES.waiting.has(normalized)
    || ((terms.has('approval') || terms.has('review')) && (terms.has('required') || terms.has('awaiting') || terms.has('pending') || terms.has('waiting')))
    || hasMatchingTerm(terms, SEMANTIC_SERIES_TERMS.waiting)
  ) {
    meaning = 'waiting';
  } else if (hasMatchingTerm(terms, SEMANTIC_SERIES_TERMS.success)) {
    meaning = 'success';
  } else if (hasMatchingTerm(terms, SEMANTIC_SERIES_TERMS.attention)) {
    meaning = 'attention';
  } else if (hasMatchingTerm(terms, SEMANTIC_SERIES_TERMS.neutral)) {
    meaning = 'neutral';
  }

  return meaning ? `${paletteClass} chart-series-semantic-${meaning}` : paletteClass;
}

/** @param {Set<string>} terms @param {Set<string>} candidates */
function hasMatchingTerm(terms, candidates) {
  for (const term of terms) {
    if (candidates.has(term)) return true;
  }
  return false;
}

/**
 * @param {ChartSeriesDescriptor[]} series
 * @param {string} chartType
 * @returns {HTMLElement}
 */
export function renderChartLegend(series, chartType) {
  const legendItems = chartType === 'scatter'
    ? [...series, { name: 'Dashed lines show scale guides', className: 'chart-grid-key' }]
    : series;
  return renderLegendList(
    `chart-legend chart-legend-${chartType}`,
    legendItems,
    (item) => item.className,
    (item) => [h('span', null, item.name)],
    { 'data-chart-legend': 'visual' }
  );
}

/**
 * @param {ChartPointLike[]} points
 * @returns {{ entries: Array<[string, number]>, total: number }}
 */
export function pieChartEntries(points) {
  const totals = new Map();
  for (const point of points) {
    const category = point.x;
    totals.set(category, (totals.get(category) ?? 0) + point.y);
  }
  const entries = [...totals.entries()].filter(([, value]) => value > 0);
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  return { entries, total };
}

/** @param {number} startFraction @param {number} endFraction @param {boolean} separated */
function pieChartSegmentPath(startFraction, endFraction, separated = false) {
  const start = Math.min(1, Math.max(0, startFraction));
  const end = Math.min(1, Math.max(start, endFraction));
  const sweep = end - start;
  const gap = separated && sweep < 1 - Number.EPSILON
    ? Math.min(PIE_CHART_SEGMENT_GAP, sweep * 0.2)
    : 0;
  const visibleStart = start + gap;
  const visibleEnd = end - gap;
  /** @param {number} fraction */
  const pointAt = (fraction) => {
    const angle = (fraction * Math.PI * 2) - (Math.PI / 2);
    return [
      Number((PIE_CHART_CENTER + (Math.cos(angle) * PIE_CHART_RADIUS)).toFixed(4)),
      Number((PIE_CHART_CENTER + (Math.sin(angle) * PIE_CHART_RADIUS)).toFixed(4))
    ];
  };
  const [startX, startY] = pointAt(visibleStart);

  if (sweep <= Number.EPSILON) return `M ${startX} ${startY}`;
  if (sweep >= 1 - Number.EPSILON) {
    const [middleX, middleY] = pointAt(start + 0.5);
    return `M ${startX} ${startY} A ${PIE_CHART_RADIUS} ${PIE_CHART_RADIUS} 0 1 1 ${middleX} ${middleY} A ${PIE_CHART_RADIUS} ${PIE_CHART_RADIUS} 0 1 1 ${startX} ${startY}`;
  }

  const [endX, endY] = pointAt(visibleEnd);
  return `M ${startX} ${startY} A ${PIE_CHART_RADIUS} ${PIE_CHART_RADIUS} 0 ${(visibleEnd - visibleStart) > 0.5 ? 1 : 0} 1 ${endX} ${endY}`;
}

/**
 * @param {Array<[string, number]>} entries
 * @param {number} total
 * @param {Map<string, { href: string, label: string }>} [links]
 * @param {{ name: string, symbol: string, significant: number } | null} [unit]
 * @returns {HTMLElement}
 */
export function renderPieLegend(entries, total, links = new Map(), unit = null) {
  return renderLegendList(
    'chart-legend chart-legend-pie',
    entries,
    ([label], index) => chartSeriesClassName(label, index),
    ([label, value]) => {
      const link = links.get(label) ?? null;
      return [
        h('span', null, renderSafeLink(label, link)),
        h('strong', null, formatNumber(value, unit)),
        h('small', null, total > 0 ? formatCoveragePercent(value / total) : '0%')
      ];
    },
    { 'data-chart-legend': 'visual' }
  );
}

/**
 * Wraps chart content in the shared `chart-widget` container, applying the
 * per-chart-type modifier class and `data-chart-widget` marker consistently.
 * @param {string} chartType
 * @param {Record<string, unknown> | null} extraAttrs
 * @param {...(HTMLElement | null)} children
 * @returns {HTMLElement}
 */
function renderChartWidgetShell(chartType, extraAttrs, ...children) {
  return h(
    'div',
    { className: `chart-widget ${chartType}-chart-widget`, 'data-chart-widget': chartType, ...(extraAttrs ?? {}) },
    ...children
  );
}

/**
 * Renders a chart widget shell containing the shared `role="status"` empty
 * placeholder message. Shared by the generic chart, heatmap, and swimlane
 * renderers, which otherwise duplicated the same
 * `renderChartWidgetShell(type, null, renderEmptyMessage(message, { role: 'status' }))`
 * wrapping.
 * @param {string} chartType
 * @param {string} message
 * @returns {HTMLElement}
 */
function renderChartWidgetEmptyState(chartType, message) {
  return renderChartWidgetShell(chartType, null, renderEmptyMessage(message, { role: 'status' }));
}

/**
 * Renders the small `<g><rect/><text/></g>` tooltip shell shown alongside a
 * chart point, segment, or bar on hover/focus. Shared by the pie, histogram,
 * and line/scatter/dot chart renderers, which otherwise duplicated the same
 * hidden-tooltip markup with only their sizing and positioning attributes
 * differing.
 * @param {{
 *   className?: string,
 *   transform: string,
 *   width?: number,
 *   height?: number,
 *   rx?: number,
 *   textX?: number,
 *   textY?: number,
 *   textLengthAttrs?: Record<string, unknown> | null,
 *   label: string
 * }} options
 */
function renderChartPointTooltip({
  className = 'point-tooltip',
  transform,
  width = 42,
  height = 9,
  rx = 2,
  textX = 3,
  textY = 6,
  textLengthAttrs = null,
  label
}) {
  return h(
    'g',
    { className, transform, 'aria-hidden': 'true' },
    h('rect', { width, height, rx }),
    h('text', { x: textX, y: textY, ...(textLengthAttrs ?? {}) }, label)
  );
}

/**
 * Re-appends a chart point/segment to its parent on hover or focus so its
 * tooltip paints above sibling marks instead of being clipped underneath them.
 * @param {Element} mark
 */
function raiseChartPointOnInteraction(mark) {
  const bringToFront = () => mark.parentNode?.append(mark);
  mark.addEventListener('pointerenter', bringToFront);
  mark.addEventListener('focus', bringToFront);
}

/**
 * Builds an interactive chart-point `<g>` mark: a `chart-point`-flavored
 * group with `role="img"`, `aria-label`, and a `<title>` for accessibility,
 * the caller's shape element(s), and a hidden tooltip, then wires it to
 * raise above sibling marks on hover/focus. Shared by the pie, histogram,
 * and line/scatter/dot chart renderers, which otherwise duplicated this
 * same `<g>` + `<title>` + tooltip + raise-on-interaction scaffolding
 * around their own shape markup.
 * @param {{
 *   className: string,
 *   entryIndex: number,
 *   label: string,
 *   shape: Element | Element[],
 *   tooltip: Parameters<typeof renderChartPointTooltip>[0]
 * }} options
 * @returns {Element}
 */
function renderInteractiveChartMark({ className, entryIndex, label, shape, tooltip }) {
  const mark = h(
    'g',
    {
      className,
      style: `--chart-entry-index: ${entryIndex}`,
      tabIndex: 0,
      role: 'img',
      'aria-label': label
    },
    h('title', null, label),
    ...(Array.isArray(shape) ? shape : [shape]),
    renderChartPointTooltip(tooltip)
  );
  raiseChartPointOnInteraction(mark);
  return mark;
}

/**
 * Renders a declaratively selected chart using normalized dashboard points.
 * @param {string} chartType
 * @param {ChartPointLike[]} points
 * @param {ChartSeriesDescriptor[]} series
 * @param {{ entries: Array<[string, number]>, total: number } | null} [pieSummary]
 * @param {string} [totalLabel]
 * @param {{ name: string, symbol: string, significant: number } | null} [unit]
 * @param {Record<string, unknown> | null} [timeRange]
 * @param {string | null} [referenceField]
 * @returns {HTMLElement}
 */
export function renderChartWidget(chartType, points, series, pieSummary = null, totalLabel = 'Total', unit = null, timeRange = null, referenceField = null) {
  const pieData = chartType === 'pie' ? pieSummary ?? pieChartEntries(points) : null;
  const entryCount = pieData ? pieData.entries.length : points.length;
  const minimumEntries = ['heatmap', 'pie', 'scatter'].includes(chartType) ? 1 : 2;
  if (entryCount < minimumEntries && chartType !== 'swimlane') {
    return renderChartWidgetEmptyState(
      chartType,
      entryCount === 0 ? 'No data is available for this visualization.' : 'Not enough data to show this visualization.'
    );
  }

  if (chartType === 'pie') {
    const { entries, total } = /** @type {{ entries: Array<[string, number]>, total: number }} */ (pieData);
    const safeTotal = Number.isFinite(total) && total > 0 ? total : 0;
    const separated = entries.filter(([, value]) => Number.isFinite(value) && value > 0).length > 1;
    let cumulativeValue = 0;
    return renderChartWidgetShell(
      'pie',
      null,
      h(
        'svg',
        { viewBox: '0 0 42 42', role: 'img', 'aria-label': `Pie chart: ${entries.map(([label, value]) => `${label} ${formatNumber(value, unit)}`).join(', ') || 'no data'}` },
        h('circle', { className: 'pie-chart-track', cx: PIE_CHART_CENTER, cy: PIE_CHART_CENTER, r: PIE_CHART_RADIUS, fill: 'none', 'stroke-width': PIE_CHART_STROKE_WIDTH }),
        ...entries.map(([label, value], index) => {
          const segmentValue = Number.isFinite(value) && value > 0 ? value : 0;
          const startFraction = safeTotal > 0 ? cumulativeValue / safeTotal : 0;
          cumulativeValue = Math.min(safeTotal, cumulativeValue + segmentValue);
          const endFraction = safeTotal > 0 ? cumulativeValue / safeTotal : startFraction;
          const segmentLabel = `${label}: ${formatNumber(value, unit)}`;
          const midpoint = ((startFraction + endFraction) / 2) * Math.PI * 2 - (Math.PI / 2);
          const tooltipWidth = Math.min(40, Math.max(18, (segmentLabel.length * 1.25) + 5));
          const tooltipX = Math.min(Math.max(21 + (Math.cos(midpoint) * 14) - (tooltipWidth / 2), 1), 41 - tooltipWidth);
          const tooltipY = Math.min(Math.max(21 + (Math.sin(midpoint) * 14) - 9, 1), 34);
          return renderInteractiveChartMark({
            className: 'chart-point pie-chart-mark',
            entryIndex: index,
            label: segmentLabel,
            shape: h('path', {
              className: `pie-chart-segment ${chartSeriesClassName(label, index)}`,
              d: pieChartSegmentPath(startFraction, endFraction, separated),
              fill: 'none',
              'stroke-width': PIE_CHART_STROKE_WIDTH,
              'stroke-linecap': 'round',
              'data-chart-category': label
            }),
            tooltip: {
              className: 'point-tooltip pie-chart-tooltip',
              transform: `translate(${tooltipX} ${tooltipY})`,
              width: tooltipWidth,
              height: 7,
              textX: 2.5,
              textY: 4.75,
              textLengthAttrs: tooltipWidth === 40 ? { textLength: 35, lengthAdjust: 'spacingAndGlyphs' } : null,
              label: segmentLabel
            }
          });
        }),
        h('text', { className: 'pie-chart-total-value', x: 21, y: 20, 'text-anchor': 'middle', 'aria-hidden': 'true' }, formatNumber(total, unit, false)),
        h('text', { className: 'pie-chart-total-label', x: 21, y: 25.5, 'text-anchor': 'middle', 'aria-hidden': 'true' }, totalLabel)
      )
    );
  }

  if (chartType === 'histogram') {
    const bins = binHistogramValues(points.map((point) => toNumber(point.y)));
    const maximum = Math.max(...bins.map((bin) => bin.count), 1);
    const plotStart = 9;
    const plotWidth = 100 - plotStart;
    const barWidth = bins.length > 0 ? plotWidth / bins.length : plotWidth;
    const xBoundaries = bins.length > 0
      ? [...bins.map((bin) => bin.lower), bins[bins.length - 1].upper]
      : [];
    const xTickCount = Math.min(xBoundaries.length, MAX_HISTOGRAM_X_TICKS);
    const xTicks = Array.from({ length: xTickCount }, (_, index) => (
      xBoundaries[Math.round((index * (xBoundaries.length - 1)) / Math.max(xTickCount - 1, 1))]
    )).map((value) => formatNumber(value, unit))
      .filter((value, index, values) => index === 0 || value !== values[index - 1]);
    /** @param {{ lower: number, upper: number }} bin */
    const binLabel = (bin) => {
      const lower = formatNumber(bin.lower, unit);
      const upper = formatNumber(bin.upper, unit);
      return bin.lower === bin.upper ? lower : `${lower}–${upper}`;
    };
    return renderChartWidgetShell(
      'histogram',
      null,
      h(
        'svg',
        { viewBox: '0 0 100 42', role: 'img', 'aria-label': `Histogram with ${bins.length} automatically calculated bins` },
        ...[
          [4, maximum],
          [21, maximum / 2],
          [38, 0]
        ].flatMap(([y, value]) => [
          h('text', {
            className: 'histogram-chart-y-label',
            x: plotStart - 1.5,
            y: y + 1,
            'text-anchor': 'end',
            'aria-hidden': 'true'
          }, formatNumber(value, null)),
          h('line', { className: 'histogram-chart-grid', x1: plotStart, y1: y, x2: 100, y2: y })
        ]),
        h('line', { className: 'bar-chart-axis', x1: plotStart, y1: 38, x2: 100, y2: 38 }),
        ...bins.map((bin, index) => {
          const height = Math.max(1, (bin.count / maximum) * 34);
          const label = `${binLabel(bin)}: ${bin.count} observation${pluralSuffix(bin.count)}`;
          const x = plotStart + (index * barWidth);
          const tooltipX = Math.min(Math.max(x + ((barWidth - 1) / 2) - 21, 1), 57);
          return renderInteractiveChartMark({
            className: 'chart-point histogram-chart-mark',
            entryIndex: index,
            label,
            shape: h('rect', {
              className: 'histogram-chart-bar chart-series-1',
              x,
              y: 38 - height,
              width: Math.max(0, barWidth - 1),
              height,
              rx: 0.75
            }),
            tooltip: {
              className: 'point-tooltip histogram-chart-tooltip',
              transform: `translate(${tooltipX} ${Math.max(38 - height - 12, 1)})`,
              textLengthAttrs: label.length > 22 ? { textLength: 36, lengthAdjust: 'spacingAndGlyphs' } : null,
              label
            }
          });
        })
      ),
      bins.length > 0
        ? h(
          'div',
          { className: 'chart-axis', 'data-chart-axis': 'histogram' },
          ...xTicks.map((value) => h('span', null, value))
        )
        : null
    );
  }

  if (chartType === 'heatmap') {
    return renderHeatmapChart(points, totalLabel, unit);
  }

  if (chartType === 'line' || chartType === 'dot' || chartType === 'scatter') {
    const isDotChart = chartType === 'dot';
    const isScatterChart = chartType === 'scatter';
    const isPointChart = isDotChart || isScatterChart;
    const groupedSeries = groupChartSeries(points);
    const renderedPointLimit = Math.max(2, Math.floor(MAX_RENDERED_LINE_POINTS / Math.max(groupedSeries.length, 1)));
    const hasWindowHighlight = points.some((point) => typeof point.highlighted === 'boolean');
    const showInteractivePoints = points.length <= MAX_INTERACTIVE_LINE_POINTS;
    const seriesClassNames = new Map(series.map((item) => [item.name, item.className]));
    const xValues = [...new Set(points.map((point) => point.x))];
    const xIndexes = new Map(xValues.map((value, index) => [value, index]));
    const parsedTimes = isScatterChart ? xValues.map((value) => Date.parse(value)) : [];
    let minimumTime = Number.POSITIVE_INFINITY;
    let maximumTime = Number.NEGATIVE_INFINITY;
    for (const time of parsedTimes) {
      if (!Number.isFinite(time)) continue;
      minimumTime = Math.min(minimumTime, time);
      maximumTime = Math.max(maximumTime, time);
    }
    const timelineTicks = isScatterChart
      ? scatterChartTimeAxisTicks(parsedTimes, minimumTime, maximumTime)
      : lineChartTimelineTicks(xValues);
    let maximum = 1;
    for (const point of points) {
      const value = toNumber(point.y);
      if (Number.isFinite(value)) maximum = Math.max(maximum, value);
    }
    const referenceLines = isDotChart && referenceField
      ? groupedSeries.flatMap(([seriesName, seriesPoints]) => [...new Set(seriesPoints
        .map((point) => toNumber(point.source?.[referenceField]))
        .filter(Number.isFinite))]
        .map((value) => ({ seriesName, value })))
      : [];
    for (const { value } of referenceLines) maximum = Math.max(maximum, value);
    const pointSize = lineChartPointSize(points.length);
    const dotPointRadius = dotChartPointRadius(points.length);
    const gridLines = [4, 21, 38].map((y) => h('line', { className: 'line-chart-grid', x1: 0, y1: y, x2: 100, y2: y }));
    const highlightedIndexes = [...new Set(points.flatMap((point) => {
      const index = point.highlighted ? xIndexes.get(point.x) : undefined;
      return index === undefined ? [] : [index];
    }))];
    const xStep = xValues.length > 1 ? 100 / (xValues.length - 1) : 100;
    const windowBand = highlightedIndexes.length > 0
      ? {
        start: Math.max(0, (Math.min(...highlightedIndexes) - 0.5) * xStep),
        end: Math.min(100, (Math.max(...highlightedIndexes) + 0.5) * xStep)
      }
      : null;
    return renderChartWidgetShell(
      chartType,
      { 'data-line-rendering': showInteractivePoints ? 'rich' : 'compact' },
      h(
        'svg',
        {
          viewBox: '0 0 100 42',
          role: 'img',
          'aria-label': isPointChart
            ? `${isScatterChart ? 'Scatter' : 'Dot'} chart with ${points.length} points${isDotChart ? ` and ${referenceLines.length} reference lines` : ''}`
            : `Line chart with ${points.length} points`
        },
        windowBand ? h('rect', {
          className: 'line-chart-window-band',
          x: windowBand.start,
          y: 0,
          width: Math.max(windowBand.end - windowBand.start, 1),
          height: 38,
          'aria-hidden': 'true'
        }) : null,
        ...gridLines,
        h('line', { className: 'line-chart-axis', x1: 0, y1: 38, x2: 100, y2: 38 }),
        ...referenceLines.map(({ seriesName, value }) => h('line', {
          className: `dot-chart-reference ${seriesClassNames.get(seriesName) ?? 'chart-series-1'}`,
          x1: 0,
          y1: 38 - (Math.max(0, value) / maximum) * 34,
          x2: 100,
          y2: 38 - (Math.max(0, value) / maximum) * 34,
          'data-chart-reference': seriesName,
          'data-chart-reference-value': String(value),
          'aria-hidden': 'true'
        })),
        ...groupedSeries.flatMap(([seriesName, seriesPoints], seriesIndex) => {
          const seriesClassName = seriesClassNames.get(seriesName) ?? 'chart-series-1';
          const coordinates = seriesPoints.map((point) => {
            const xIndex = xIndexes.get(point.x) ?? 0;
            const pointTime = Date.parse(point.x);
            const x = isScatterChart && maximumTime > minimumTime && Number.isFinite(pointTime)
              ? ((pointTime - minimumTime) / (maximumTime - minimumTime)) * 100
              : xValues.length < 2 ? 50 : (xIndex / (xValues.length - 1)) * 100;
            const y = 38 - (Math.max(0, toNumber(point.y)) / maximum) * 34;
            return { point, x, y };
          });
          const renderedCoordinates = sampleLineCoordinates(coordinates, renderedPointLimit);
          const highlightedCoordinates = hasWindowHighlight
            ? sampleLineCoordinates(coordinates.filter(({ point }) => point.highlighted), renderedPointLimit)
            : [];
          return [
            ...(!isPointChart ? [h('polyline', {
              className: `line-chart-series ${seriesClassName}${hasWindowHighlight ? ' line-chart-context' : ''}`,
              style: `--chart-entry-index: ${seriesIndex}`,
              pathLength: 1,
              points: renderedCoordinates.map(({ x, y }) => `${x},${y}`).join(' '),
              fill: 'none',
              'data-chart-series': seriesName
            })] : []),
            ...(!isPointChart && highlightedCoordinates.length > 1
              ? [h('polyline', {
                className: `line-chart-series line-chart-current ${seriesClassName}`,
                style: `--chart-entry-index: ${seriesIndex}`,
                pathLength: 1,
                points: highlightedCoordinates.map(({ x, y }) => `${x},${y}`).join(' '),
                fill: 'none',
                'data-chart-window': 'current'
              })]
              : []),
            ...(isPointChart && !showInteractivePoints
              ? renderedCoordinates.map(({ x, y }) => h('circle', {
                className: `${isScatterChart ? 'scatter' : 'dot'}-chart-point ${seriesClassName}`,
                cx: x,
                cy: y,
                r: dotPointRadius,
                'aria-hidden': 'true'
              }))
              : []),
            ...(showInteractivePoints ? coordinates.map(({ point, x, y }, pointIndex) => h('g', {
              className: `chart-point${point.highlighted === false ? ' chart-point-context' : point.highlighted ? ' chart-point-current' : ''}`,
              style: `--chart-entry-index: ${pointIndex}`,
              tabIndex: 0,
              role: 'img',
              'aria-label': `${chartPointLabel(point, unit)}${point.highlighted === false ? ' (context)' : point.highlighted ? ' (selected window)' : ''}`
            },
            h('title', null, chartPointLabel(point, unit)),
            isPointChart
              ? h('circle', {
                className: `${isScatterChart ? 'scatter' : 'dot'}-chart-point ${seriesClassName}`,
                cx: x,
                cy: y,
                r: dotPointRadius
              })
              : h('line', {
                className: `line-chart-point ${seriesClassName}`,
                style: `--chart-point-size: ${hasWindowHighlight ? 4 : pointSize}px`,
                x1: x,
                y1: y,
                x2: x + NON_SCALING_POINT_LENGTH,
                y2: y
              }),
            renderChartPointTooltip({
              transform: `translate(${Math.min(Math.max(x - 21, 1), 57)} ${Math.max(y - 12, 1)})`,
              label: chartPointLabel(point, unit)
            }))) : [])
          ];
        })
      ),
      hasWindowHighlight
        ? h('div', { className: 'chart-window-key', 'aria-label': 'Chart window key' },
          h('span', { className: 'chart-window-context' }, 'Previous context'),
          h('strong', null, 'Selected window'))
        : null,
      xValues.length > 0
        ? h(
          'div',
          { className: 'chart-axis timeline-chart-axis', 'data-chart-axis': chartType },
          ...timelineTicks.map((value) => h('span', { title: value }, formatTimelineTick(value)))
        )
        : null
    );
  }

  if (chartType === 'swimlane') {
    return renderSwimlaneChart(points, timeRange);
  }

  const finiteValues = points.map((point) => toNumber(point.y)).filter(Number.isFinite);
  const maximum = Math.max(...finiteValues, 1);
  const plotWidth = BAR_CHART_RIGHT - BAR_CHART_LEFT;
  const barWidth = points.length > 0 ? Math.min(14, (plotWidth * 0.8) / points.length) : 14;
  const seriesClassNames = new Map(series.map((item) => [item.name, item.className]));
  const yTicks = [maximum, maximum / 2, 0];
  const xTickIndexes = sampledIndexes(points.length, MAX_BAR_AXIS_TICKS);
  return renderChartWidgetShell(
    'bar',
    null,
    h(
      'svg',
      { viewBox: '0 0 100 42', role: 'img', 'aria-label': `Bar chart with ${points.length} bars` },
      h(
        'g',
        { className: 'bar-chart-y-axis', 'data-chart-axis': 'y', 'aria-hidden': 'true' },
        ...yTicks.flatMap((value) => {
          const y = BAR_CHART_BOTTOM - ((value / maximum) * BAR_CHART_HEIGHT);
          return [
            h('line', { className: 'bar-chart-grid', x1: BAR_CHART_LEFT, y1: y, x2: BAR_CHART_RIGHT, y2: y }),
            h('text', { x: BAR_CHART_LEFT - 1.5, y: y + 1, 'text-anchor': 'end' }, formatNumber(value, unit))
          ];
        }),
        h('line', {
          className: 'bar-chart-axis',
          x1: BAR_CHART_LEFT,
          y1: BAR_CHART_BOTTOM - BAR_CHART_HEIGHT,
          x2: BAR_CHART_LEFT,
          y2: BAR_CHART_BOTTOM
        })
      ),
      h('line', {
        className: 'bar-chart-axis',
        x1: BAR_CHART_LEFT,
        y1: BAR_CHART_BOTTOM,
        x2: BAR_CHART_RIGHT,
        y2: BAR_CHART_BOTTOM
      }),
      ...points.map((point, index) => {
        const x = BAR_CHART_LEFT + (((index + 0.5) / Math.max(points.length, 1)) * plotWidth) - (barWidth / 2);
        const height = Math.max(1, (Math.max(0, toNumber(point.y)) / maximum) * BAR_CHART_HEIGHT);
        return h('rect', {
          className: `bar-chart-bar ${seriesClassNames.get(point.color ?? 'value') ?? 'chart-series-1'}`,
          style: `--chart-entry-index: ${index}`,
          x,
          y: BAR_CHART_BOTTOM - height,
          width: barWidth,
          height,
          rx: 0.75,
          tabIndex: 0,
          role: 'img',
          'aria-label': chartPointLabel(point, unit)
        }, h('title', null, chartPointLabel(point, unit)));
      }),
      h(
        'g',
        { className: 'bar-chart-x-axis', 'data-chart-axis': 'x', 'aria-hidden': 'true' },
        ...xTickIndexes.map((index) => {
          const point = points[index];
          const x = BAR_CHART_LEFT + (((index + 0.5) / points.length) * plotWidth);
          return h(
            'text',
            { x, y: 41.5, 'text-anchor': 'middle', title: point.x },
            h('title', null, point.x),
            compactAxisLabel(point.x)
          );
        })
      )
    )
  );
}

/**
 * Keeps line-series SVG output bounded while retaining the first, last, and
 * visual extrema (minimum and maximum SVG y-coordinates) in each bucket.
 * @template T
 * @param {Array<T & { y: number }>} coordinates
 * @param {number} limit
 * @returns {Array<T & { y: number }>}
 */
function sampleLineCoordinates(coordinates, limit) {
  if (coordinates.length <= limit) return coordinates;
  if (limit <= 2) return [coordinates[0], coordinates[coordinates.length - 1]];
  // Budget for interior points, excluding the mandatory first/last endpoints.
  const interiorBudget = limit - 2;
  const bucketCount = Math.max(1, Math.floor(interiorBudget / 2));
  const bucketSize = (coordinates.length - 2) / bucketCount;
  const sampled = [coordinates[0]];
  let interiorCount = 0;
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    if (interiorCount >= interiorBudget) break;
    const start = 1 + Math.floor(bucket * bucketSize);
    const end = Math.min(coordinates.length - 1, 1 + Math.floor((bucket + 1) * bucketSize));
    let minimumIndex = start;
    let maximumIndex = start;
    for (let index = start + 1; index < end; index += 1) {
      if (coordinates[index].y < coordinates[minimumIndex].y) minimumIndex = index;
      if (coordinates[index].y > coordinates[maximumIndex].y) maximumIndex = index;
    }
    sampled.push(coordinates[Math.min(minimumIndex, maximumIndex)]);
    interiorCount += 1;
    // Only add the second extremum if the interior budget still allows it, so
    // very small limits (e.g. 3) can't push the total output above `limit`.
    if (minimumIndex !== maximumIndex && interiorCount < interiorBudget) {
      sampled.push(coordinates[Math.max(minimumIndex, maximumIndex)]);
      interiorCount += 1;
    }
  }
  sampled.push(coordinates[coordinates.length - 1]);
  return sampled;
}

/**
 * @param {ChartPointLike[]} points
 * @param {string} valueLabel
 * @param {{ name: string, symbol: string, significant: number } | null} unit
 * @returns {HTMLElement}
 */
function renderHeatmapChart(points, valueLabel, unit) {
  const columns = [...new Set(points.map((point) => point.x))].sort((left, right) => left.localeCompare(right));
  const rows = [...new Set(points.map((point) => point.color ?? 'unknown'))].sort((left, right) => left.localeCompare(right));
  const cellCount = columns.length * rows.length;
  if (
    points.length > MAX_HEATMAP_CELLS
    || cellCount > MAX_HEATMAP_CELLS
    || columns.length > MAX_HEATMAP_AXIS_CATEGORIES
    || rows.length > MAX_HEATMAP_AXIS_CATEGORIES
  ) {
    return renderChartWidgetEmptyState(
      'heatmap',
      `This heatmap is too large to display. Limit it to ${MAX_HEATMAP_CELLS} cells and ${MAX_HEATMAP_AXIS_CATEGORIES} categories per axis.`
    );
  }

  const cells = new Map(points.map((point) => [JSON.stringify([point.x, point.color ?? 'unknown']), point]));
  const values = points.map((point) => toNumber(point.y)).filter(Number.isFinite);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const span = maximum - minimum;

  return renderChartWidgetShell(
    'heatmap',
    null,
    h(
      'div',
      { className: 'heatmap-scroll-region', tabIndex: 0, role: 'region', 'aria-label': 'Heatmap chart' },
      h(
        'table',
        { className: 'heatmap-chart' },
        h('caption', { className: 'sr-only' }, `Heatmap of ${valueLabel}`),
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('td', { 'aria-hidden': 'true' }),
            ...columns.map((column) => h('th', { scope: 'col' }, column))
          )
        ),
        h(
          'tbody',
          null,
          ...rows.map((row) => h(
            'tr',
            null,
            h('th', { scope: 'row' }, row),
            ...columns.map((column) => {
              const point = cells.get(JSON.stringify([column, row]));
              if (!point) {
                return h('td', {
                  className: 'heatmap-cell heatmap-cell-empty',
                  tabIndex: 0,
                  'aria-label': `${column}, ${row}: no observation`
                }, '');
              }
              const value = toNumber(point.y);
              const formatted = formatNumber(value, unit);
              const intensity = span > 0 ? 12 + (((value - minimum) / span) * 28) : 26;
              return h(
                'td',
                {
                  className: 'heatmap-cell',
                  style: `--heatmap-intensity: ${intensity.toFixed(1)}%`,
                  tabIndex: 0,
                  'aria-label': `${column}, ${row}, ${valueLabel}: ${formatted}`
                },
                formatted
              );
            })
          ))
        )
      )
    )
  );
}

/**
 * @param {ChartPointLike[]} points
 * @param {Record<string, unknown> | null} timeRange
 * @returns {HTMLElement}
 */
function renderSwimlaneChart(points, timeRange) {
  const timestamps = new Float64Array(points.length);
  const laneIndexes = new Int8Array(points.length);
  laneIndexes.fill(-1);
  const counts = Object.fromEntries(SWIMLANE_DEFINITIONS.map(([lane]) => [lane, 0]));
  let plottedCount = 0;
  let firstObserved = Number.POSITIVE_INFINITY;
  let lastObserved = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const timestamp = Date.parse(String(point.x));
    const lane = swimlaneConclusion(point.category ?? point.color);
    if (!Number.isFinite(timestamp) || !lane) continue;
    timestamps[index] = timestamp;
    laneIndexes[index] = SWIMLANE_DEFINITIONS.findIndex(([candidate]) => candidate === lane);
    counts[lane] += 1;
    plottedCount += 1;
    firstObserved = Math.min(firstObserved, timestamp);
    lastObserved = Math.max(lastObserved, timestamp);
  }
  if (plottedCount === 0) {
    return renderChartWidgetEmptyState('swimlane', 'No workflow runs to show.');
  }
  let start = Date.parse(String(timeRange?.start ?? ''));
  let end = Date.parse(String(timeRange?.end ?? ''));
  if (!Number.isFinite(start)) start = firstObserved;
  if (!Number.isFinite(end)) end = lastObserved;
  if (start === end) {
    start -= 43_200_000;
    end += 43_200_000;
  }
  const span = Math.max(end - start, 1);
  const successes = counts.success;
  const summary = [
    `${formatCount(plottedCount)} runs`,
    `${formatCoveragePercent(successes / plottedCount, '0.0%')} success`,
    `${formatCount(counts.failure)} failed`,
    `${formatCount(counts.skipped)} skipped`,
    `${formatCount(counts['action-required'])} action required`
  ];
  const ticks = Array.from({ length: 4 }, (_, index) => start + ((span * index) / 3));
  /** @param {number} timestamp */
  const xCoordinate = (timestamp) => SWIMLANE_START_X
    + (Math.min(1, Math.max(0, (timestamp - start) / span)) * (SWIMLANE_END_X - SWIMLANE_START_X));
  const sectionsByLane = buildSwimlaneSections(points, timestamps, laneIndexes, xCoordinate);

  return renderChartWidgetShell(
    'swimlane',
    null,
    h(
      'ul',
      { className: 'swimlane-summary', 'aria-label': 'Run summary' },
      summary.map((value) => h('li', null, value))
    ),
    h(
      'svg',
      {
        viewBox: '0 0 120 62',
        role: 'img',
        'aria-label': `Categorical swimlane timeline with ${plottedCount} workflow runs`
      },
      ...SWIMLANE_DEFINITIONS.flatMap(([lane, label], laneIndex) => {
        const y = 7 + (laneIndex * 10);
        return [
          h('text', { className: 'swimlane-label', x: 23, y: y + 1, 'text-anchor': 'end' }, label),
          h('line', { className: 'swimlane-separator', x1: 25, y1: y, x2: 117, y2: y }),
          ...(sectionsByLane.get(lane) ?? []).map((section) => renderSwimlaneSection(section, y))
        ];
      }),
      h('line', { className: 'swimlane-axis', x1: 25, y1: 54, x2: 117, y2: 54 }),
      ...ticks.map((instant, index) => {
        const x = xCoordinate(instant);
        return [
          h('line', { className: 'swimlane-tick', x1: x, y1: 54, x2: x, y2: 56 }),
          h('text', {
            className: 'swimlane-time-label',
            x,
            y: 61,
            'text-anchor': index === 0 ? 'start' : index === ticks.length - 1 ? 'end' : 'middle'
          }, formatSwimlaneAxisTime(instant, span))
        ];
      })
    )
  );
}

/**
 * Coalesces observations into a fixed number of visual buckets per lane, then
 * combines neighboring occupied buckets into contiguous sections.
 * @param {ChartPointLike[]} points
 * @param {Float64Array} timestamps
 * @param {Int8Array} laneIndexes
 * @param {(timestamp: number) => number} xCoordinate
 */
function buildSwimlaneSections(points, timestamps, laneIndexes, xCoordinate) {
  const binCount = MAX_SWIMLANE_SECTIONS_PER_LANE;
  const sectionWidth = (SWIMLANE_END_X - SWIMLANE_START_X) / binCount;
  /** @type {Map<string, Array<{ count: number, first: number, last: number, point: ChartPointLike & { lane: string, timestamp: number } } | null>>} */
  const binsByLane = new Map(SWIMLANE_DEFINITIONS.map(([lane]) => [lane, Array(binCount).fill(null)]));
  for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
    const laneIndex = laneIndexes[pointIndex];
    if (laneIndex < 0) continue;
    const timestamp = timestamps[pointIndex];
    const lane = SWIMLANE_DEFINITIONS[laneIndex][0];
    const x = xCoordinate(timestamp);
    const index = Math.min(binCount - 1, Math.max(0, Math.floor((x - SWIMLANE_START_X) / sectionWidth)));
    const bins = /** @type {NonNullable<ReturnType<typeof binsByLane.get>>} */ (binsByLane.get(lane));
    const bin = bins[index];
    if (bin) {
      bin.count += 1;
      bin.first = Math.min(bin.first, timestamp);
      bin.last = Math.max(bin.last, timestamp);
    } else {
      bins[index] = { count: 1, first: timestamp, last: timestamp, point: { ...points[pointIndex], lane, timestamp } };
    }
  }

  /** @type {Map<string, Array<{ lane: string, x1: number, x2: number, count: number, first: number, last: number, point: ChartPointLike & { lane: string, timestamp: number } }>>} */
  const sectionsByLane = new Map();
  for (const [lane, bins] of binsByLane) {
    /** @type {Array<{ lane: string, x1: number, x2: number, count: number, first: number, last: number, point: ChartPointLike & { lane: string, timestamp: number } }>} */
    const sections = [];
    for (let index = 0; index < bins.length; index += 1) {
      const bin = bins[index];
      if (!bin) continue;
      const previous = sections.at(-1);
      const x1 = SWIMLANE_START_X + (index * sectionWidth);
      const x2 = Math.min(SWIMLANE_END_X, x1 + sectionWidth);
      if (previous && Math.abs(previous.x2 - x1) < 1e-9) {
        previous.x2 = x2;
        previous.count += bin.count;
        previous.first = Math.min(previous.first, bin.first);
        previous.last = Math.max(previous.last, bin.last);
      } else {
        sections.push({ lane, x1, x2, ...bin });
      }
    }
    sectionsByLane.set(lane, sections);
  }
  return sectionsByLane;
}

/** @param {{ lane: string, x1: number, x2: number, count: number, first: number, last: number, point: Record<string, any> }} section @param {number} y */
function renderSwimlaneSection(section, y) {
  const label = section.count === 1
    ? swimlaneTooltipLines(section.point).join(', ')
    : `${formatCount(section.count)} ${section.lane} runs, ${formatSwimlaneTooltipTime(section.first)} to ${formatSwimlaneTooltipTime(section.last)}`;
  return h('line', {
    className: `chart-point swimlane-mark swimlane-run-mark swimlane-mark-${section.lane}`,
    x1: section.x1,
    y1: y,
    x2: section.x2,
    y2: y,
    tabIndex: 0,
    role: 'img',
    'aria-label': label,
    'data-swimlane-lane': section.lane,
    'data-swimlane-count': section.count
  });
}

/** @param {Record<string, any>} point @returns {string[]} */
function swimlaneTooltipLines(point) {
  const source = point.source ?? {};
  const lines = [
    formatSwimlaneTooltipTime(point.timestamp),
    `Conclusion: ${point.lane}`
  ];
  const run = String(source.run ?? '').trim();
  const branch = String(source.branch ?? source.ref ?? source['head-branch'] ?? '').trim();
  const started = Date.parse(String(source['started-at'] ?? ''));
  const ended = Date.parse(String(source['ended-at'] ?? ''));
  if (run) lines.push(`Run #${run}`);
  if (branch) lines.push(`Branch: ${branch}`);
  if (Number.isFinite(started) && Number.isFinite(ended) && ended >= started) {
    lines.push(`Duration: ${formatSwimlaneDuration(ended - started)}`);
  }
  return lines;
}

/** @param {unknown} value @returns {string | null} */
function swimlaneConclusion(value) {
  const conclusion = String(value ?? '').toLowerCase();
  if (SWIMLANE_FAILURES.has(conclusion)) return 'failure';
  return SWIMLANE_DEFINITIONS.some(([lane]) => lane === conclusion) ? conclusion : null;
}

/** @param {number} instant @param {number} span */
function formatSwimlaneAxisTime(instant, span) {
  return new Intl.DateTimeFormat('en', span <= 86_400_000
    ? { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }
    : { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(instant));
}

/** @param {number} instant */
function formatSwimlaneTooltipTime(instant) {
  const parts = new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'UTC'
  }).formatToParts(new Date(instant));
  /** @param {string} type */
  const value = (type) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('month')} ${value('day')}, ${value('year')} · ${value('hour')}:${value('minute')}:${value('second')}`;
}

/** @param {number} milliseconds */
function formatSwimlaneDuration(milliseconds) {
  const seconds = Math.round(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours ? `${hours}h` : '', minutes ? `${minutes}m` : '', `${remainder}s`].filter(Boolean).join(' ');
}

/**
 * @param {number} pointCount
 * @returns {number}
 */
function lineChartPointSize(pointCount) {
  const progress = Math.min(1, Math.max(0, (pointCount - 2) / (MIN_RADIUS_POINT_COUNT - 2)));
  return MAX_LINE_POINT_SIZE - (progress * (MAX_LINE_POINT_SIZE - MIN_LINE_POINT_SIZE));
}

/**
 * @param {number} pointCount
 * @returns {number}
 */
function dotChartPointRadius(pointCount) {
  const progress = Math.min(1, Math.max(0, (pointCount - 2) / (MIN_RADIUS_POINT_COUNT - 2)));
  return MAX_DOT_POINT_RADIUS - (progress * (MAX_DOT_POINT_RADIUS - MIN_DOT_POINT_RADIUS));
}

/**
 * @param {string[]} values
 * @returns {string[]}
 */
function lineChartTimelineTicks(values) {
  const tickCount = Math.min(values.length, MAX_TIMELINE_TICKS);
  if (tickCount < 2) return values;

  return Array.from(
    { length: tickCount },
    (_, index) => values[Math.round((index / (tickCount - 1)) * (values.length - 1))]
  );
}

/**
 * @param {number[]} values
 * @param {number} minimum
 * @param {number} maximum
 * @returns {string[]}
 */
function scatterChartTimeAxisTicks(values, minimum, maximum) {
  const validValues = [...new Set(values.filter(Number.isFinite))];
  const tickCount = Math.min(validValues.length, MAX_TIMELINE_TICKS);
  if (tickCount === 0) return [];
  if (tickCount === 1 || maximum === minimum) return [new Date(minimum).toISOString()];

  // Equal time intervals align these flex-distributed labels with proportional scatter positions.
  return Array.from(
    { length: tickCount },
    (_, index) => new Date(minimum + ((index / (tickCount - 1)) * (maximum - minimum))).toISOString()
  );
}

/**
 * @param {number} valueCount
 * @param {number} maximumCount
 * @returns {number[]}
 */
function sampledIndexes(valueCount, maximumCount) {
  const tickCount = Math.min(valueCount, maximumCount);
  if (tickCount < 2) return Array.from({ length: tickCount }, (_, index) => index);

  return Array.from(
    { length: tickCount },
    (_, index) => Math.round((index / (tickCount - 1)) * (valueCount - 1))
  );
}

/** @param {string} value */
function compactAxisLabel(value) {
  const formatted = formatTimelineTick(value);
  return formatted.length > 12 ? `${formatted.slice(0, 11)}…` : formatted;
}

/**
 * @param {string} value
 * @returns {string}
 */
function formatTimelineTick(value) {
  if (!/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) return value;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;

  const options = value.includes('T')
    ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC', timeZoneName: 'short' }
    : { month: 'short', day: 'numeric', timeZone: 'UTC' };
  return new Intl.DateTimeFormat('en', /** @type {Intl.DateTimeFormatOptions} */ (options)).format(date);
}

/**
 * @param {{ x: string, y: number, color: string | null, source?: Record<string, unknown> }} point
 * @param {{ name: string, symbol: string, significant: number } | null} [unit]
 * @returns {string}
 */
function chartPointLabel(point, unit = null) {
  const clusterCount = Number(point.source?.['cluster-count']);
  return `${point.x}: ${formatNumber(point.y, unit)}${point.color ? `, ${point.color}` : ''}${clusterCount > 1 ? `, cluster of ${formatNumber(clusterCount, null)} observations` : ''}`;
}
