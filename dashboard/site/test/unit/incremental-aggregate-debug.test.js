// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/** @param {string} search */
async function loadWithDebug(search) {
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
  const module = await import('../../src/data/queries/incremental-aggregate.js');
  return { ...module, output };
}

const aggregate = /** @type {any} */ ({
  by: ['team'],
  values: [{ field: 'secret', reducer: 'count', as: 'total' }]
});
const budget = /** @type {any} */ ({ spend: () => {} });

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('incremental-aggregate debug logging', () => {
  it('is disabled by default', async () => {
    const { incrementalAggregate, output } = await loadWithDebug('');
    const reducer = incrementalAggregate(aggregate, budget);
    reducer.append([{ team: 'a', secret: 'token-123' }]);
    reducer.rows();
    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs scalar counts under the incremental-aggregate category without row values', async () => {
    const { incrementalAggregate, output } = await loadWithDebug('?debug=incremental-aggregate');
    const reducer = incrementalAggregate(aggregate, budget);
    reducer.append([{ team: 'private-team', secret: 'token-123' }, { team: 'b', secret: 'x' }]);
    reducer.rows();
    expect(output.debug).toHaveBeenCalledTimes(1);
    expect(output.debug).toHaveBeenCalledWith('[cao:incremental-aggregate]', {
      event: 'rows-materialized', groups: 2, groupFields: 1, values: 1
    });
    expect(JSON.stringify(output.debug.mock.calls)).not.toMatch(/token-123|private-team/);
  });

  it('does not log when another category is selected', async () => {
    const { incrementalAggregate, output } = await loadWithDebug('?debug=data,-incremental-aggregate');
    incrementalAggregate(aggregate, budget).rows();
    expect(output.debug).not.toHaveBeenCalled();
  });
});
