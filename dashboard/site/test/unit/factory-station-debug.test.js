// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/**
 * Loads renderFactoryStation with a stubbed debug output so assertions can
 * inspect emitted metadata without depending on module state left over from
 * other tests.
 * @param {string} search
 */
async function loadFactoryStationWithDebug(search) {
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
  const module = await import('../../src/components/factory-station.js');
  return { ...module, output };
}

/** @param {Partial<{ pending: boolean, unavailable: boolean, label: string, value: number, detail: { text: string, href?: string } }>} overrides */
function station(overrides = {}) {
  return { pending: false, unavailable: false, label: 'Station', value: 0, ...overrides };
}

describe('factory-station debug logging', () => {
  it('is disabled by default when the debug query is absent', async () => {
    const { renderFactoryStation, output } = await loadFactoryStationWithDebug('');
    const controller = new AbortController();

    const result = renderFactoryStation('repo', { signal: controller.signal });
    result.bind(() => station());

    expect(output.debug).not.toHaveBeenCalled();
    controller.abort();
  });

  it('logs a predictable bound event under its category', async () => {
    const { renderFactoryStation, output } = await loadFactoryStationWithDebug('?debug=factory-station');
    const controller = new AbortController();

    renderFactoryStation('repo', { animate: true, format: 'percent', href: '#page-repositories', signal: controller.signal });

    expect(output.debug).toHaveBeenCalledWith('[cao:factory-station]', {
      event: 'bound',
      format: 'percent',
      hasHref: true
    });
    controller.abort();
  });

  it('logs an unavailable-changed event only when availability transitions', async () => {
    const { renderFactoryStation, output } = await loadFactoryStationWithDebug('?debug=factory-station');
    const controller = new AbortController();
    const result = renderFactoryStation('repo', { signal: controller.signal });

    let current = station();
    result.bind(() => current);
    expect(output.debug).toHaveBeenCalledWith('[cao:factory-station]', { event: 'unavailable-changed', unavailable: false });

    output.debug.mockClear();
    current = station();
    result.bind(() => current);
    expect(output.debug).not.toHaveBeenCalledWith('[cao:factory-station]', expect.objectContaining({ event: 'unavailable-changed' }));

    current = station({ unavailable: true });
    result.bind(() => current);
    expect(output.debug).toHaveBeenCalledWith('[cao:factory-station]', { event: 'unavailable-changed', unavailable: true });
    controller.abort();
  });

  it('logs a pending-changed event only when pending state transitions', async () => {
    const { renderFactoryStation, output } = await loadFactoryStationWithDebug('?debug=factory-station');
    const controller = new AbortController();
    const result = renderFactoryStation('repo', { signal: controller.signal });

    result.bind(() => station({ pending: true }));
    expect(output.debug).toHaveBeenCalledWith('[cao:factory-station]', { event: 'pending-changed', pending: true });

    output.debug.mockClear();
    result.bind(() => station({ pending: false }));
    expect(output.debug).toHaveBeenCalledWith('[cao:factory-station]', { event: 'pending-changed', pending: false });
    controller.abort();
  });

  it('only logs scalar metadata values', async () => {
    const { renderFactoryStation, output } = await loadFactoryStationWithDebug('?debug=factory-station');
    const controller = new AbortController();
    const result = renderFactoryStation('repo', { signal: controller.signal });

    result.bind(() => station({ pending: true, unavailable: true, detail: { text: 'secret-detail' } }));

    for (const call of output.debug.mock.calls) {
      expect(call[0]).toBe('[cao:factory-station]');
      expect(Object.values(call[1]).every((entry) => typeof entry !== 'object')).toBe(true);
    }
    controller.abort();
  });
});
