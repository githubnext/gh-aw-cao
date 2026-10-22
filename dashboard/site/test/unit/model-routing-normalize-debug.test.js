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

const batch = () => /** @type {any} */ ({
  audits: [{ type: 'session.format', secret: 'token-value' }],
  runs: [{ id: 'run-secret-id' }]
});

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('normalize model-routing debug logging', () => {
  it('is silent by default and for unrelated categories', async () => {
    for (const search of ['', '?debug=model-routing']) {
      const { compactRoutingRuns, output } = await load(search);
      compactRoutingRuns(batch());
      expect(output.debug).not.toHaveBeenCalled();
    }
  });

  it('logs scalar counts under normalize:model-routing without record values', async () => {
    const { compactRoutingRuns, output } = await load('?debug=normalize:model-routing');
    compactRoutingRuns(batch());
    expect(output.debug).toHaveBeenCalledTimes(1);
    const [label, metadata] = output.debug.mock.calls[0];
    expect(label).toBe('[cao:normalize:model-routing]');
    expect(metadata).toMatchObject({ operation: 'compact-routing-runs', status: 'aggregated', runs: 1 });
    expect(JSON.stringify(output.debug.mock.calls)).not.toMatch(/token-value|run-secret-id/);
  });
});
