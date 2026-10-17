import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/** @param {{ output: { debug: import('vitest').Mock }, search?: string }} options */
async function importTelemetry({ output, search = '' }) {
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
  return import('../../src/data/adapters/unified-session-telemetry.js');
}

const records = [
  { line: 1, record: { type: 'usage.report', data: { requestId: 'secret-request', usage: { inputTokens: 5 } } } },
  { line: 2, record: { type: 'safe_output.result', data: { type: 'issue', repo: 'private/repo', url: 'https://example.com/x' } } }
];
const context = { runId: '1', attempt: 1 };

describe('unified session telemetry debug logging', () => {
  it('is silent by default', async () => {
    const output = { debug: vi.fn() };
    const { sessionRunMetadata } = await importTelemetry({ output });
    sessionRunMetadata(records, context);
    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs scalar counts only under the filename category', async () => {
    const output = { debug: vi.fn() };
    const { sessionRunMetadata } = await importTelemetry({ output, search: '?debug=unified-session-telemetry' });
    sessionRunMetadata(records, context);
    expect(output.debug).toHaveBeenCalledTimes(1);
    expect(output.debug).toHaveBeenCalledWith('[cao:unified-session-telemetry]', {
      event: 'run-metadata', records: 2, phases: 1, safeOutputs: 1, hasUsage: true
    });
    const text = JSON.stringify(output.debug.mock.calls);
    for (const secret of ['secret-request', 'private/repo', 'example.com']) expect(text).not.toContain(secret);
  });

  it('respects exclusion', async () => {
    const output = { debug: vi.fn() };
    const { sessionRunMetadata } = await importTelemetry({ output, search: '?debug=*,-unified-session-telemetry' });
    sessionRunMetadata(records, context);
    expect(output.debug).not.toHaveBeenCalled();
  });
});
