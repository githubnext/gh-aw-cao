// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Loads validator-encoding.js with a stubbed debug output so assertions can
 * inspect emitted metadata without depending on module state left over from
 * other tests.
 * @param {string} search
 */
async function loadValidatorEncodingWithDebug(search) {
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
  const module = await import('../../src/validator-encoding.js');
  return { ...module, output };
}

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('validator-encoding debug logging', () => {
  it('is disabled by default when the debug query is absent', async () => {
    const { validateEncoding, output } = await loadValidatorEncodingWithDebug('');

    validateEncoding(undefined, { value: { field: 'count' } }, 'metric', undefined, null, undefined, 'view', []);
    validateEncoding(undefined, undefined, 'element', undefined, null, undefined, 'view', []);

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs the metric encoding validation outcome under its predictable category when enabled', async () => {
    const { validateEncoding, output } = await loadValidatorEncodingWithDebug('?debug=validator-encoding');

    validateEncoding(undefined, { value: { field: 'count' } }, 'metric', undefined, null, undefined, 'view', []);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:validator-encoding]',
      { operation: 'validate-encoding', mark: 'metric', status: 'ok' }
    );

    output.debug.mockClear();
    /** @type {import('../../src/validator.js').ValidationError[]} */
    const errors = [];
    validateEncoding(undefined, { value: { field: 'count' }, x: { field: 'date' } }, 'metric', undefined, null, undefined, 'view', errors);
    expect(errors.length).toBeGreaterThan(0);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:validator-encoding]',
      { operation: 'validate-encoding', mark: 'metric', status: 'invalid' }
    );
  });

  it('logs rejection when element/callout marks declare encoding', async () => {
    const { validateEncoding, output } = await loadValidatorEncodingWithDebug('?debug=validator-encoding');

    validateEncoding(undefined, { value: { field: 'count' } }, 'element', undefined, null, undefined, 'view', []);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:validator-encoding]',
      { operation: 'validate-encoding', mark: 'element', status: 'invalid' }
    );

    output.debug.mockClear();
    validateEncoding(undefined, undefined, 'callout', undefined, null, undefined, 'view', []);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:validator-encoding]',
      { operation: 'validate-encoding', mark: 'callout', status: 'ok' }
    );
  });

  it('logs rejection when encoding is not a mapping', async () => {
    const { validateEncoding, output } = await loadValidatorEncodingWithDebug('?debug=validator-encoding');

    validateEncoding(undefined, 'not-a-mapping', 'metric', undefined, null, undefined, 'view', []);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:validator-encoding]',
      { operation: 'validate-encoding', mark: 'metric', status: 'invalid' }
    );
  });

  it('never logs sensitive payload content, only scalar metadata', async () => {
    const { validateEncoding, output } = await loadValidatorEncodingWithDebug('?debug=validator-encoding');

    validateEncoding(undefined, { value: { field: 'count' } }, 'metric', undefined, null, undefined, 'view', []);

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(value === null || ['string', 'number', 'boolean'].includes(typeof value)).toBe(true);
      }
    }
  });
});
