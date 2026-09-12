// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  automaticDashboardBackgroundUpdatesActive,
  automaticDashboardDataUpdatesEnabled,
  dashboardDataUpdateBlockedReason,
  ensureHealthyDashboardServiceWorker,
  periodicBackgroundSyncSupported,
  setAutomaticDashboardDataUpdatesEnabled,
  startAutomaticDashboardDataUpdates
} from '../../src/dashboard-data-updates.js';

class FakeWorker extends EventTarget {
  /** @param {boolean} healthy */
  constructor(healthy = true) {
    super();
    this.healthy = healthy;
    this.state = 'activated';
    /** @type {{ type?: string }[]} */
    this.messages = [];
  }

  /** @param {{ type?: string }} message @param {MessagePort[]} [ports] */
  postMessage(message, ports = []) {
    this.messages.push(message);
    if (message.type === 'CANARY' && this.healthy) {
      ports[0]?.postMessage({ type: 'CANARY_OK', version: 'test' });
    }
    if (message.type === 'DOWNLOAD_DATA') {
      ports[0]?.postMessage({ type: 'DOWNLOAD_COMPLETE', version: 'test' });
    }
    if (message.type === 'CONFIGURE_BACKGROUND_DATA') {
      ports[0]?.postMessage({ type: 'BACKGROUND_DATA_CONFIGURED', version: 'test' });
    }
    if (message.type === 'CLEAR_BACKGROUND_DATA') {
      ports[0]?.postMessage({ type: 'BACKGROUND_DATA_CLEARED', version: 'test' });
    }
  }
}

/** @param {FakeWorker} worker */
function registration(worker) {
  return {
    active: worker,
    waiting: null,
    installing: null,
    update: vi.fn().mockResolvedValue(undefined),
    unregister: vi.fn().mockResolvedValue(true),
    periodicSync: {
      register: vi.fn().mockResolvedValue(undefined),
      getTags: vi.fn().mockResolvedValue(['central-agentic-ops-dashboard-data']),
      unregister: vi.fn().mockResolvedValue(undefined)
    }
  };
}

const grantedPermissions = /** @type {Permissions} */ (/** @type {unknown} */ ({
  query: vi.fn().mockResolvedValue({ state: 'granted' })
}));

describe('automatic dashboard data updates', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is off by default and persists explicit opt-in', () => {
    expect(automaticDashboardDataUpdatesEnabled()).toBe(false);
    setAutomaticDashboardDataUpdatesEnabled(true);
    expect(automaticDashboardDataUpdatesEnabled()).toBe(true);
    setAutomaticDashboardDataUpdatesEnabled(false);
    expect(automaticDashboardDataUpdatesEnabled()).toBe(false);
  });

  it('detects Periodic Background Sync browser support', () => {
    expect(periodicBackgroundSyncSupported(
      /** @type {ServiceWorkerContainer} */ (/** @type {unknown} */ ({})),
      /** @type {Permissions} */ (/** @type {unknown} */ ({ query() {} })),
      { periodicSync: {} }
    )).toBe(true);
    expect(periodicBackgroundSyncSupported(
      /** @type {ServiceWorkerContainer} */ (/** @type {unknown} */ ({})),
      /** @type {Permissions} */ (/** @type {unknown} */ ({ query() {} })),
      {}
    )).toBe(false);
  });

  it('blocks downloads on metered connections and low battery', () => {
    expect(dashboardDataUpdateBlockedReason({ saveData: true }, undefined)).toBe('metered connection');
    expect(dashboardDataUpdateBlockedReason({ metered: true }, undefined)).toBe('metered connection');
    expect(dashboardDataUpdateBlockedReason({ type: 'cellular' }, undefined)).toBe('metered connection');
    expect(dashboardDataUpdateBlockedReason(undefined, { charging: false, level: 0.2 })).toBe('low battery');
    expect(dashboardDataUpdateBlockedReason(undefined, { charging: true, level: 0.1 })).toBeNull();
    expect(dashboardDataUpdateBlockedReason(undefined, { charging: false, level: 0.21 })).toBeNull();
  });

  it('preserves the setting when service workers are unsupported', async () => {
    localStorage.setItem('central-agentic-ops.dashboard.automatic-data-updates', 'true');
    localStorage.setItem('central-agentic-ops.dashboard.background-data-updates-active', 'true');
    const stop = startAutomaticDashboardDataUpdates(
      ['https://example.test/gh-aw-logs.jsonl'],
      {
        serviceWorkers: /** @type {ServiceWorkerContainer} */ (/** @type {unknown} */ (false))
      }
    );

    expect(automaticDashboardDataUpdatesEnabled()).toBe(true);
    expect(automaticDashboardBackgroundUpdatesActive()).toBe(false);
    stop();
  });

  it('preserves the setting when service worker registration fails', async () => {
    localStorage.setItem('central-agentic-ops.dashboard.automatic-data-updates', 'true');
    localStorage.setItem('central-agentic-ops.dashboard.background-data-updates-active', 'true');
    const serviceWorkers = {
      register: vi.fn().mockRejectedValue(new DOMException('Not allowed', 'SecurityError')),
      getRegistrations: vi.fn().mockResolvedValue([])
    };
    const stop = startAutomaticDashboardDataUpdates(
      ['https://example.test/gh-aw-logs.jsonl'],
      {
        serviceWorkers: /** @type {ServiceWorkerContainer} */ (/** @type {unknown} */ (serviceWorkers)),
        online: () => true,
        scriptUrl: new URL('https://example.test/service-worker.js')
      }
    );

    await vi.waitFor(() => expect(automaticDashboardBackgroundUpdatesActive()).toBe(false));
    expect(automaticDashboardDataUpdatesEnabled()).toBe(true);
    expect(serviceWorkers.register).toHaveBeenCalled();
    stop();
  });

  it('registers background sync but does not download while battery constraints block updates', async () => {
    localStorage.setItem('central-agentic-ops.dashboard.automatic-data-updates', 'true');
    const worker = new FakeWorker();
    const currentRegistration = registration(worker);
    const serviceWorkers = { register: vi.fn().mockResolvedValue(currentRegistration) };
    const stop = startAutomaticDashboardDataUpdates(
      ['https://example.test/gh-aw-logs.jsonl'],
      {
        serviceWorkers: /** @type {ServiceWorkerContainer} */ (/** @type {unknown} */ (serviceWorkers)),
        getBattery: async () => ({ charging: false, level: 0.1 }),
        permissions: grantedPermissions,
        online: () => true
      }
    );

    await vi.waitFor(() => expect(currentRegistration.periodicSync.register).toHaveBeenCalledOnce());
    expect(worker.messages.filter((message) => message.type === 'DOWNLOAD_DATA')).toHaveLength(0);
    stop();
  });

  it('canaries a worker and schedules the next download for one hour later', async () => {
    vi.useFakeTimers();
    localStorage.setItem('central-agentic-ops.dashboard.automatic-data-updates', 'true');
    const worker = new FakeWorker();
    const currentRegistration = registration(worker);
    const serviceWorkers = {
      register: vi.fn().mockResolvedValue(currentRegistration)
    };
    let now = 1000;
    const stop = startAutomaticDashboardDataUpdates(
      [
        'https://example.test/gh-aw-logs.jsonl',
        'https://example.test/inventory-sources.json'
      ],
      {
        serviceWorkers: /** @type {ServiceWorkerContainer} */ (/** @type {unknown} */ (serviceWorkers)),
        getBattery: async () => ({ charging: true, level: 1 }),
        permissions: grantedPermissions,
        online: () => true,
        scriptUrl: new URL('https://example.test/service-worker.js'),
        now: () => now
      }
    );

    await vi.waitFor(() => expect(
      worker.messages.filter((message) => message.type === 'DOWNLOAD_DATA')
    ).toHaveLength(1));
    expect(currentRegistration.update).toHaveBeenCalled();
    expect(currentRegistration.periodicSync.register).toHaveBeenCalledWith(
      'central-agentic-ops-dashboard-data',
      { minInterval: 60 * 60 * 1000 }
    );
    expect(automaticDashboardBackgroundUpdatesActive()).toBe(true);
    expect(worker.messages).toContainEqual(expect.objectContaining({
      type: 'CONFIGURE_BACKGROUND_DATA',
      urls: [
        'https://example.test/gh-aw-logs.jsonl',
        'https://example.test/inventory-sources.json'
      ]
    }));

    now += 60 * 60 * 1000;
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await vi.waitFor(() => expect(
      worker.messages.filter((message) => message.type === 'DOWNLOAD_DATA')
    ).toHaveLength(2));
    stop();
  });

  it('unregisters periodic background updates when disabled', async () => {
    localStorage.setItem('central-agentic-ops.dashboard.automatic-data-updates', 'true');
    const worker = new FakeWorker();
    const currentRegistration = registration(worker);
    const serviceWorkers = {
      register: vi.fn().mockResolvedValue(currentRegistration)
    };
    const stop = startAutomaticDashboardDataUpdates(
      ['https://example.test/gh-aw-logs.jsonl'],
      {
        serviceWorkers: /** @type {ServiceWorkerContainer} */ (/** @type {unknown} */ (serviceWorkers)),
        getBattery: async () => ({ charging: true, level: 1 }),
        permissions: grantedPermissions,
        online: () => true,
        scriptUrl: new URL('https://example.test/service-worker.js')
      }
    );
    await vi.waitFor(() => expect(currentRegistration.periodicSync.register).toHaveBeenCalledOnce());

    setAutomaticDashboardDataUpdatesEnabled(false);

    await vi.waitFor(() => expect(currentRegistration.periodicSync.unregister)
      .toHaveBeenCalledWith('central-agentic-ops-dashboard-data'));
    expect(worker.messages).toContainEqual({ type: 'CLEAR_BACKGROUND_DATA' });
    expect(currentRegistration.unregister).toHaveBeenCalledOnce();
    stop();
  });

  it('unregisters background sync when disabled during configuration', async () => {
    localStorage.setItem('central-agentic-ops.dashboard.automatic-data-updates', 'true');
    const worker = new FakeWorker();
    const currentRegistration = registration(worker);
    const serviceWorkers = {
      register: vi.fn().mockResolvedValue(currentRegistration)
    };
    /** @type {(value: { state: string }) => void} */
    let resolvePermission = () => {};
    const permissions = /** @type {Permissions} */ (/** @type {unknown} */ ({
      query: vi.fn().mockReturnValue(new Promise((resolve) => {
        resolvePermission = resolve;
      }))
    }));
    const stop = startAutomaticDashboardDataUpdates(
      ['https://example.test/gh-aw-logs.jsonl'],
      {
        serviceWorkers: /** @type {ServiceWorkerContainer} */ (/** @type {unknown} */ (serviceWorkers)),
        permissions,
        online: () => true,
        scriptUrl: new URL('https://example.test/service-worker.js')
      }
    );
    await vi.waitFor(() => expect(permissions.query).toHaveBeenCalledOnce());

    setAutomaticDashboardDataUpdatesEnabled(false);
    resolvePermission({ state: 'granted' });

    await vi.waitFor(() => expect(currentRegistration.unregister).toHaveBeenCalledOnce());
    expect(automaticDashboardBackgroundUpdatesActive()).toBe(false);
    expect(worker.messages.filter((message) => message.type === 'DOWNLOAD_DATA')).toHaveLength(0);
    stop();
  });

  it('discovers and removes an untracked dashboard worker while disabled', async () => {
    const worker = new FakeWorker();
    const orphanedRegistration = {
      ...registration(worker),
      scope: 'https://example.test/'
    };
    Object.assign(worker, { scriptURL: 'https://example.test/service-worker.js?force-update=1' });
    const serviceWorkers = {
      getRegistrations: vi.fn().mockResolvedValue([orphanedRegistration])
    };
    const stop = startAutomaticDashboardDataUpdates(
      ['https://example.test/gh-aw-logs.jsonl'],
      {
        serviceWorkers: /** @type {ServiceWorkerContainer} */ (/** @type {unknown} */ (serviceWorkers)),
        scriptUrl: new URL('https://example.test/service-worker.js')
      }
    );

    await vi.waitFor(() => expect(orphanedRegistration.unregister).toHaveBeenCalledOnce());
    expect(worker.messages).toContainEqual({ type: 'CLEAR_BACKGROUND_DATA' });
    stop();
  });

  it('preserves the setting when periodic background sync is denied', async () => {
    localStorage.setItem('central-agentic-ops.dashboard.automatic-data-updates', 'true');
    localStorage.setItem('central-agentic-ops.dashboard.background-data-updates-active', 'true');
    const worker = new FakeWorker();
    const currentRegistration = registration(worker);
    const serviceWorkers = {
      register: vi.fn().mockResolvedValue(currentRegistration)
    };
    const setTimer = vi.fn();
    const stop = startAutomaticDashboardDataUpdates(
      ['https://example.test/gh-aw-logs.jsonl'],
      {
        serviceWorkers: /** @type {ServiceWorkerContainer} */ (/** @type {unknown} */ (serviceWorkers)),
        getBattery: async () => ({ charging: true, level: 1 }),
        permissions: /** @type {Permissions} */ (/** @type {unknown} */ ({
          query: vi.fn().mockResolvedValue({ state: 'denied' })
        })),
        online: () => true,
        scriptUrl: new URL('https://example.test/service-worker.js'),
        setTimer: /** @type {typeof window.setTimeout} */ (/** @type {unknown} */ (setTimer))
      }
    );

    await vi.waitFor(() => expect(currentRegistration.unregister).toHaveBeenCalledOnce());
    expect(automaticDashboardDataUpdatesEnabled()).toBe(true);
    expect(automaticDashboardBackgroundUpdatesActive()).toBe(false);
    expect(worker.messages.filter((message) => message.type === 'DOWNLOAD_DATA')).toHaveLength(0);
    expect(setTimer).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('online'));
    await Promise.resolve();
    expect(serviceWorkers.register).toHaveBeenCalledOnce();
    stop();
  });

  it('preserves the setting when periodic background sync is unsupported', async () => {
    localStorage.setItem('central-agentic-ops.dashboard.automatic-data-updates', 'true');
    localStorage.setItem('central-agentic-ops.dashboard.background-data-updates-active', 'true');
    const worker = new FakeWorker();
    const currentRegistration = { ...registration(worker), periodicSync: undefined };
    const serviceWorkers = {
      register: vi.fn().mockResolvedValue(currentRegistration)
    };
    const setTimer = vi.fn();
    const stop = startAutomaticDashboardDataUpdates(
      ['https://example.test/gh-aw-logs.jsonl'],
      {
        serviceWorkers: /** @type {ServiceWorkerContainer} */ (/** @type {unknown} */ (serviceWorkers)),
        getBattery: async () => ({ charging: true, level: 1 }),
        online: () => true,
        scriptUrl: new URL('https://example.test/service-worker.js'),
        setTimer: /** @type {typeof window.setTimeout} */ (/** @type {unknown} */ (setTimer))
      }
    );

    await vi.waitFor(() => expect(currentRegistration.unregister).toHaveBeenCalledOnce());
    expect(automaticDashboardDataUpdatesEnabled()).toBe(true);
    expect(automaticDashboardBackgroundUpdatesActive()).toBe(false);
    expect(worker.messages.filter((message) => message.type === 'DOWNLOAD_DATA')).toHaveLength(0);
    expect(setTimer).not.toHaveBeenCalled();
    stop();
  });

  it('force-registers a cache-busted worker when the active canary fails', async () => {
    vi.useFakeTimers();
    const brokenRegistration = registration(new FakeWorker(false));
    const recoveredWorker = new FakeWorker();
    const recoveredRegistration = registration(recoveredWorker);
    const serviceWorkers = {
      register: vi.fn()
        .mockResolvedValueOnce(brokenRegistration)
        .mockResolvedValueOnce(recoveredRegistration)
    };
    const recovery = ensureHealthyDashboardServiceWorker(
      /** @type {ServiceWorkerContainer} */ (/** @type {unknown} */ (serviceWorkers)),
      new URL('https://example.test/service-worker.js')
    );

    await vi.advanceTimersByTimeAsync(3000);
    await recovery;

    expect(brokenRegistration.unregister).toHaveBeenCalledOnce();
    expect(serviceWorkers.register).toHaveBeenCalledTimes(2);
    expect(String(serviceWorkers.register.mock.calls[1][0])).toContain('force-update=');
  });
});
