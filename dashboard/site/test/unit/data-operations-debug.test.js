import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/** @param {number} count */
function makeRows(count) {
  return Array.from({ length: count }, (_, index) => ({
    repository: `repo-${index}`,
    status: index % 2 === 0 ? 'open' : 'closed'
  }));
}

/** @param {string} search debug query string used to enable logging */
async function importTidyWithDebug(search) {
  const output = { debug: vi.fn() };
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
  const { tidy } = await import('../../src/data-operations.js');
  return { tidy, output };
}

describe('data-operations debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const { tidy, output } = await importTidyWithDebug('');

    tidy(makeRows(3), [{ op: 'filter', predicates: [{ field: 'status', equals: 'open' }] }]);

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs pipeline-started and pipeline-completed under its predictable category when enabled', async () => {
    const { tidy, output } = await importTidyWithDebug('?debug=data-operations');

    tidy(makeRows(4), [{ op: 'filter', predicates: [{ field: 'status', equals: 'open' }] }]);

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:data-operations]',
      { event: 'pipeline-started', inputRows: 4, operatorCount: 1 }
    );
    const completed = output.debug.mock.calls.find(([, payload]) => payload.event === 'pipeline-completed');
    expect(completed).toBeDefined();
    const [, payload] = /** @type {[string, Record<string, unknown>]} */ (completed);
    expect(payload.outputRows).toBe(2);
    expect(typeof payload.durationMs).toBe('number');
  });

  it('logs a pipeline-rejected event with only the offending operator name for an unsupported operator', async () => {
    const { tidy, output } = await importTidyWithDebug('?debug=data-operations');

    expect(() => tidy(makeRows(1), [/** @type {any} */ ({ op: 'unsupported-op' })])).toThrow(TypeError);

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:data-operations]',
      { event: 'pipeline-rejected', op: 'unsupported-op' }
    );
  });

  it('never logs row contents, only scalar counts and durations', async () => {
    const { tidy, output } = await importTidyWithDebug('?debug=data-operations');

    tidy([
      { repository: 'secret-repo', token: 'sensitive-token-value' }
    ], [{ op: 'filter', predicates: [] }]);

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toMatch(/secret|sensitive/i);
    }
  });
});
