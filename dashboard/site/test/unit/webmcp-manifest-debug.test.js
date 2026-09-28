import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/**
 * @param {{ output: { debug: import('vitest').Mock }, search?: string }} options
 */
async function importManifestWithDebug({ output, search = '' }) {
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
  return import('../../src/webmcp/manifest.js');
}

/** Builds a dashboard document with a name collision between two pages. */
function buildDocumentWithDuplicateNames() {
  return {
    dashboard: {
      title: 'Central Agentic Ops Dashboard',
      navigation: [{ pages: ['cost-a', 'cost_a'] }],
      pages: [
        { id: 'cost-a', kind: 'custom', title: 'Cost A' },
        { id: 'cost_a', kind: 'custom', title: 'Cost A Duplicate' }
      ]
    }
  };
}

describe('webmcp manifest debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const output = { debug: vi.fn() };
    const { webMCPManifestForDashboard } = await importManifestWithDebug({ output });

    webMCPManifestForDashboard(buildDocumentWithDuplicateNames());

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs manifest-generated with predictable counts under the "webmcp-manifest" category when enabled', async () => {
    const output = { debug: vi.fn() };
    const { webMCPManifestForDashboard } = await importManifestWithDebug({ output, search: '?debug=webmcp-manifest' });

    const manifest = webMCPManifestForDashboard(buildDocumentWithDuplicateNames());

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:webmcp-manifest]',
      { event: 'manifest-generated', toolCount: manifest.length, skippedCount: 1 }
    );
  });

  it('logs tool-skipped with a sanitized reason for a duplicate tool name', async () => {
    const output = { debug: vi.fn() };
    const { webMCPManifestForDashboard } = await importManifestWithDebug({ output, search: '?debug=webmcp-manifest' });

    webMCPManifestForDashboard(buildDocumentWithDuplicateNames());

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:webmcp-manifest]',
      { event: 'tool-skipped', pageId: 'cost_a', reason: 'duplicate-name' }
    );
    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number').toBe(true);
      }
    }
  });

  it('respects category filtering and stays silent for a non-matching category', async () => {
    const output = { debug: vi.fn() };
    const { webMCPManifestForDashboard } = await importManifestWithDebug({ output, search: '?debug=runtime' });

    webMCPManifestForDashboard(buildDocumentWithDuplicateNames());

    expect(output.debug).not.toHaveBeenCalled();
  });
});
