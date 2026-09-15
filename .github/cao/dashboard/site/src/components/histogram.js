/**
 * Compact, reusable SVG histogram.
 */

import { h } from '../dom.js';
import { automaticHistogramBinCount, binHistogramValues } from '../table-summary-data.js';

export { automaticHistogramBinCount, binHistogramValues } from '../table-summary-data.js';

/**
 * @param {{
 *   values: number[],
 *   label: string,
 *   width?: number,
 *   height?: number,
 *   binCount?: number
 * }} options
 * @returns {SVGElement}
 */
export function renderHistogram(options) {
  const {
    values,
    label,
    width = 120,
    height = 32,
    binCount = automaticHistogramBinCount(values)
  } = options;
  const bins = binHistogramValues(values, binCount);
  return renderHistogramBins({ bins, label, width, height });
}

/**
 * @param {{
 *   bins: Array<{ lower: number, upper: number, count: number }>,
 *   label: string,
 *   width?: number,
 *   height?: number
 * }} options
 * @returns {SVGElement}
 */
export function renderHistogramBins(options) {
  const {
    bins,
    label,
    width = 120,
    height = 32
  } = options;
  const maximumCount = Math.max(0, ...bins.map((bin) => bin.count));
  const gap = 1;
  const barWidth = bins.length > 0 ? width / bins.length : width;

  return /** @type {SVGElement} */ (/** @type {unknown} */ (h(
    'svg',
    {
      className: 'table-summary-histogram',
      viewBox: `0 0 ${width} ${height}`,
      role: 'img',
      'aria-label': label
    },
    h('title', null, label),
    ...bins.map((bin, index) => {
      const barHeight = maximumCount > 0 ? (bin.count / maximumCount) * height : 0;
      return h('rect', {
        style: `--chart-entry-index: ${index}`,
        x: (index * barWidth) + gap / 2,
        y: height - barHeight,
        width: Math.max(0, barWidth - gap),
        height: barHeight
      });
    })
  )));
}
