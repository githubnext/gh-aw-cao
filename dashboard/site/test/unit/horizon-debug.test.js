import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/**
 * Loads horizon.js with a stubbed debug output so assertions can inspect
 * emitted metadata without depending on module state left over from other tests.
 * @param {string} search
 */
async function loadHorizonWithDebug(search) {
  const output = { debug: vi.fn() };
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
  const module = await import('../../src/horizon.js');
  return { ...module, output };
}

describe('horizon debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const { resolveDashboardHorizon, dashboardHorizonHours, formatDashboardHorizonHours, output } =
      await loadHorizonWithDebug('');

    resolveDashboardHorizon({ defaults: { time: { range: 'not-a-range' } } });
    expect(() => dashboardHorizonHours('bogus')).toThrow();
    expect(() => formatDashboardHorizonHours(0)).toThrow();

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a resolve-fallback event with the invalid configured type when enabled', async () => {
    const { resolveDashboardHorizon, output } = await loadHorizonWithDebug('?debug=horizon');

    const resolved = resolveDashboardHorizon({ defaults: { time: { range: 42 } } });

    expect(resolved).toBe('1w');
    expect(output.debug).toHaveBeenCalledWith('[cao:horizon]', {
      event: 'resolve-fallback',
      configuredType: 'number',
      fallback: '1w'
    });
  });

  it('does not log a resolve-fallback event when no range was configured', async () => {
    const { resolveDashboardHorizon, output } = await loadHorizonWithDebug('?debug=horizon');

    resolveDashboardHorizon({});

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a parse-invalid event with the offending operation name when parsing fails', async () => {
    const { dashboardHorizonHours, formatDashboardHorizonHours, output } = await loadHorizonWithDebug('?debug=horizon');

    expect(() => dashboardHorizonHours('not-a-range')).toThrow('Invalid dashboard horizon: not-a-range');
    expect(output.debug).toHaveBeenCalledWith('[cao:horizon]', {
      event: 'parse-invalid',
      operation: 'dashboardHorizonHours'
    });

    expect(() => formatDashboardHorizonHours(0)).toThrow('Invalid dashboard horizon hours: 0');
    expect(output.debug).toHaveBeenCalledWith('[cao:horizon]', {
      event: 'parse-invalid',
      operation: 'formatDashboardHorizonHours'
    });
  });

  it('never logs raw dashboard configuration, only scalar metadata', async () => {
    const { resolveDashboardHorizon, output } = await loadHorizonWithDebug('?debug=horizon');

    resolveDashboardHorizon({ defaults: { time: { range: 'do-not-log-this-secret' } } });

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      expect(JSON.stringify(payload)).not.toContain('do-not-log-this-secret');
      for (const value of Object.values(payload)) {
        expect(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
