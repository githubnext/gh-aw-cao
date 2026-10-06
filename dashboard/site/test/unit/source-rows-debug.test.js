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

/** @param {unknown} rows @returns {import('../../src/presenter.js').LogicalSourceInput} */
function source(rows) {
  return /** @type {import('../../src/presenter.js').LogicalSourceInput} */ ({
    source: 'workflows',
    rows,
    metadata: /** @type {import('../../src/presenter.js').SourceMetadata} */ ({})
  });
}

describe('source-rows debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '');
    const { rowsFor } = await import('../../src/components/source-rows.js');

    rowsFor({}, 'workflows');
    rowsFor({ workflows: source('not-an-array') }, 'workflows');

    expect(debugFn).not.toHaveBeenCalled();
  });

  it('logs a source-missing event with the source name when the named source is absent', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=source-rows');
    const { rowsFor } = await import('../../src/components/source-rows.js');

    rowsFor({}, 'workflows');

    expect(debugFn).toHaveBeenCalledWith('[cao:source-rows]', { event: 'source-missing', name: 'workflows' });
  });

  it('logs a rows-malformed event with the source name when rows is not an array', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=source-rows');
    const { rowsFor } = await import('../../src/components/source-rows.js');

    rowsFor({ workflows: source('not-an-array') }, 'workflows');

    expect(debugFn).toHaveBeenCalledWith('[cao:source-rows]', { event: 'rows-malformed', name: 'workflows' });
  });

  it('does not log when rows resolve successfully', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=source-rows');
    const { rowsFor } = await import('../../src/components/source-rows.js');

    rowsFor({ workflows: source([{ id: 1 }]) }, 'workflows');

    expect(debugFn).not.toHaveBeenCalled();
  });

  it('never logs row content, only scalar metadata', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=source-rows');
    const { rowsFor } = await import('../../src/components/source-rows.js');

    rowsFor({}, 'workflows');
    rowsFor({ workflows: source('not-an-array') }, 'workflows');

    for (const call of debugFn.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
