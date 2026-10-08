// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Loads backend-mode.js with a stubbed debug output so assertions can
 * inspect emitted metadata without depending on module state left over from
 * other tests.
 * @param {string} search
 */
async function loadBackendModeWithDebug(search) {
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
  const module = await import('../../src/backend-mode.js');
  return { ...module, output };
}

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('backend-mode debug logging', () => {
  it('is disabled by default when the debug query is absent', async () => {
    const { usesRemoteDataBackend, disableRemoteDashboardPwa, output } = await loadBackendModeWithDebug('');

    usesRemoteDataBackend(/** @type {any} */ ({ querySelector: () => null }));
    await disableRemoteDashboardPwa(/** @type {any} */ ({
      serviceWorkers: { getRegistrations: async () => [] },
      cacheStorage: { keys: async () => [], delete: async () => true }
    }));

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs uses-remote-data-backend outcomes under its predictable category when enabled', async () => {
    const { usesRemoteDataBackend, output } = await loadBackendModeWithDebug('?debug=backend-mode');

    const remoteDocument = /** @type {any} */ ({
      querySelector: () => ({ getAttribute: () => 'server-http' })
    });
    expect(usesRemoteDataBackend(remoteDocument)).toBe(true);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:backend-mode]',
      { operation: 'uses-remote-data-backend', remote: true }
    );

    output.debug.mockClear();
    const staticDocument = /** @type {any} */ ({ querySelector: () => null });
    expect(usesRemoteDataBackend(staticDocument)).toBe(false);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:backend-mode]',
      { operation: 'uses-remote-data-backend', remote: false }
    );
  });

  it('logs service-worker and cache cleanup counts during PWA teardown', async () => {
    const { disableRemoteDashboardPwa, output } = await loadBackendModeWithDebug('?debug=backend-mode');

    const unregister = vi.fn(async () => true);
    await disableRemoteDashboardPwa(/** @type {any} */ ({
      serviceWorkers: { getRegistrations: async () => [{ unregister }, { unregister }] },
      cacheStorage: {
        keys: async () => ['central-agentic-ops-dashboard-v1', 'other-cache'],
        delete: vi.fn(async () => true)
      }
    }));

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:backend-mode]',
      { operation: 'disable-remote-pwa', status: 'service-workers-unregistered', count: 2 }
    );
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:backend-mode]',
      { operation: 'disable-remote-pwa', status: 'caches-deleted', count: 1 }
    );
  });

  it('never logs sensitive payload content, only scalar metadata', async () => {
    const { usesRemoteDataBackend, disableRemoteDashboardPwa, output } = await loadBackendModeWithDebug('?debug=backend-mode');

    usesRemoteDataBackend(/** @type {any} */ ({
      querySelector: () => ({ getAttribute: () => 'server-http' })
    }));
    await disableRemoteDashboardPwa(/** @type {any} */ ({
      serviceWorkers: { getRegistrations: async () => [] },
      cacheStorage: { keys: async () => ['central-agentic-ops-dashboard-secret-token'], delete: async () => true }
    }));

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
