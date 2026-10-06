// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
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

/**
 * @param {unknown} value
 * @returns {string}
 */
function toText(value) {
  return value == null || value === '' ? 'unknown' : String(value);
}

describe('view-formatters debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '');
    const { formatAggregateValue } = await import('../../src/view-formatters.js');

    formatAggregateValue([], 'aic', 'sum', toText);
    formatAggregateValue([{ aic: 'bad' }], 'aic', 'mean', toText);
    formatAggregateValue([{ aic: 12 }], 'aic', 'bogus-aggregate', toText);

    expect(debugFn).not.toHaveBeenCalled();
  });

  it('logs an aggregate-empty-rows event with the requested aggregate when no rows are supplied', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=view-formatters');
    const { formatAggregateValue } = await import('../../src/view-formatters.js');

    formatAggregateValue([], 'aic', 'sum', toText);

    expect(debugFn).toHaveBeenCalledWith('[cao:view-formatters]', {
      event: 'aggregate-empty-rows',
      aggregate: 'sum'
    });
  });

  it('logs an aggregate-no-present-values event with the row count when every value is null/empty', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=view-formatters');
    const { formatAggregateValue } = await import('../../src/view-formatters.js');

    formatAggregateValue([{ aic: null }, { aic: '' }], 'aic', 'sum', toText);

    expect(debugFn).toHaveBeenCalledWith('[cao:view-formatters]', {
      event: 'aggregate-no-present-values',
      aggregate: 'sum',
      rowCount: 2
    });
  });

  it('logs an aggregate-unmatched event with the unrecognized aggregate keyword', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=view-formatters');
    const { formatAggregateValue } = await import('../../src/view-formatters.js');

    formatAggregateValue([{ aic: 12 }], 'aic', 'bogus-aggregate', toText);

    expect(debugFn).toHaveBeenCalledWith('[cao:view-formatters]', {
      event: 'aggregate-unmatched',
      aggregate: 'bogus-aggregate'
    });
  });

  it('does not log when rows are present, values resolve, and the aggregate is recognized', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=view-formatters');
    const { formatAggregateValue } = await import('../../src/view-formatters.js');

    formatAggregateValue([{ aic: 12 }, { aic: 18 }], 'aic', 'sum', toText);

    expect(debugFn).not.toHaveBeenCalled();
  });

  it('never logs row content, only scalar metadata', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=view-formatters');
    const { formatAggregateValue } = await import('../../src/view-formatters.js');

    formatAggregateValue([{ aic: null, secret: 'do-not-log' }], 'aic', 'bogus-aggregate', toText);
    formatAggregateValue([], 'aic', 'sum', toText);

    for (const call of debugFn.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
