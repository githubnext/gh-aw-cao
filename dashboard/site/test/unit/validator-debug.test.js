import { afterEach, describe, expect, it, vi } from 'vitest';

const validDocument = `language-version: "0.1.0"
dashboard:
  id: agentic-operations
  title: Agentic Operations
  defaults:
    scope: {}
    time: {}
    filters: {}
  pages:
    - id: custom-summary
      kind: custom
      title: Custom Summary
      views:
        - id: run-count
          data:
            source: runs
          mark: metric
          encoding:
            value:
              field: run
              aggregate: count
`;

const invalidDocument = `language-version: "0.1.0"
dashboard: not-a-mapping
`;

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('validator debug logging', () => {
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
    const { validateDashboardDocument, validateLogicalSources } = await import('../../src/validator.js');

    validateDashboardDocument(validDocument);
    validateDashboardDocument(invalidDocument);
    validateLogicalSources({ workflows: { rows: [] } });

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs document and logical-source validation outcomes with an error count under its predictable category when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=validator', output })
      };
    });
    vi.resetModules();
    const { validateDashboardDocument, validateLogicalSources } = await import('../../src/validator.js');

    const accepted = validateDashboardDocument(validDocument);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:validator]',
      { operation: 'validate-dashboard-document', status: 'ok', errorCount: 0 }
    );

    output.debug.mockClear();
    const rejected = validateDashboardDocument(invalidDocument);
    expect(rejected.ok).toBe(false);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:validator]',
      { operation: 'validate-dashboard-document', status: 'invalid', errorCount: rejected.errors.length }
    );
    expect(accepted.ok).toBe(true);

    output.debug.mockClear();
    validateLogicalSources({
      workflows: {
        rows: [{ 'workflow-role': 'standalone' }]
      }
    });
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:validator]',
      { operation: 'validate-logical-sources', status: 'ok', errorCount: 0 }
    );
  });

  it('never logs source text or error details, only scalar status and counts', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=validator', output })
      };
    });
    vi.resetModules();
    const { validateDashboardDocument, validateLogicalSources } = await import('../../src/validator.js');

    validateDashboardDocument(validDocument);
    validateDashboardDocument(invalidDocument);
    validateLogicalSources({ workflows: { rows: [] } });

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('language-version');
      expect(JSON.stringify(payload)).not.toContain('agentic-operations');
    }
  });
});
