// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  document.body.replaceChildren();
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/**
 * @param {ReturnType<typeof vi.fn>} debugFn
 * @param {string} search
 */
function mockDebugModule(debugFn, search) {
  const output = /** @type {Pick<Console, 'debug'>} */ ({ debug: debugFn });
  vi.doMock('../../src/debug.js', async () => {
    const actual = /** @type {typeof import('../../src/debug.js')} */ (
      await vi.importActual('../../src/debug.js')
    );
    return {
      ...actual,
      createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => search, output })
    };
  });
  vi.resetModules();
}

/** @param {import('../../src/table-summary-data.js').TableSummaryColumn[]} columns */
function testColumns(columns) {
  return columns;
}

describe('table summary debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '');
    const { renderReactiveTableSummaryRow } = await import('../../src/components/table-summary.js');

    const columns = testColumns([{ label: 'Status', type: 'nominal', values: ['open'] }]);
    const row = renderReactiveTableSummaryRow(columns, Promise.resolve([{ kind: 'count', count: 1 }]));
    document.body.append(row);
    row.querySelector('.table-summary-toggle')?.dispatchEvent(new MouseEvent('click'));
    await Promise.resolve();
    await Promise.resolve();

    expect(debugFn).not.toHaveBeenCalled();
  });

  it('logs summaries-resolved with ok outcome and column count under its predictable category', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=table-summary');
    const { renderReactiveTableSummaryRow } = await import('../../src/components/table-summary.js');

    const columns = testColumns([
      { label: 'Status', type: 'nominal', values: ['open'] },
      { label: 'Score', type: 'quantitative', values: [1] }
    ]);
    const row = renderReactiveTableSummaryRow(
      columns,
      Promise.resolve([{ kind: 'count', count: 1 }, { kind: 'count', count: 1 }])
    );
    document.body.append(row);
    await Promise.resolve();
    await Promise.resolve();

    expect(debugFn).toHaveBeenCalledWith('[cao:table-summary]', {
      event: 'summaries-resolved',
      outcome: 'ok',
      columnCount: 2
    });
  });

  it('logs summaries-resolved with failed outcome and a sanitized error name when the promise rejects', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=table-summary');
    const { renderReactiveTableSummaryRow } = await import('../../src/components/table-summary.js');

    const columns = testColumns([{ label: 'Status', type: 'nominal', values: ['open'] }]);
    const row = renderReactiveTableSummaryRow(columns, Promise.reject(new TypeError('boom')));
    document.body.append(row);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(debugFn).toHaveBeenCalledWith('[cao:table-summary]', {
      event: 'summaries-resolved',
      outcome: 'failed',
      errorName: 'TypeError'
    });
  });

  it('logs toggle-changed with the new expanded state when the toggle is clicked', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=table-summary');
    const { renderReactiveTableSummaryRow } = await import('../../src/components/table-summary.js');

    const columns = testColumns([{ label: 'Status', type: 'nominal', values: ['open'] }]);
    const row = renderReactiveTableSummaryRow(columns, Promise.resolve([{ kind: 'count', count: 1 }]));
    document.body.append(row);
    await Promise.resolve();
    await Promise.resolve();
    debugFn.mockClear();

    const toggle = /** @type {HTMLButtonElement} */ (row.querySelector('.table-summary-toggle'));
    toggle.click();

    expect(debugFn).toHaveBeenCalledWith('[cao:table-summary]', { event: 'toggle-changed', expanded: false });

    toggle.click();

    expect(debugFn).toHaveBeenCalledWith('[cao:table-summary]', { event: 'toggle-changed', expanded: true });
  });

  it('never logs record content, only scalar metadata', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=table-summary');
    const { renderReactiveTableSummaryRow } = await import('../../src/components/table-summary.js');

    const columns = testColumns([{ label: 'Status', type: 'nominal', values: ['open'] }]);
    const row = renderReactiveTableSummaryRow(columns, Promise.resolve([{ kind: 'count', count: 1 }]));
    document.body.append(row);
    row.querySelector('.table-summary-toggle')?.dispatchEvent(new MouseEvent('click'));
    await Promise.resolve();
    await Promise.resolve();

    for (const call of debugFn.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
