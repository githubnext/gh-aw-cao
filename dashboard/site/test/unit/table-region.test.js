// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderTableRegion } from '../../src/components/table-region.js';
import { processDataRequest } from '../../src/data-worker.js';
import { h } from '../../src/dom.js';

describe('renderTableRegion', () => {
  it('renders headers and provided body rows', () => {
    const rendered = renderTableRegion({
      tableClassName: 'runs-table',
      emptyMessage: 'No runs available.',
      colSpan: 2,
      headCells: ['Run', 'Status'],
      bodyRows: [
        h('tr', null, h('td', null, '1001'), h('td', null, 'completed'))
      ]
    });

    expect(rendered.querySelectorAll('thead th')).toHaveLength(2);
    expect(rendered.querySelector('thead')?.textContent).toContain('Run');
    expect(rendered.querySelector('tbody')?.textContent).toContain('1001');
    expect(rendered.className).toBe('table-region');
  });

  it('adds reusable data summaries to the table header', () => {
    const rendered = renderTableRegion({
      tableClassName: 'custom-table',
      emptyMessage: 'No rows available.',
      colSpan: 2,
      headCells: ['Status', 'Score'],
      summaryColumns: [
        { label: 'Status', type: 'nominal', values: ['open', 'open', 'closed'] },
        { label: 'Score', type: 'quantitative', values: [1, 2, 3] }
      ],
      bodyRows: [
        h('tr', null, h('td', null, 'open'), h('td', null, '1'))
      ]
    });

    expect(rendered.querySelectorAll('thead tr')).toHaveLength(2);
    expect(rendered.querySelector('.table-summary-categories')?.textContent).toContain('open66.7%');
    expect(rendered.querySelector('.table-summary-histogram')).not.toBeNull();
  });

  it('renders the empty row when no body rows are provided', () => {
    const rendered = renderTableRegion({
      tableClassName: 'findings-table',
      emptyMessage: 'No findings available.',
      colSpan: 3,
      headCells: ['Summary', 'Severity', 'Status'],
      bodyRows: []
    });

    const emptyCell = rendered.querySelector('tbody td');
    expect(emptyCell?.getAttribute('colspan')).toBe('3');
    expect(emptyCell?.textContent).toBe('No findings available.');
  });

  it('preserves the custom table view data attribute', () => {
    const table = renderTableRegion({
      tableClassName: 'custom-table',
      emptyMessage: 'No rows available.',
      colSpan: 1,
      headCells: ['Column'],
      bodyRows: []
    });

    expect(table.querySelector('table')?.getAttribute('data-custom-view-mark')).toBe('table');
  });

  it('accepts keyed-list descriptors as populated body rows', async () => {
    const { keyed } = await import('../../src/dom.js');
    const rendered = renderTableRegion({
      tableClassName: 'evals-definitions-table',
      emptyMessage: 'No eval definitions available.',
      colSpan: 2,
      headCells: ['Eval', 'Results'],
      bodyRows: keyed(
        [{ key: 'release-risk' }],
        /** @param {unknown} item */
        (item) => {
          const keyedItem = /** @type {{ key: string }} */ (item);
          return h('tr', { 'data-key': keyedItem.key }, h('td', null, keyedItem.key), h('td', null, 'YES: 1'));
        },
        /** @param {unknown} item */
        (item) => /** @type {{ key: string }} */ (item).key
      )
    });

    expect(rendered.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(rendered.querySelector('tbody')?.textContent).toContain('release-risk');
    expect(rendered.querySelector('tbody')?.textContent).not.toContain('No eval definitions available.');
  });

  it('filters rows and announces the visible result count', () => {
    const rendered = renderTableRegion({
      tableClassName: 'custom-table',
      emptyMessage: 'No runs available.',
      colSpan: 2,
      headCells: ['Repository', 'Status'],
      filterLabel: 'Filter recent runs',
      bodyRows: [
        h('tr', null, h('td', null, 'alpha'), h('td', null, 'success')),
        h('tr', null, h('td', null, 'bravo'), h('td', null, 'failure'))
      ]
    });

    const input = /** @type {HTMLInputElement} */ (rendered.querySelector('[data-table-filter]'));
    const rows = [...rendered.querySelectorAll('tbody tr')];
    expect(input.closest('label')?.textContent).toBe('Filter recent runs');
    expect(input.closest('label')?.querySelector('span')?.classList.contains('sr-only')).toBe(true);
    expect(rendered.querySelector('.table-filter-result')?.textContent).toBe('Showing 2 of 2 results');

    input.value = 'failure';
    input.dispatchEvent(new Event('input'));

    expect(rows.map((row) => row.hasAttribute('hidden'))).toEqual([true, false]);
    expect(rendered.querySelector('.table-filter-result')?.textContent).toBe('Showing 1 of 1 result');
  });

  it('ports report-style facets, URL state, and progressive disclosure generically', () => {
    const rows = Array.from({ length: 60 }, (_, index) => h(
      'tr',
      null,
      h('td', null, `workflow-${index + 1}`),
      h('td', null, index % 2 === 0 ? 'review' : 'live')
    ));
    const rendered = renderTableRegion({
      tableClassName: 'custom-table',
      emptyMessage: 'No workflows.',
      colSpan: 2,
      headCells: ['Workflow', 'Mode'],
      bodyRows: rows,
      filterLabel: 'Filter workflows',
      filterId: 'workflow-catalog',
      filterFields: [{ key: 'mode', label: 'Mode', columnIndex: 1 }]
    });

    document.body.append(rendered);

    const mode = /** @type {HTMLSelectElement} */ (rendered.querySelector('[data-table-facet="mode"]'));
    const more = /** @type {HTMLButtonElement} */ (rendered.querySelector('[data-table-more]'));
    expect([...mode.options].map((option) => option.value)).toEqual(['', 'live', 'review']);
    expect(more.textContent).toBe('Show all rows');
    expect(rows.filter((row) => !row.hidden)).toHaveLength(25);
    expect(rendered.querySelector('.table-filter-result')?.textContent).toBe('Showing 25 of 60 results');
    expect(more.hidden).toBe(false);

    more.click();
    expect(rows.filter((row) => !row.hidden)).toHaveLength(60);
    expect(more.hidden).toBe(true);
    expect(rendered.classList.contains('table-region-expanded')).toBe(true);

    mode.value = 'review';
    mode.dispatchEvent(new Event('input'));
    expect(rows.filter((row) => !row.hidden)).toHaveLength(25);
    expect(rendered.querySelector('.table-filter-result')?.textContent).toBe('Showing 25 of 30 results');
    expect(rendered.classList.contains('table-region-expanded')).toBe(false);
    expect(window.location.search).toContain('workflow-catalog.mode=review');

    window.history.replaceState(null, '', '/');
  });

  it('supports report-style filter labels, placeholders, and always-visible facets', () => {
    const rendered = renderTableRegion({
      tableClassName: 'dispatch-table',
      emptyMessage: 'No dispatches.',
      colSpan: 2,
      headCells: ['Package', 'Status'],
      bodyRows: [
        h('tr', null, h('td', null, 'Dependabot'), h('td', null, 'success')),
        h('tr', null, h('td', null, 'Dependabot'), h('td', null, 'failure'))
      ],
      filterLabel: 'Search dispatches',
      filterPlaceholder: 'Run, package, worker, status, or repository',
      filterFields: [{ key: 'package', label: 'Package', allLabel: 'All packages', columnIndex: 0, always: true }],
      resultNoun: 'dispatch',
      resultNounPlural: 'dispatches'
    });

    expect(rendered.querySelector('input')?.getAttribute('placeholder')).toBe('Run, package, worker, status, or repository');
    expect([...rendered.querySelectorAll('select option')].map((option) => option.textContent)).toEqual(['All packages', 'Dependabot']);
    expect(rendered.querySelector('output')?.textContent).toBe('Showing 2 of 2 dispatches');
  });

  it('constrains height with an inner scroll container', () => {
    const rendered = renderTableRegion({
      tableClassName: 'custom-table',
      emptyMessage: 'No runs available.',
      colSpan: 1,
      headCells: ['Run'],
      filterLabel: 'Filter runs',
      bodyRows: [h('tr', null, h('td', null, '1001'))]
    });

    const scroll = rendered.querySelector('.table-scroll');
    expect(scroll?.getAttribute('role')).toBe('region');
    expect(scroll?.getAttribute('aria-label')).toBe('Filter runs results');
    expect(scroll?.getAttribute('tabindex')).toBe('0');
    expect(scroll?.querySelector('table')).toBeTruthy();
    expect(rendered.querySelector('.table-scroll .table-filter')).toBeNull();
  });

  it('sorts rows numerically and temporally when a column header is activated', () => {
    const rendered = renderTableRegion({
      tableClassName: 'custom-table',
      emptyMessage: 'No runs available.',
      colSpan: 2,
      headCells: ['Run', 'Started at'],
      filterLabel: 'Filter runs',
      bodyRows: [
        h('tr', null, h('td', null, '9'), h('td', null, '2026-08-27T10:00:00Z')),
        h('tr', null, h('td', null, '10'), h('td', null, '2026-08-29T10:00:00Z')),
        h('tr', null, h('td', null, '2'), h('td', null, '2026-08-28T10:00:00Z'))
      ]
    });

    const headers = [...rendered.querySelectorAll('th[aria-sort]')];
    const runSort = /** @type {HTMLButtonElement} */ (rendered.querySelector('[data-table-sort="0"]'));
    const startedSort = /** @type {HTMLButtonElement} */ (rendered.querySelector('[data-table-sort="1"]'));
    const runValues = () => [...rendered.querySelectorAll('tbody tr')]
      .map((row) => /** @type {HTMLTableRowElement} */ (row).cells[0]?.textContent);

    runSort.click();
    expect(runValues()).toEqual(['2', '9', '10']);
    expect(headers[0]?.getAttribute('aria-sort')).toBe('ascending');

    runSort.click();
    expect(runValues()).toEqual(['10', '9', '2']);
    expect(headers[0]?.getAttribute('aria-sort')).toBe('descending');

    startedSort.click();
    expect(runValues()).toEqual(['9', '2', '10']);
    expect(headers[0]?.getAttribute('aria-sort')).toBe('none');
    expect(headers[1]?.getAttribute('aria-sort')).toBe('ascending');
  });

  it('keeps pagination consistent after sorting', () => {
    const rows = Array.from({ length: 30 }, (_, index) => h(
      'tr',
      null,
      h('td', null, String(index + 1))
    ));
    const rendered = renderTableRegion({
      tableClassName: 'custom-table',
      emptyMessage: 'No runs available.',
      colSpan: 1,
      headCells: ['Run'],
      bodyRows: rows,
      filterLabel: 'Filter runs'
    });

    const runSort = /** @type {HTMLButtonElement} */ (rendered.querySelector('[data-table-sort="0"]'));
    runSort.click();
    runSort.click();

    const visible = [...rendered.querySelectorAll('tbody tr')]
      .filter((row) => !(/** @type {HTMLTableRowElement} */ (row).hidden));
    expect(visible).toHaveLength(25);
    expect(visible[0]?.textContent).toBe('30');
    expect(rendered.querySelector('.table-filter-result')?.textContent).toBe('Showing 25 of 30 results');
  });

  it('reveals lazy-list table rows in bounded batches', () => {
    const rows = Array.from({ length: 60 }, (_, index) => h(
      'tr',
      null,
      h('td', null, String(index + 1))
    ));
    const rendered = renderTableRegion({
      tableClassName: 'custom-table',
      emptyMessage: 'No repositories available.',
      colSpan: 1,
      headCells: ['Repository'],
      bodyRows: rows,
      filterLabel: 'Filter repositories',
      lazyList: true
    });

    const more = /** @type {HTMLButtonElement} */ (rendered.querySelector('[data-table-more]'));
    expect(rendered.hasAttribute('data-lazy-list')).toBe(true);
    expect(more.textContent).toBe('Load more rows');
    expect(rows.filter((row) => row.parentElement)).toHaveLength(25);

    more.click();
    expect(rows.filter((row) => row.parentElement)).toHaveLength(50);
    expect(rendered.querySelector('.table-filter-result')?.textContent).toBe('Showing 50 of 60 results');
  });

  it('loads lazy-list rows from a continuation token', async () => {
    const load = vi.fn(async () => ({
      rows: Array.from({ length: 5 }, (_, index) => h(
        'tr',
        null,
        h('td', null, String(index + 6))
      )).filter((row) => row instanceof HTMLTableRowElement),
      continuationToken: undefined
    }));
    const rendered = renderTableRegion({
      tableClassName: 'custom-table',
      emptyMessage: 'No runs available.',
      colSpan: 1,
      headCells: ['Run'],
      bodyRows: Array.from({ length: 5 }, (_, index) => h(
        'tr',
        null,
        h('td', null, String(index + 1))
      )),
      filterLabel: 'Filter runs',
      lazyList: true,
      pageSize: 5,
      continuation: { token: 'next-page', totalRows: 10, load }
    });

    expect(rendered.querySelector('.table-filter-result')?.textContent).toBe('Showing 5 of 10 results');
    /** @type {HTMLButtonElement} */ (rendered.querySelector('[data-table-more]')).click();
    await vi.waitFor(() => expect(rendered.querySelectorAll('tbody > tr')).toHaveLength(10));

    expect(load).toHaveBeenCalledWith('next-page');
    expect(rendered.querySelector('.table-filter-result')?.textContent).toBe('Showing 10 of 10 results');
    expect(rendered.querySelector('[data-table-more]')?.hasAttribute('hidden')).toBe(true);
  });

  it('unloads lazy-list prefix rows without moving the retained rows', () => {
    const rows = Array.from({ length: 100 }, (_, index) => h(
      'tr',
      null,
      h('td', null, String(index + 1))
    ));
    for (const row of rows) {
      vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(
        /** @type {DOMRect} */ ({ top: Number(row.textContent) * 20, height: 20 })
      );
    }
    vi.mocked(rows[25].getBoundingClientRect)
      .mockReturnValueOnce(/** @type {DOMRect} */ ({ top: 520, height: 20 }))
      .mockReturnValueOnce(/** @type {DOMRect} */ ({ top: 500, height: 20 }));
    const rendered = renderTableRegion({
      tableClassName: 'custom-table',
      emptyMessage: 'No repositories available.',
      colSpan: 1,
      headCells: ['Repository'],
      bodyRows: rows,
      filterLabel: 'Filter repositories',
      lazyList: true
    });
    const scroll = /** @type {HTMLElement} */ (rendered.querySelector('.table-scroll'));
    const more = /** @type {HTMLButtonElement} */ (rendered.querySelector('[data-table-more]'));
    scroll.scrollTop = 400;

    more.click();
    more.click();

    const loadedRows = [...rendered.querySelectorAll('tbody > tr')];
    expect(loadedRows).toHaveLength(50);
    expect(loadedRows[0]?.textContent).toBe('26');
    expect(loadedRows.at(-1)?.textContent).toBe('75');
    expect(rendered.querySelector('[data-lazy-list-spacer]')).toBeNull();
    expect(scroll.scrollTop).toBe(380);
    expect(rendered.querySelector('.table-filter-result')?.textContent).toBe('Showing 75 of 100 results');
  });

  it('defers table summary computation to the data worker', async () => {
    class SummaryWorker extends EventTarget {
      /** @param {Record<string, unknown>} request */
      postMessage(request) {
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
          data: { id: request.id, data: processDataRequest(request) }
        })));
      }

      terminate() {}
    }
    vi.stubGlobal('Worker', SummaryWorker);

    const rendered = renderTableRegion({
      tableClassName: 'custom-table',
      emptyMessage: 'No rows available.',
      colSpan: 1,
      headCells: ['Score'],
      summaryColumns: [{ label: 'Score', type: 'quantitative', values: [1, 2, 3] }],
      bodyRows: [h('tr', null, h('td', null, '1'))]
    });

    expect(rendered.querySelector('.table-summary-row')?.hasAttribute('aria-busy')).toBe(false);
    expect(rendered.querySelector('.table-summary-cell')?.getAttribute('aria-busy')).toBe('true');
    expect(rendered.querySelector('.table-summary-skeleton')).not.toBeNull();
    expect(rendered.querySelector('.table-summary-histogram')).toBeNull();
    await vi.waitFor(() => {
      expect(rendered.querySelector('.table-summary-cell')?.hasAttribute('aria-busy')).toBe(false);
      expect(rendered.querySelector('.table-summary-skeleton')).toBeNull();
      expect(rendered.querySelector('.table-summary-histogram')).not.toBeNull();
    });
    vi.unstubAllGlobals();
  });
});
