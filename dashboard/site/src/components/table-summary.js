/**
 * Observable-inspired table column summaries.
 */

import { h } from '../dom.js';
import { effect, state } from '../reactive.js';
import { renderHistogramBins } from './histogram.js';
import { formatCount, formatCountNoun } from './count-formatters.js';
import { renderDefinitionListRows } from './view-chrome.js';
import { formatMediumUtcDateTime, renderTableSummaryEmpty } from './ui-primitives.js';
import { formatClockDuration, formatPercent } from '../view-formatters.js';

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
  return h(
    'div',
    { className: 'table-summary-skeleton', 'aria-hidden': 'true' },
    h('span'),
    h('span'),
    h('span')
  );
}

/**
 * @param {RenderableTableColumnSummary} column
 * @returns {HTMLElement | null}
 */
function renderColumnSummary(column) {
  if (column.kind === 'none') return null;
  if (column.kind === 'empty') return renderTableSummaryEmpty(column.message);
  if (column.kind === 'boolean') {
    return h(
      'div',
      { className: 'table-summary-boolean' },
      h('strong', null, formatPercent(column.ratio)),
      h('span', null, ' true')
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
