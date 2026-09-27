import { describe, expect, it, vi } from 'vitest';

const metadata = {
  'as-of': '2026-09-09T05:00:00Z',
  'artifact-generation': 'abc123'
};

const runsSource = {
  runs: {
    rows: [{
      organization: 'githubnext',
      repository: 'gh-aw-cao',
      workflow: '.github/workflows/dashboard.md',
      run: '12345',
      'run-status': 'completed',
      'observed-at': '2026-09-09T04:30:00Z'
    }],
    metadata
  }
};

describe('dashboard source ingestion query debug logging', () => {
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
    const { queryDashboardSourceObservations } = await import('../../src/data/queries/ingestion.js');

    queryDashboardSourceObservations(runsSource);

    expect(output.debug).not.toHaveBeenCalled();

    vi.doUnmock('../../src/debug.js');
    vi.resetModules();
  });

  it('logs a predictable category with only scalar metadata when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=ingestion', output })
      };
    });
    vi.resetModules();
    const { queryDashboardSourceObservations } = await import('../../src/data/queries/ingestion.js');

    const adapted = queryDashboardSourceObservations(runsSource);

    expect(output.debug).toHaveBeenCalledWith('[cao:ingestion]', 'derived dashboard source observations', {
      observationCount: adapted.observations.length
    });

    for (const call of output.debug.mock.calls) {
      const metadata = call[2];
      expect(Object.values(metadata).every((value) => typeof value !== 'object')).toBe(true);
    }

    vi.doUnmock('../../src/debug.js');
    vi.resetModules();
  });

  it('logs unavailable mapping inputs and failed queries without row content', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=ingestion', output })
      };
    });
    vi.resetModules();
    const { queryDashboardSourceObservations } = await import('../../src/data/queries/ingestion.js');

    expect(() => queryDashboardSourceObservations({
      runs: {
        rows: [],
        metadata: { ...metadata, availability: 'unavailable', error: 'runs feed unavailable' }
      }
    })).toThrow('runs feed unavailable');

    const unavailableCall = output.debug.mock.calls.find(([, , meta]) => meta && Object.hasOwn(meta, 'input'));
    expect(unavailableCall?.[0]).toBe('[cao:ingestion]');
    expect(unavailableCall?.[1]).toBe('mapping input unavailable');
    expect(unavailableCall?.[2]).toEqual({ kind: 'run', input: '$runs' });

    for (const call of output.debug.mock.calls) {
      const meta = call[2];
      expect(Object.values(meta).every((value) => typeof value !== 'object')).toBe(true);
      expect(JSON.stringify(meta)).not.toContain('githubnext');
      expect(JSON.stringify(meta)).not.toContain('gh-aw-cao');
    }

    vi.doUnmock('../../src/debug.js');
    vi.resetModules();
  });
});
