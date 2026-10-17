// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const callouts = [
  { id: 'secret-callout-id', 'visible-when': { source: 'freshness', field: 'at', equals: 'private-row-value' } },
  { id: 'other-id', 'visible-when': { source: 'missing', field: 'at', equals: 1 } },
  { id: 'always-id' }
];
const sources = { freshness: { rows: [{ at: 'private-row-value' }] } };

/** @param {string} search */
async function run(search) {
  const output = { debug: vi.fn() };
  vi.doMock('../../src/debug.js', async () => {
    const actual = /** @type {typeof import('../../src/debug.js')} */ (await vi.importActual('../../src/debug.js'));
    return {
      ...actual,
      createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => search, output })
    };
  });
  vi.resetModules();
  const { queryCalloutVisibility } = await import('../../src/data/queries/callouts.js');
  const result = queryCalloutVisibility(/** @type {any} */ (callouts), /** @type {any} */ (sources));
  return { result, output };
}

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('callouts query debug logging', () => {
  it('is silent by default and preserves results', async () => {
    const { result, output } = await run('');
    expect(output.debug).not.toHaveBeenCalled();
    expect(result.map((entry) => entry.visibility)).toEqual(['visible', 'unavailable', 'visible']);
  });

  it('logs counts under the callouts category without identifiers or row values', async () => {
    const { output } = await run('?debug=callouts');
    expect(output.debug).toHaveBeenCalledTimes(1);
    expect(output.debug).toHaveBeenCalledWith('[cao:callouts]', {
      event: 'visibility-queried', status: 'complete', calloutCount: 3, unavailableCount: 1
    });
    const logged = JSON.stringify(output.debug.mock.calls);
    expect(logged).not.toContain('secret-callout-id');
    expect(logged).not.toContain('private-row-value');
  });

  it('is excluded by other category filters', async () => {
    const { output } = await run('?debug=data,-callouts');
    expect(output.debug).not.toHaveBeenCalled();
  });
});
