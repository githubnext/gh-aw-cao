/**
 * Reusable GitHub Primer table region wrapper component.
 */

import { h } from '../dom.js';
import { processRows, processTableSummaries } from '../data-processor.js';
import { formatCount } from './count-formatters.js';
import { renderReactiveTableSummaryRow, renderTableSummaryRow } from './table-summary.js';
import { renderEmptyTableRow, renderLabeledControl } from './ui-primitives.js';

/**
 * @typedef {{ key: string, label: string, allLabel?: string, columnIndex: number, always?: boolean }} TableFilterField
 */

const DEFAULT_PAGE_SIZE = 25;

/**
 * Renders a table inside a scroll region. Column sorting is enabled
 * by default whenever `filterLabel` is provided, and can be forced with `sortable`.
 *
 * @param {{
 *   tableClassName: string,
 *   regionClassName?: string,
 *   emptyMessage: string,
 *   colSpan: number,
 *   headCells: string[],
 *   unsortableColumns?: number[],
 *   summaryColumns?: import('../table-summary-data.js').TableSummaryColumn[],
 *   bodyRows: unknown,
 *   filterLabel?: string,
 *   filterId?: string,
 *   filterPlaceholder?: string,
 *   filterFields?: TableFilterField[],
 *   lazyList?: boolean,
 *   pageSize?: number,
 *   resultNoun?: string,
 *   resultNounPlural?: string,
 *   sortable?: boolean,
 *   tableRole?: string
 * }} options
 * @returns {HTMLElement}
 */
export function renderTableRegion(options) {
  const {
    tableClassName,
    regionClassName,
    emptyMessage,
    colSpan,
    headCells,
    unsortableColumns = [],
    summaryColumns = [],
    bodyRows,
    filterLabel,
    filterId,
    filterPlaceholder = 'Filter rows',
    filterFields = [],
    lazyList = false,
    pageSize = DEFAULT_PAGE_SIZE,
    resultNoun,
    resultNounPlural
  } = options;
  const rowCount = getBodyRowCount(bodyRows);
  const hasRows = rowCount > 0;
  const facets = getTableFacets(bodyRows, filterFields, rowCount);
  const sortable = options.sortable ?? Boolean(filterLabel);
  const interactive = hasRows && Boolean(filterLabel);

  const region = h(
    'div',
    {
      className: `table-region${regionClassName ? ` ${regionClassName}` : ''}`,
      ...(lazyList ? { 'data-lazy-list': '' } : {})
    },
    interactive
      ? h(
        'div',
        { className: 'table-filter' },
        renderLabeledControl(filterLabel ?? '', h('input', {
          type: 'search',
          placeholder: filterPlaceholder,
          'data-table-filter': ''
        }), { visuallyHiddenLabel: true }),
        ...facets.map((facet) => renderLabeledControl(
          facet.label,
          h(
            'select',
            { 'data-table-facet': facet.key, 'data-table-column-index': String(facet.columnIndex) },
            h('option', { value: '' }, facet.allLabel ?? `All ${facet.label.toLocaleLowerCase('en')}`),
            ...facet.values.map((value) => h('option', { value }, value))
          ),
          { className: 'table-filter-facet' }
        )),
        h('output', { className: 'table-filter-result', 'aria-live': 'polite' }, formatResultCount(Math.min(rowCount, pageSize), rowCount, resultNoun, resultNounPlural))
      )
      : null,
    h(
      'div',
      {
        className: 'table-scroll',
        tabIndex: 0,
        ...(filterLabel ? { role: 'region', 'aria-label': `${filterLabel} results` } : {})
      },
      h(
        'table',
        {
          className: tableClassName,
          ...(options.tableRole ? { role: options.tableRole } : {}),
          ...(tableClassName === 'custom-table' ? { 'data-custom-view-mark': 'table' } : {})
        },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            ...headCells.map((cell, columnIndex) => (hasRows && sortable && !unsortableColumns.includes(columnIndex)
              ? h(
                'th',
                { scope: 'col', 'aria-sort': 'none' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'table-sort',
                    'data-table-sort': String(columnIndex)
                  },
                  cell
                )
              )
              : h('th', { scope: 'col' }, cell)))
          ),
          summaryColumns.length > 0 ? renderDeferredTableSummaryRow(summaryColumns) : null
        ),
        h(
          'tbody',
          null,
          hasRows
            ? bodyRows
            : renderEmptyTableRow(colSpan, emptyMessage)
        )
      )
    ),
    interactive
      ? h('button', { className: 'table-filter-more', type: 'button', 'data-table-more': '' }, lazyList ? 'Load more rows' : 'Show all rows')
      : null
  );

  if (lazyList) {
    const scroll = region.querySelector('.table-scroll');
    const more = region.querySelector('[data-table-more]');
    if (scroll && more) scroll.append(more);
  }

  if (hasRows && sortable) {
    enableTableSort(region);
  }

  if (interactive) {
    enableTableFilter(region, { filterId, lazyList, pageSize, resultNoun, resultNounPlural });
  }
  return region;
}

/**
 * @param {import('../table-summary-data.js').TableSummaryColumn[]} columns
 * @returns {HTMLTableRowElement}
 */
function renderDeferredTableSummaryRow(columns) {
  const result = processTableSummaries(columns);
  if (!(result instanceof Promise)) {
    return renderTableSummaryRow(result.map((summary, index) => ({ ...summary, label: columns[index]?.label ?? '' })));
  }
  return renderReactiveTableSummaryRow(columns, result);
}

/**
 * Enables click-to-sort on column headers, cycling ascending then descending.
 *
 * @param {HTMLElement} region
 */
function enableTableSort(region) {
  const body = region.querySelector('tbody');
  if (!(body instanceof HTMLTableSectionElement)) return;
  const headers = [...region.querySelectorAll('th[aria-sort]')]
    .filter((header) => header instanceof HTMLTableCellElement);
  let revision = 0;

  for (const header of headers) {
    const control = header.querySelector('[data-table-sort]');
    if (!(control instanceof HTMLButtonElement)) continue;
    const columnIndex = Number(control.dataset.tableSort);
    control.addEventListener('click', () => {
      const direction = header.getAttribute('aria-sort') === 'ascending' ? 'descending' : 'ascending';
      const requestRevision = ++revision;
      for (const other of headers) other.setAttribute('aria-sort', 'none');
      header.setAttribute('aria-sort', direction);
      const rows = [...body.rows];
      const result = processRows(
        rows.map((row, index) => ({ index, value: cellText(row, columnIndex) })),
        [{ op: 'arrange', by: [{ field: 'value', direction: direction === 'descending' ? 'desc' : 'asc' }] }]
      );
      applyProcessed(result, (processed) => {
        if (requestRevision !== revision) return;
        for (const item of processed) body.append(rows[Number(item.index)]);
        region.dispatchEvent(new Event('table-sorted'));
      });
    });
  }
}

/**
 * @param {HTMLTableRowElement} row
 * @param {number} columnIndex
 * @returns {string}
 */
function cellText(row, columnIndex) {
  return row.cells[columnIndex]?.textContent?.trim() ?? '';
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
/**
 * @param {HTMLElement} region
 * @param {{ filterId?: string, lazyList: boolean, pageSize: number, resultNoun?: string, resultNounPlural?: string }} options
 */
function enableTableFilter(region, options) {
  const input = region.querySelector('[data-table-filter]');
  const output = region.querySelector('.table-filter-result');
  const more = region.querySelector('[data-table-more]');
  const facets = [...region.querySelectorAll('[data-table-facet]')]
   .filter((facet) => facet instanceof HTMLSelectElement);
  const currentRows = () => [...region.querySelectorAll('tbody > tr')]
   .filter((row) => row instanceof HTMLTableRowElement);
  if (
   !(input instanceof HTMLInputElement)
   || !(output instanceof HTMLOutputElement)
   || !(more instanceof HTMLButtonElement)
  ) return;

  const window = region.ownerDocument.defaultView;
  const parameters = new URLSearchParams(window?.location.search ?? '');
  /** @param {string} name */
  const parameterName = (name) => options.filterId ? `${options.filterId}.${name}` : null;
  const queryParameter = parameterName('q');
  if (queryParameter) input.value = parameters.get(queryParameter) ?? '';
  for (const facet of facets) {
   const facetParameter = parameterName(facet.dataset.tableFacet ?? '');
   const value = facetParameter ? parameters.get(facetParameter) : null;
   if (value && [...facet.options].some((option) => option.value === value)) {
     facet.value = value;
   }
  }

  let limit = options.pageSize;
  let revision = 0;
  const apply = (reset = false) => {
   if (reset) limit = options.pageSize;
   region.classList.toggle('table-region-expanded', !Number.isFinite(limit));
   const query = input.value.trim().toLocaleLowerCase('en');
   const rows = currentRows();
   const requestRevision = ++revision;
   const predicates = facets
     .filter((facet) => facet.value !== '')
     .map((facet) => ({ field: `column-${facet.dataset.tableColumnIndex}`, equals: facet.value }));
   const result = processRows(
     rows.map((row, index) => ({
       index,
       search: row.textContent ?? '',
       ...Object.fromEntries([...row.cells].map((cell, columnIndex) => [`column-${columnIndex}`, cell.textContent?.trim() ?? '']))
     })),
     [{ op: 'filter', search: { fields: ['search'], query }, predicates }]
   );
   applyProcessed(result, (processed) => {
     if (requestRevision !== revision) return;
     const matchedIndexes = new Set(processed.map((item) => Number(item.index)));
     let shown = 0;
     for (const [index, row] of rows.entries()) {
       const visible = matchedIndexes.has(index) && shown < limit;
       row.hidden = !visible;
       if (visible) shown += 1;
     }
     output.textContent = formatResultCount(shown, processed.length, options.resultNoun, options.resultNounPlural);
     more.hidden = shown >= processed.length;
   });
  };

  const syncUrl = () => {
   if (!window || !options.filterId || !['http:', 'https:'].includes(window.location.protocol)) return;
   const currentParameters = new URLSearchParams(window.location.search);
   const values = [
     ['q', input.value.trim()],
     ...facets.map((facet) => [facet.dataset.tableFacet ?? '', facet.value])
   ];
   for (const [name, value] of values) {
     const key = parameterName(name);
     if (!key) continue;
     if (value) currentParameters.set(key, value);
     else currentParameters.delete(key);
   }
   const query = currentParameters.toString();
   window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
  };

  for (const control of [input, ...facets]) {
   control.addEventListener('input', () => {
     syncUrl();
     apply(true);
   });
  }
  const loadMore = () => {
   limit = options.lazyList ? limit + options.pageSize : Number.POSITIVE_INFINITY;
   apply();
  };
  more.addEventListener('click', loadMore);
  region.addEventListener('table-sorted', () => apply());
  apply();
  const Observer = region.ownerDocument.defaultView?.IntersectionObserver;
  if (options.lazyList && typeof Observer === 'function') {
   const observer = new Observer((entries) => {
     if (entries.some((entry) => entry.isIntersecting) && !more.hidden) loadMore();
   }, { root: region.querySelector('.table-scroll'), rootMargin: '200px 0px' });
   observer.observe(more);
  }
}

/**
 * Handles the synchronous fallback and asynchronous worker result uniformly.
 * @param {Array<Record<string, unknown>>|Promise<Array<Record<string, unknown>>>} result
 * @param {(rows: Array<Record<string, unknown>>) => void} apply
 */
function applyProcessed(result, apply) {
  if (result instanceof Promise) {
   result.then(apply).catch(() => {});
  } else {
   apply(result);
  }
}

/**
 * @param {number} shown
 * @param {number} matched
 * @returns {string}
 * @param {string} [noun]
 * @param {string} [pluralNoun]
 */
function formatResultCount(shown, matched, noun = 'result', pluralNoun = `${noun}s`) {
  return `Showing ${formatCount(shown)} of ${formatCount(matched)} ${matched === 1 ? noun : pluralNoun}`;
}

/**
 * @param {unknown} bodyRows
 * @param {TableFilterField[]} filterFields
 * @param {number} rowCount
 * @returns {Array<TableFilterField & { values: string[] }>}
 */
function getTableFacets(bodyRows, filterFields, rowCount) {
  if (!Array.isArray(bodyRows)) return [];
  return filterFields.flatMap((field) => {
   const values = [...new Set(bodyRows
     .map((row) => row instanceof HTMLTableRowElement
       ? row.cells[field.columnIndex]?.textContent?.trim() ?? ''
       : '')
     .filter(Boolean))]
     .sort((left, right) => left.localeCompare(right));
   return ((values.length > 1 && values.length < rowCount && values.length <= 10) || (field.always && values.length > 0))
     ? [{ ...field, values }]
     : [];
  });
}

/**
 * @param {unknown} bodyRows
 * @returns {number}
 */
function getBodyRowCount(bodyRows) {
  if (Array.isArray(bodyRows)) {
    return bodyRows.length;
  }
  if (typeof bodyRows === 'object' && bodyRows !== null && 'items' in bodyRows) {
    const keyedBodyRows = /** @type {{ items?: unknown[] }} */ (bodyRows);
    return Array.isArray(keyedBodyRows.items) ? keyedBodyRows.items.length : 0;
  }
  if (typeof bodyRows === 'object' && bodyRows !== null && 'length' in bodyRows) {
    const collection = /** @type {{ length?: number }} */ (bodyRows);
    return typeof collection.length === 'number' ? collection.length : 0;
  }
  return bodyRows ? 1 : 0;
}
