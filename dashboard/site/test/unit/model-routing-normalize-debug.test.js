import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/** @param {string} search */
async function load(search) {
  const output = { debug: vi.fn() };
  vi.doMock('../../src/debug.js', async () => {
    const actual = /** @type {typeof import('../../src/debug.js')} */ (await vi.importActual('../../src/debug.js'));
    return { ...actual, createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => search, output }) };
  });
  vi.resetModules();
  const { compactRoutingRuns } = await import('../../src/data/normalize/model-routing.js');
  return { compactRoutingRuns, output };
}

/** @param {Record<string, unknown>[]} audits */
const batch = (audits) => /** @type {any} */ ({ audits, runs: [{ id: 'run-secret', prompt: 'private text' }] });

describe('model routing normalize debug logging', () => {
  it('is silent by default', async () => {
    const { compactRoutingRuns, output } = await load('');
    compactRoutingRuns(batch([]));
    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs scalar counts under normalize:model-routing without record values', async () => {
    const { compactRoutingRuns, output } = await load('?debug=normalize:model-routing');
    compactRoutingRuns(batch([{ type: 'other', secret: 'token-value' }]));
    expect(output.debug).toHaveBeenCalledWith('[cao:normalize:model-routing]',
      { event: 'compact-routing', status: 'skipped', reason: 'no-session-format', audits: 1 });
    expect(JSON.stringify(output.debug.mock.calls)).not.toMatch(/token-value|run-secret|private text/);
  });

  it('can be excluded by category filter', async () => {
    const { compactRoutingRuns, output } = await load('?debug=*,-normalize:model-routing');
    compactRoutingRuns(batch([]));
    expect(output.debug).not.toHaveBeenCalled();
  });
});
