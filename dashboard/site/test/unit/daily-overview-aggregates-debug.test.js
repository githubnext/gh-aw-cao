import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/** @param {Partial<Record<string, unknown>>} overrides */
function run(overrides) {
  return {
    id: 'run-1',
    event: 'schedule',
    status: 'completed',
    conclusion: 'success',
    startedAt: '2026-09-10T00:00:00Z',
    createdAt: '2026-09-10T00:00:00Z',
    ...overrides
  };
}

describe('daily-overview-aggregates debug logging', () => {
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
    const { buildDailyOverviewAggregates } = await import('../../src/data/analytics/daily-overview-aggregates.js');

    buildDailyOverviewAggregates([run({ id: 'r1' }), run({ id: 'r2', startedAt: null, createdAt: null })]);

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs build boundaries with deduped/skipped counts under its predictable category when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=daily-overview-aggregates', output })
      };
    });
    vi.resetModules();
    const { buildDailyOverviewAggregates } = await import('../../src/data/analytics/daily-overview-aggregates.js');

    buildDailyOverviewAggregates([
      run({ id: 'r1', startedAt: '2026-09-10T00:00:00Z' }),
      run({ id: 'r1', startedAt: '2026-09-10T00:00:00Z' }), // duplicate identity, deduped
      run({ id: 'r2', startedAt: null, createdAt: null }) // unresolvable day, skipped
    ]);

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:daily-overview-aggregates]',
      { operation: 'build', inputRuns: 3, dedupedRuns: 2 }
    );
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:daily-overview-aggregates]',
      { operation: 'build-complete', days: 1, skippedRuns: 1 }
    );
  });

  it('never logs run identities or other non-scalar record content', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=daily-overview-aggregates', output })
      };
    });
    vi.resetModules();
    const { buildDailyOverviewAggregates } = await import('../../src/data/analytics/daily-overview-aggregates.js');

    buildDailyOverviewAggregates([run({ id: 'super-secret-run-id' })]);

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('super-secret-run-id');
    }
  });
});
