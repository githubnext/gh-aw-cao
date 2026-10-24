import { afterEach, describe, expect, it, vi } from 'vitest';

/** @param {string} search */
async function load(search) {
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
  const module = await import('../../src/data/normalize/model-routing.js');
  return { ...module, output };
}

const secret = 'token-value';
const batch = () => /** @type {any} */ ({ audits: [{ type: 'session.format', secret }], runs: [] });

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('normalize model-routing debug logging', () => {
  it('is silent by default', async () => {
    const { compactRoutingRuns, output } = await load('');
    compactRoutingRuns(batch());
    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a skipped outcome under normalize:model-routing', async () => {
    const { compactRoutingRuns, output } = await load('?debug=normalize:model-routing');
    compactRoutingRuns(/** @type {any} */ ({ audits: [], runs: [] }));
    expect(output.debug).toHaveBeenCalledWith('[cao:normalize:model-routing]', {
      event: 'compact-routing-runs', status: 'skipped', reason: 'no-session-format'
    });
  });

  it('logs applied counts without record content', async () => {
    const { compactRoutingRuns, output } = await load('?debug=normalize:*');
    compactRoutingRuns(batch());
    expect(output.debug).toHaveBeenCalledWith('[cao:normalize:model-routing]', {
      event: 'compact-routing-runs', status: 'applied', runs: 0, aggregateRows: 0
    });
    expect(JSON.stringify(output.debug.mock.calls)).not.toContain(secret);
  });

  it('does not match an unrelated category', async () => {
    const { compactRoutingRuns, output } = await load('?debug=model-routing');
    compactRoutingRuns(batch());
    expect(output.debug).not.toHaveBeenCalled();
  });
});
