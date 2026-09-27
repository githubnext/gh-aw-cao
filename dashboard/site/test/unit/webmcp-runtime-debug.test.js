import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/** Builds a dashboard document with one plain agent-facing page. */
function buildDashboardDocument() {
  return {
    dashboard: {
      title: 'Central Agentic Ops Dashboard',
      navigation: [{ pages: ['cost'] }],
      pages: [
        { id: 'cost', kind: 'custom', title: 'Cost', description: 'Observed AI Credit cost.' }
      ]
    }
  };
}

/**
 * Builds a minimal WebMCP page API that records registered tools.
 */
function buildModelContext() {
  /** @type {Map<string, Record<string, unknown>>} */
  const tools = new Map();
  return {
    tools,
    /**
     * @param {Record<string, unknown>} tool
     * @param {{ signal?: AbortSignal }} [registerOptions]
     */
    registerTool(tool, registerOptions) {
      const name = String(tool.name);
      tools.set(name, tool);
      registerOptions?.signal?.addEventListener('abort', () => tools.delete(name), { once: true });
      return Promise.resolve();
    }
  };
}

/**
 * @param {{ output: { debug: import('vitest').Mock }, search?: string }} options
 */
async function importRuntimeWithDebug({ output, search = '' }) {
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
  return import('../../src/webmcp/runtime.js');
}

describe('webmcp runtime debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const output = { debug: vi.fn() };
    const { startDashboardWebMCP } = await importRuntimeWithDebug({ output });

    const modelContext = buildModelContext();
    const loadPageSources = vi.fn().mockResolvedValue({});
    const driver = startDashboardWebMCP({ modelContext }, { dashboardDocument: buildDashboardDocument, loadPageSources });
    await driver?.toolNames();
    const tool = modelContext.tools.get('cao_cost');
    await /** @type {{ execute: (args: unknown) => Promise<unknown> }} */ (tool).execute({});

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs refreshed and tool-executed events under the predictable "runtime" category when enabled', async () => {
    const output = { debug: vi.fn() };
    const { startDashboardWebMCP } = await importRuntimeWithDebug({ output, search: '?debug=runtime' });

    const modelContext = buildModelContext();
    const loadPageSources = vi.fn().mockResolvedValue({
      runs: { rows: [{ run: '1' }], metadata: { availability: 'available' } }
    });
    startDashboardWebMCP({ modelContext }, { dashboardDocument: buildDashboardDocument, loadPageSources });

    expect(output.debug).toHaveBeenCalledWith('[cao:runtime]', { event: 'refreshed', toolCount: 1 });

    const tool = modelContext.tools.get('cao_cost');
    await /** @type {{ execute: (args: unknown) => Promise<unknown> }} */ (tool).execute({});

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:runtime]',
      { event: 'tool-executed', tool: 'cao_cost', page: 'cost', sourceCount: 1 }
    );
  });

  it('logs tool-failed with only a sanitized error name, never raw error messages', async () => {
    const output = { debug: vi.fn() };
    const { startDashboardWebMCP } = await importRuntimeWithDebug({ output, search: '?debug=runtime' });

    const modelContext = buildModelContext();
    const loadPageSources = vi.fn().mockRejectedValue(new Error('secret token abc123 leaked in message'));
    startDashboardWebMCP({ modelContext }, { dashboardDocument: buildDashboardDocument, loadPageSources });

    const tool = modelContext.tools.get('cao_cost');
    await /** @type {{ execute: (args: unknown) => Promise<unknown> }} */ (tool).execute({});

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:runtime]',
      { event: 'tool-failed', tool: 'cao_cost', page: 'cost', errorName: 'Error' }
    );
    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('secret token');
      expect(JSON.stringify(payload)).not.toContain('abc123');
    }
  });
});
