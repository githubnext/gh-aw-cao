import { afterEach, describe, expect, it, vi } from 'vitest';

const validDashboard = {
  id: 'agentic-operations',
  title: 'Agentic Operations',
  defaults: { scope: {}, time: {}, filters: {} },
  pages: [
    {
      id: 'custom-summary',
      kind: 'custom',
      title: 'Custom Summary',
      views: [
        {
          id: 'run-count',
          data: { source: 'runs' },
          mark: 'metric',
          encoding: { value: { field: 'run', aggregate: 'count' } }
        }
      ]
    }
  ]
};

const missingPagesDashboard = {
  id: 'agentic-operations',
  title: 'Agentic Operations'
};

const invalidYamlSource = 'dashboard: [unterminated';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('validator-dashboard debug logging', () => {
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
    const { parseDocuments, validateDashboard } = await import('../../src/validator-dashboard.js');

    parseDocuments(invalidYamlSource, []);
    validateDashboard(validDashboard, null, []);
    validateDashboard(missingPagesDashboard, null, []);

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs parse and validation outcomes with page/error counts under its predictable category when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=validator-dashboard', output })
      };
    });
    vi.resetModules();
    const { parseDocuments, validateDashboard } = await import('../../src/validator-dashboard.js');

    parseDocuments(invalidYamlSource, []);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:validator-dashboard]',
      { operation: 'parse-documents', status: 'yaml-syntax' }
    );

    output.debug.mockClear();
    /** @type {import('../../src/validator.js').ValidationError[]} */
    const okErrors = [];
    validateDashboard(validDashboard, null, okErrors);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:validator-dashboard]',
      { operation: 'validate-dashboard', status: 'ok', pageCount: 1, errorCount: 0 }
    );

    output.debug.mockClear();
    /** @type {import('../../src/validator.js').ValidationError[]} */
    const missingPagesErrors = [];
    validateDashboard(missingPagesDashboard, null, missingPagesErrors);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:validator-dashboard]',
      { operation: 'validate-dashboard', status: 'invalid', reason: 'missing-pages', errorCount: missingPagesErrors.length }
    );
    expect(missingPagesErrors.length).toBeGreaterThan(0);
  });

  it('never logs source text, dashboard identifiers, or error details, only scalar status and counts', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=validator-dashboard', output })
      };
    });
    vi.resetModules();
    const { parseDocuments, validateDashboard } = await import('../../src/validator-dashboard.js');

    parseDocuments(invalidYamlSource, []);
    validateDashboard(validDashboard, null, []);
    validateDashboard(missingPagesDashboard, null, []);

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('agentic-operations');
      expect(JSON.stringify(payload)).not.toContain('unterminated');
    }
  });
});
