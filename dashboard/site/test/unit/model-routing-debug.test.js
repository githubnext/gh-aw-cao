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
  const module = await import('../../src/data/adapters/model-routing.js');
  return { ...module, output };
}

/** @param {string} schema */
const records = (schema) => [
  { line: 1, record: { type: 'firewall.model_routing', provenance: { phase: 'agent' },
    data: { stage: 'selection', schema, secret: 'token-value' } } },
  { line: 2, record: { type: 'firewall.model_routing', data: { stage: 'request', routed: 'deviated', deviations: ['endpoint'] } } }
];

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('model-routing debug logging', () => {
  it('is silent by default', async () => {
    const { normalizeLegacyRouting, output } = await load('');
    normalizeLegacyRouting(/** @type {any} */ (records('model-routing/v0.28.1')));
    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs applied normalization under the model-routing category', async () => {
    const { normalizeLegacyRouting, output } = await load('?debug=model-routing');
    normalizeLegacyRouting(/** @type {any} */ (records('model-routing/v0.28.1')));
    expect(output.debug).toHaveBeenCalledWith('[cao:model-routing]', {
      event: 'legacy-normalization', status: 'applied', records: 2, schemaMinor: 28, schemaPatch: 1
    });
  });

  it('logs skipped outcomes without record content', async () => {
    const { normalizeLegacyRouting, output } = await load('?debug=model-routing');
    normalizeLegacyRouting(/** @type {any} */ (records('model-routing/v0.28.39')));
    normalizeLegacyRouting(/** @type {any} */ ([]));
    expect(output.debug).toHaveBeenNthCalledWith(1, '[cao:model-routing]', {
      event: 'legacy-normalization', status: 'skipped', reason: 'current-schema', records: 2
    });
    expect(output.debug).toHaveBeenNthCalledWith(2, '[cao:model-routing]', {
      event: 'legacy-normalization', status: 'skipped', reason: 'no-versioned-selection', records: 0
    });
    expect(JSON.stringify(output.debug.mock.calls)).not.toContain('token-value');
  });
});
