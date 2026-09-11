/**
 * Observable-inspired table column summaries.
 */

import { h } from '../dom.js';
import { effect, state } from '../reactive.js';
import { renderHistogramBins } from './histogram.js';
import { formatCount, formatCountNoun } from './count-formatters.js';
import { renderDefinitionListRows } from './view-chrome.js';
import { formatMediumUtcDateTime, renderLegendList, renderSkeletonBars, renderTableSummaryEmpty } from './ui-primitives.js';
import { formatClockDuration, formatPercent } from '../view-formatters.js';
import { chartSeriesClassName, renderChartWidget } from './chart-elements.js';

/**
 * @typedef {import('../table-summary-data.js').TableColumnSummary & { label: string }} RenderableTableColumnSummary
 */

/**
 * @param {RenderableTableColumnSummary[]} columns
 * @returns {HTMLTableRowElement}
 */
export function renderTableSummaryRow(columns) {
  return /** @type {HTMLTableRowElement} */ (h(
    'tr',
    { className: 'table-summary-row' },
    ...columns.map((column) => h(
      'th',
      { scope: 'col', className: 'table-summary-cell' },
      renderColumnSummary(column)
    ))
  ));
}

/**
 * @param {import('../table-summary-data.js').TableSummaryColumn[]} columns
 * @param {Promise<import('../table-summary-data.js').TableColumnSummary[]>} pendingSummaries
 * @returns {HTMLTableRowElement}
 */
export function renderReactiveTableSummaryRow(columns, pendingSummaries) {
  const summaries = state(/** @type {import('../table-summary-data.js').TableColumnSummary[] | null} */ (null));
  const row = /** @type {HTMLTableRowElement} */ (h(
    'tr',
    { className: 'table-summary-row' },
    ...columns.map((column, index) => renderReactiveTableSummaryCell(column, index, summaries))
  ));
  pendingSummaries.then((value) => summaries.set(value)).catch(() => summaries.set([]));
  return row;
}

/**
 * @param {import('../table-summary-data.js').TableSummaryColumn} column
 * @param {number} index
 * @param {import('../reactive.js').State<import('../table-summary-data.js').TableColumnSummary[] | null>} summaries
 * @returns {HTMLTableCellElement}
 */
function renderReactiveTableSummaryCell(column, index, summaries) {
  const cell = /** @type {HTMLTableCellElement} */ (h(
    'th',
    { scope: 'col', className: 'table-summary-cell', 'aria-busy': 'true' },
    renderTableSummarySkeleton()
  ));
  const handle = effect(() => {
    const value = summaries.get();
    if (value === null) return;
    const summary = value[index] ?? { kind: 'none' };
    const content = renderColumnSummary({ ...summary, label: column.label });
    cell.replaceChildren(...(content ? [content] : []));
    cell.removeAttribute('aria-busy');
    handle.stop();
  });
  return cell;
}

/**
 * @returns {HTMLElement}
 */
function renderTableSummarySkeleton() {
  return renderSkeletonBars('table-summary-skeleton');
}

/**
 * @param {RenderableTableColumnSummary} column
 * @returns {HTMLElement | null}
 */
function renderColumnSummary(column) {
  if (column.kind === 'none') return null;
  if (column.kind === 'empty') return renderTableSummaryEmpty(column.message);
  if (column.kind === 'boolean') {
    const totalCount = Math.max(0, column.count);
    const missingCount = Math.min(totalCount, Math.max(0, column.missingCount));
    const observedCount = Math.max(0, totalCount - missingCount);
    if (observedCount === 0) return null;
    const yesCount = Math.min(observedCount, Math.max(0, column.trueCount));
    const noCount = Math.max(0, observedCount - yesCount);
    const skippedCount = Math.max(0, totalCount - observedCount);
    /** @type {Array<[string, number]>} */
    const candidateEntries = [
      ['yes', yesCount],
      ['no', noCount],
      ['skipped', skippedCount]
    ];
    /** @type {Array<[string, number]>} */
    const entries = [];
    for (const [label, value] of candidateEntries) {
      if (value > 0) entries.push([label, value]);
    }
    return h(
      'div',
      { className: 'table-summary-boolean' },
      renderChartWidget('pie', [], [], { entries, total: totalCount }, 'Values'),
      renderBooleanLegend(entries, totalCount)
    );
  }
  if (column.kind === 'quantitative') {
    return renderQuantitativeSummary(column);
  }
  if (column.kind === 'temporal') {
    return renderTemporalSummary(column.start, column.stop);
  }
  if (column.kind === 'count') {
    return renderCountSummary(column.count);
  }
  return renderCategoricalSummary(column.values);
}

/**
 * @param {Array<[string, number]>} entries
 * @param {number} total
 * @returns {HTMLElement}
 */
function renderBooleanLegend(entries, total) {
  return renderLegendList(
    'chart-legend chart-legend-pie',
    entries,
    ([label], index) => chartSeriesClassName(label, index),
    ([label, value]) => [
      h('span', { 'aria-label': label }, label === 'yes' ? '✓' : (label === 'no' ? '×' : '•')),
      h('strong', null, formatCount(value)),
      h('small', null, formatPercent(value / total))
    ],
    { 'data-chart-legend': 'visual' }
  );
}

/**
 * @param {number} count
 * @returns {HTMLElement}
 */
function renderCountSummary(count) {
  return h(
    'div',
    { className: 'table-summary-count' },
    formatCountNoun(count, 'item', 'items')
  );
}

/**
 * @param {Array<{ label: string, ratio: number }>} values
 * @returns {HTMLElement}
 */
function renderCategoricalSummary(values) {
  return h(
    'ol',
    { className: 'table-summary-categories', 'aria-label': 'Most common values' },
    ...values.map((value) => h(
      'li',
      null,
      h('span', { title: value.label }, value.label),
      h('strong', null, formatPercent(value.ratio))
    ))
  );
}

/**
 * @param {Extract<RenderableTableColumnSummary, { kind: 'quantitative' }>} summary
 * @returns {HTMLElement}
 */
function renderQuantitativeSummary(summary) {
  return h(
    'div',
    { className: 'table-summary-quantitative' },
    renderHistogramBins({
      bins: summary.bins,
      label: `${summary.label} distribution, ${formatCount(summary.count)} values`
    }),
    h(
      'dl',
      null,
      ...renderDefinitionListRows([
        { label: 'Total', value: formatStatistic(summary.total) },
        { label: 'Avg', value: formatStatistic(summary.mean) },
        { label: 'Stddev', value: summary.deviation === null ? 'N/A' : formatStatistic(summary.deviation) }
      ])
    )
  );
}

/**
 * @param {number} start
 * @param {number} stop
 * @returns {HTMLElement}
 */
function renderTemporalSummary(start, stop) {
  return h(
    'dl',
    { className: 'table-summary-temporal' },
    ...renderDefinitionListRows([
      { label: 'Start', value: formatTimestamp(start) },
      { label: 'Stop', value: formatTimestamp(stop) },
      { label: 'Duration', value: formatDuration(stop - start) }
    ])
  );
}

/**
 * @param {number} timestamp
 * @returns {string}
 */
function formatTimestamp(timestamp) {
  return formatMediumUtcDateTime(timestamp);
}

/**
 * @param {number} duration
 * @returns {string}
 */
function formatDuration(duration) {
  return formatClockDuration(duration);
}

/**
 * @param {number} value
 * @returns {string}
 */
function formatStatistic(value) {
  return value.toLocaleString('en', { maximumFractionDigits: 2 });
}
