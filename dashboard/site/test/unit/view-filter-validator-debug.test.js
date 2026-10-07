import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/** @param {{ search: string, output: { debug: import('vitest').Mock } }} options */
async function importViewFilterValidatorWithDebug({ search, output }) {
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
  return import('../../src/view-filter-validator.js');
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Minimal stand-ins for the `validator.js` helper surface `validateViewFilterBar` relies on. */
function stubHelpers() {
  return {
    isPlainObject,
    getValueNodeByKey: () => undefined,
    getSequenceItemNode: () => undefined,
    getMappingItems: () => null,
    validateObjectKeys: () => {},
    validateRequiredIdentifier: () => {},
    validateStringField: () => {},
    validateSource: () => {},
    sourceFieldNames: () => ['field-a', 'field-b'],
    createError: (/** @type {string} */ code, /** @type {string} */ message, /** @type {string} */ path) => ({ code, message, path })
  };
}

const VALID_VIEW = {
  id: 'view-id',
  mark: 'list',
  data: { source: 'source-a' },
  'filter-bar': {
    filters: [
      {
        id: 'control-a',
        label: 'Control A',
        groups: [
          { label: 'Group A', field: 'field-a', source: 'source-b', 'value-field': 'field-b' }
        ]
      }
    ]
  }
};

describe('view-filter-validator debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const output = { debug: vi.fn() };
    const module = await importViewFilterValidatorWithDebug({ search: '', output });

    module.validateViewFilterBar(VALID_VIEW, undefined, 'view', 'source-a', [], stubHelpers());
    module.validateViewFilterBar({ ...VALID_VIEW, 'filter-bar': {} }, undefined, 'view', 'source-a', [], stubHelpers());

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('is selected by the predictable "view-filter-validator" category derived from the filename, not enabled by unrelated categories', async () => {
    const output = { debug: vi.fn() };
    const module = await importViewFilterValidatorWithDebug({ search: '?debug=some-other-category', output });

    module.validateViewFilterBar(VALID_VIEW, undefined, 'view', 'source-a', [], stubHelpers());

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a rejection reason when filter-bar is not a mapping', async () => {
    const output = { debug: vi.fn() };
    const module = await importViewFilterValidatorWithDebug({ search: '?debug=view-filter-validator', output });

    module.validateViewFilterBar({ ...VALID_VIEW, 'filter-bar': 'not-a-mapping' }, undefined, 'view', 'source-a', [], stubHelpers());

    expect(output.debug).toHaveBeenCalledWith('[cao:view-filter-validator]', {
      event: 'filter-bar-rejected',
      reason: 'not-a-mapping'
    });
  });

  it('logs a rejection reason when filter-bar.filters is empty', async () => {
    const output = { debug: vi.fn() };
    const module = await importViewFilterValidatorWithDebug({ search: '?debug=view-filter-validator', output });

    module.validateViewFilterBar({ ...VALID_VIEW, 'filter-bar': { filters: [] } }, undefined, 'view', 'source-a', [], stubHelpers());

    expect(output.debug).toHaveBeenCalledWith('[cao:view-filter-validator]', {
      event: 'filter-bar-rejected',
      reason: 'empty-filters'
    });
  });

  it('logs a validated-outcome summary with the control count and status', async () => {
    const output = { debug: vi.fn() };
    const module = await importViewFilterValidatorWithDebug({ search: '?debug=view-filter-validator', output });

    module.validateViewFilterBar(VALID_VIEW, undefined, 'view', 'source-a', [], stubHelpers());

    expect(output.debug).toHaveBeenCalledWith('[cao:view-filter-validator]', {
      event: 'filter-bar-validated',
      controlCount: 1,
      status: 'ok'
    });
  });

  it('reports an invalid status when validation produces errors', async () => {
    const output = { debug: vi.fn() };
    const module = await importViewFilterValidatorWithDebug({ search: '?debug=view-filter-validator', output });

    const errors = /** @type {any[]} */ ([]);
    const invalidView = {
      ...VALID_VIEW,
      'filter-bar': {
        filters: [
          {
            id: 'control-a',
            label: 'Control A',
            groups: [
              { label: 'Group A', field: 'undeclared-field', source: 'source-b', 'value-field': 'field-b' }
            ]
          }
        ]
      }
    };
    module.validateViewFilterBar(invalidView, undefined, 'view', 'source-a', errors, stubHelpers());

    expect(errors.length).toBeGreaterThan(0);
    expect(output.debug).toHaveBeenCalledWith('[cao:view-filter-validator]', {
      event: 'filter-bar-validated',
      controlCount: 1,
      status: 'invalid'
    });
  });

  it('never logs sensitive field names, source identifiers, or other row content, only scalar metadata', async () => {
    const output = { debug: vi.fn() };
    const module = await importViewFilterValidatorWithDebug({ search: '?debug=view-filter-validator', output });

    const secretView = {
      ...VALID_VIEW,
      'filter-bar': {
        filters: [
          {
            id: 'control-a',
            label: 'Control A',
            groups: [
              { label: 'Group A', field: 'secret-field-name', source: 'secret-source-name', 'value-field': 'field-b' }
            ]
          }
        ]
      }
    };
    module.validateViewFilterBar(secretView, undefined, 'view', 'source-a', [], stubHelpers());

    expect(output.debug.mock.calls.length).toBeGreaterThan(0);
    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('secret-field-name');
      expect(JSON.stringify(payload)).not.toContain('secret-source-name');
    }
  });
});
