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

/** @param {unknown} value */
const toText = (value) => value == null || value === '' ? 'unknown' : String(value);

describe('cell-display debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '');
    const { renderCellDisplay } = await import('../../src/components/cell-display.js');

    renderCellDisplay('unsupported-display', 'value', toText);
    renderCellDisplay(undefined, null, toText, null, 'quantitative');
    renderCellDisplay(undefined, null, toText, null, 'nominal', 'workflow-relative-path');

    expect(debugFn).not.toHaveBeenCalled();
  });

  it('logs a display-unmatched event with the unmatched display name under its predictable category', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=cell-display');
    const { renderCellDisplay } = await import('../../src/components/cell-display.js');

    renderCellDisplay('unsupported-display', 'value', toText, null, 'nominal');

    expect(debugFn).toHaveBeenCalledWith('[cao:cell-display]', {
      event: 'display-unmatched',
      display: 'unsupported-display',
      type: 'nominal'
    });
  });

  it('logs a quantitative-unparseable event when a quantitative value cannot be parsed as a number', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=cell-display');
    const { renderCellDisplay } = await import('../../src/components/cell-display.js');

    renderCellDisplay(undefined, 'not-a-number', toText, null, 'quantitative');

    expect(debugFn).toHaveBeenCalledWith('[cao:cell-display]', {
      event: 'quantitative-unparseable',
      type: 'quantitative'
    });
  });

  it('logs a missing-value-rendered event when a workflow-relative-path value is absent', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=cell-display');
    const { renderCellDisplay } = await import('../../src/components/cell-display.js');

    renderCellDisplay(undefined, null, toText, null, 'nominal', 'workflow-relative-path');

    expect(debugFn).toHaveBeenCalledWith('[cao:cell-display]', {
      event: 'missing-value-rendered',
      format: 'workflow-relative-path'
    });
  });

  it('never logs record content, only scalar metadata', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=cell-display');
    const { renderCellDisplay } = await import('../../src/components/cell-display.js');

    renderCellDisplay('unsupported-display', 'secret-value', toText, null, 'nominal');
    renderCellDisplay(undefined, 'not-a-number', toText, null, 'quantitative');
    renderCellDisplay(undefined, null, toText, null, 'nominal', 'workflow-relative-path');

    for (const call of debugFn.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
