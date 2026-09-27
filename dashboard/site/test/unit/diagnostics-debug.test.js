// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const queryDatabase = () => Promise.resolve({
  schemaVersion: 13,
  counts: {
    campaigns: 0,
    repositories: 1,
    workflows: 1,
    runs: 1,
    domains: 0,
    tools: 0,
    audits: 1,
    issues: 0
  },
  relationshipErrors: [],
  duplicateRecordIds: {
    campaigns: [],
    repositories: [],
    workflows: [],
    runs: [],
    domains: [],
    tools: [],
    audits: [],
    issues: []
  }
});

function silenceConsoleReport() {
  vi.spyOn(console, 'group').mockImplementation(() => {});
  vi.spyOn(console, 'groupEnd').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'table').mockImplementation(() => {});
}

afterEach(() => {
  document.body.replaceChildren();
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('diagnostics debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    document.body.innerHTML = '<main class="dashboard-root"></main>';
    silenceConsoleReport();
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
    const { collectFullDiagnostics } = await import('../../src/diagnostics.js');

    await collectFullDiagnostics({ queryDatabase });

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs collection start, database query outcome, and completion under its predictable category when enabled', async () => {
    document.body.innerHTML = '<main class="dashboard-root"></main>';
    silenceConsoleReport();
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=diagnostics', output })
      };
    });
    vi.resetModules();
    const { collectFullDiagnostics } = await import('../../src/diagnostics.js');

    const report = await collectFullDiagnostics({ queryDatabase });

    expect(output.debug).toHaveBeenCalledWith('[cao:diagnostics]', { event: 'collect-start' });
    expect(output.debug).toHaveBeenCalledWith('[cao:diagnostics]', {
      event: 'database-queried',
      schemaVersion: 13,
      relationshipErrorCount: 0
    });
    expect(output.debug).toHaveBeenCalledWith('[cao:diagnostics]', {
      event: 'collect-complete',
      passed: report.passed,
      checkCount: report.checks.length,
      failedCheckCount: report.checks.filter((item) => !item.passed).length
    });
  });

  it('never logs sensitive payload content, only scalar metadata', async () => {
    document.body.innerHTML = '<main class="dashboard-root"></main>';
    silenceConsoleReport();
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=diagnostics', output })
      };
    });
    vi.resetModules();
    const { collectFullDiagnostics } = await import('../../src/diagnostics.js');

    await collectFullDiagnostics({ queryDatabase });

    expect(output.debug.mock.calls.length).toBeGreaterThan(0);
    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
