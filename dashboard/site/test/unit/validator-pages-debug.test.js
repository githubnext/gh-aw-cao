import { afterEach, describe, expect, it, vi } from 'vitest';

const builtInPage = {
  id: 'workflows',
  kind: 'built-in',
  page: 'workflows',
  title: 'Workflows',
  definition: {
    'data-state': { availability: true },
    views: [
      {
        id: 'workflow-inventory',
        data: { source: 'workflows' },
        mark: 'table',
        encoding: { columns: [{ field: 'workflow-active' }, { field: 'rollout-mode' }] }
      }
    ]
  }
};

// Intentionally omits the required declarative definition sources so
// validation reports 'invalid', exercising the built-in-page failure path.
const invalidBuiltInPage = {
  kind: 'built-in',
  id: 'runs',
  page: 'runs'
};

const customPage = {
  kind: 'custom',
  id: 'custom-summary',
  title: 'Custom Summary',
  views: [
    {
      id: 'run-count',
      data: { source: 'runs' },
      mark: 'metric',
      encoding: { value: { field: 'run', aggregate: 'count' } }
    }
  ]
};

const unknownKindPage = {
  kind: 'mystery',
  id: 'unknown-page'
};

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('validator-pages debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => '', output })
      };
    });
    vi.resetModules();
    const { validatePage } = await import('../../src/validator-pages.js');

    validatePage(builtInPage, null, '$.dashboard.pages[0]', new Set(), []);
    validatePage(invalidBuiltInPage, null, '$.dashboard.pages[0]', new Set(), []);
    validatePage(customPage, null, '$.dashboard.pages[0]', new Set(), []);
    validatePage(unknownKindPage, null, '$.dashboard.pages[0]', new Set(), []);

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs page-kind validation outcomes under its predictable category when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=validator-pages', output })
      };
    });
    vi.resetModules();
    const { validatePage } = await import('../../src/validator-pages.js');

    /** @type {import('../../src/validator.js').ValidationError[]} */
    const builtInErrors = [];
    validatePage(builtInPage, null, '$.dashboard.pages[0]', new Set(), builtInErrors);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:validator-pages]',
      { operation: 'validate-page', kind: 'built-in', status: 'ok' }
    );
    expect(builtInErrors.length).toBe(0);

    output.debug.mockClear();
    /** @type {import('../../src/validator.js').ValidationError[]} */
    const invalidBuiltInErrors = [];
    validatePage(invalidBuiltInPage, null, '$.dashboard.pages[0]', new Set(), invalidBuiltInErrors);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:validator-pages]',
      { operation: 'validate-page', kind: 'built-in', status: 'invalid' }
    );
    expect(invalidBuiltInErrors.length).toBeGreaterThan(0);

    output.debug.mockClear();
    /** @type {import('../../src/validator.js').ValidationError[]} */
    const customErrors = [];
    validatePage(customPage, null, '$.dashboard.pages[0]', new Set(), customErrors);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:validator-pages]',
      { operation: 'validate-page', kind: 'custom', status: 'ok' }
    );
    expect(customErrors.length).toBe(0);

    output.debug.mockClear();
    /** @type {import('../../src/validator.js').ValidationError[]} */
    const unknownErrors = [];
    validatePage(unknownKindPage, null, '$.dashboard.pages[0]', new Set(), unknownErrors);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:validator-pages]',
      { operation: 'validate-page', kind: 'unknown', status: 'invalid' }
    );
    expect(unknownErrors.length).toBeGreaterThan(0);
  });

  it('never logs page ids, titles, or error details, only scalar kind and status', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=validator-pages', output })
      };
    });
    vi.resetModules();
    const { validatePage } = await import('../../src/validator-pages.js');

    validatePage(builtInPage, null, '$.dashboard.pages[0]', new Set(), []);
    validatePage(invalidBuiltInPage, null, '$.dashboard.pages[0]', new Set(), []);
    validatePage(customPage, null, '$.dashboard.pages[0]', new Set(), []);
    validatePage(unknownKindPage, null, '$.dashboard.pages[0]', new Set(), []);

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('custom-summary');
      expect(JSON.stringify(payload)).not.toContain('unknown-page');
      expect(JSON.stringify(payload)).not.toContain('Custom Summary');
    }
  });
});
