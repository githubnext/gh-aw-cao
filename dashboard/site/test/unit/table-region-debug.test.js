// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from '../../src/dom.js';

/** @param {() => Promise<{ rows: HTMLTableRowElement[], continuationToken?: string }>} load */
function renderContinuationRegion(load) {
  return {
    tableClassName: 'custom-table',
    emptyMessage: 'No runs available.',
    colSpan: 2,
    headCells: ['Run', 'Status'],
    bodyRows: Array.from({ length: 5 }, (_, index) => h(
      'tr',
      null,
      h('td', null, String(index + 1)),
      h('td', null, 'success')
    )),
    filterLabel: 'Filter runs',
    filterId: 'runs',
    filterFields: [{ key: 'status', label: 'Status', columnIndex: 1, always: true }],
    lazyList: true,
    pageSize: 5,
    continuation: { token: 'next-page', totalRows: 10, load }
  };
}

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('table-region debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => '', output })
      };
    });
    vi.resetModules();
    const { renderTableRegion } = await import('../../src/components/table-region.js');

    const load = vi.fn(async () => ({ rows: /** @type {HTMLTableRowElement[]} */ ([]), continuationToken: undefined }));
    const rendered = renderTableRegion(renderContinuationRegion(load));
    /** @type {HTMLButtonElement} */ (rendered.querySelector('[data-table-more]')).click();
    await vi.waitFor(() => expect(load).toHaveBeenCalled());

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs continuation-load requested and succeeded under its predictable category when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=table-region', output })
      };
    });
    vi.resetModules();
    const { renderTableRegion } = await import('../../src/components/table-region.js');

    const load = vi.fn(async () => ({
      rows: /** @type {HTMLTableRowElement[]} */ ([h('tr', null, h('td', null, '6'), h('td', null, 'success'))]),
      continuationToken: undefined
    }));
    const rendered = renderTableRegion(renderContinuationRegion(load));
    /** @type {HTMLButtonElement} */ (rendered.querySelector('[data-table-more]')).click();
    await vi.waitFor(() => expect(load).toHaveBeenCalled());

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:table-region]',
      { event: 'continuation-load', filterId: 'runs', outcome: 'requested' }
    );
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:table-region]',
      { event: 'continuation-load', filterId: 'runs', outcome: 'succeeded', loadedCount: 1, hasMore: false }
    );
  });

  it('logs continuation-load failed with a sanitized error name when the load rejects', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=table-region', output })
      };
    });
    vi.resetModules();
    const { renderTableRegion } = await import('../../src/components/table-region.js');

    const load = vi.fn(async () => {
      throw new TypeError('network failure with a secret token=abc123');
    });
    const rendered = renderTableRegion(renderContinuationRegion(load));
    /** @type {HTMLButtonElement} */ (rendered.querySelector('[data-table-more]')).click();
    await vi.waitFor(() => expect(load).toHaveBeenCalled());
    await vi.waitFor(() => expect(
      output.debug.mock.calls.some(([, payload]) => payload.outcome === 'failed')
    ).toBe(true));

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:table-region]',
      { event: 'continuation-load', filterId: 'runs', outcome: 'failed', errorName: 'TypeError' }
    );
  });

  it('never logs sensitive payload content, only scalar metadata', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=table-region', output })
      };
    });
    vi.resetModules();
    const { renderTableRegion } = await import('../../src/components/table-region.js');

    const load = vi.fn(async () => {
      throw new Error('do not log this raw message');
    });
    const rendered = renderTableRegion(renderContinuationRegion(load));
    /** @type {HTMLButtonElement} */ (rendered.querySelector('[data-table-more]')).click();
    await vi.waitFor(() => expect(load).toHaveBeenCalled());
    await vi.waitFor(() => expect(
      output.debug.mock.calls.some(([, payload]) => payload.outcome === 'failed')
    ).toBe(true));

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('do not log this raw message');
    }
  });
});
