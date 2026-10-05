import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/** @param {{ search: string, output: { debug: import('vitest').Mock } }} options */
async function importQueryWindowValidatorWithDebug({ search, output }) {
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
  return import('../../src/query-window-validator.js');
}

/** Minimal stand-ins for the `validator.js` helper surface `validateQueryWindow` relies on. */
function stubHelpers() {
  return {
    isPlainObject,
    getValueNodeByKey: () => undefined,
    getSequenceItemNode: () => undefined,
    validateObjectKeys: () => {},
    validateStringField: () => {},
    createError: (/** @type {string} */ code, /** @type {string} */ message, /** @type {string} */ path) => ({ code, message, path }),
    requireField: () => {},
    requireSchemaType: () => {},
    declareField: () => {}
  };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const VALID_ENTRY = {
  field: 'metric',
  as: 'metric_rolling',
  operation: 'rolling',
  frame: 3,
  'order-by': [{ field: 'observed_at' }]
};

describe('query-window-validator debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const output = { debug: vi.fn() };
    const module = await importQueryWindowValidatorWithDebug({ search: '', output });

    const errors = /** @type {any[]} */ ([]);
    module.validateQueryWindow([VALID_ENTRY], undefined, 'query', errors, stubHelpers());
    module.validateQueryWindow([], undefined, 'query', errors, stubHelpers());

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('is selected by the predictable "query-window-validator" category derived from the filename, not enabled by unrelated categories', async () => {
    const output = { debug: vi.fn() };
    const module = await importQueryWindowValidatorWithDebug({ search: '?debug=some-other-category', output });

    module.validateQueryWindow([VALID_ENTRY], undefined, 'query', [], stubHelpers());

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a rejection reason when the window definition count is invalid', async () => {
    const output = { debug: vi.fn() };
    const module = await importQueryWindowValidatorWithDebug({ search: '?debug=query-window-validator', output });

    module.validateQueryWindow([], undefined, 'query', [], stubHelpers());

    expect(output.debug).toHaveBeenCalledWith('[cao:query-window-validator]', {
      event: 'window-rejected',
      reason: 'invalid-definition-count'
    });
  });

  it('logs the rejected operation value when a window entry uses an unsupported operation', async () => {
    const output = { debug: vi.fn() };
    const module = await importQueryWindowValidatorWithDebug({ search: '?debug=query-window-validator', output });

    module.validateQueryWindow(
      [{ ...VALID_ENTRY, operation: 'sum' }],
      undefined,
      'query',
      [],
      stubHelpers()
    );

    expect(output.debug).toHaveBeenCalledWith('[cao:query-window-validator]', {
      event: 'operation-rejected',
      operation: 'sum'
    });
  });

  it('logs a validated-outcome summary with the definition count and status', async () => {
    const output = { debug: vi.fn() };
    const module = await importQueryWindowValidatorWithDebug({ search: '?debug=query-window-validator', output });

    module.validateQueryWindow([VALID_ENTRY], undefined, 'query', [], stubHelpers());

    expect(output.debug).toHaveBeenCalledWith('[cao:query-window-validator]', {
      event: 'window-validated',
      definitionCount: 1,
      status: 'ok'
    });
  });

  it('never logs sensitive field names, paths, or other row content, only scalar metadata', async () => {
    const output = { debug: vi.fn() };
    const module = await importQueryWindowValidatorWithDebug({ search: '?debug=query-window-validator', output });

    module.validateQueryWindow(
      [{ ...VALID_ENTRY, field: 'secret-field-name', operation: 'unsupported-op' }],
      undefined,
      'query',
      [],
      stubHelpers()
    );

    expect(output.debug.mock.calls.length).toBeGreaterThan(0);
    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('secret-field-name');
    }
  });
});
