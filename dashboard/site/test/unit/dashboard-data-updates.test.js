// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  automaticDashboardDataUpdatesEnabled,
  dashboardDataUpdateBlockedReason,
  ensureHealthyDashboardServiceWorker,
  setAutomaticDashboardDataUpdatesEnabled,
  startAutomaticDashboardDataUpdates
} from '../../src/dashboard-data-updates.js';

class FakeWorker extends EventTarget {
  /** @param {boolean} healthy */
  constructor(healthy = true) {
    super();
    this.healthy = healthy;
    this.state = 'activated';
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
  }
}

/** @param {FakeWorker} worker */
function registration(worker) {
  return {
    active: worker,
    waiting: null,
    installing: null,
    update: vi.fn().mockResolvedValue(undefined),
    unregister: vi.fn().mockResolvedValue(true)
  };
}

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

  it('blocks downloads on metered connections and low battery', () => {
    expect(dashboardDataUpdateBlockedReason({ saveData: true }, undefined)).toBe('metered connection');
    expect(dashboardDataUpdateBlockedReason({ metered: true }, undefined)).toBe('metered connection');
    expect(dashboardDataUpdateBlockedReason(undefined, { charging: false, level: 0.2 })).toBe('low battery');
    expect(dashboardDataUpdateBlockedReason(undefined, { charging: true, level: 0.1 })).toBeNull();
    expect(dashboardDataUpdateBlockedReason(undefined, { charging: false, level: 0.21 })).toBeNull();
  });

  it('does not register while battery constraints block updates', async () => {
    localStorage.setItem('central-agentic-ops.dashboard.automatic-data-updates', 'true');
    const serviceWorkers = { register: vi.fn() };
    const stop = startAutomaticDashboardDataUpdates(
      ['https://example.test/gh-aw-logs.jsonl'],
      {
        serviceWorkers: /** @type {ServiceWorkerContainer} */ (serviceWorkers),
        getBattery: async () => ({ charging: false, level: 0.1 }),
        online: () => true
      }
    );

    await vi.waitFor(() => expect(serviceWorkers.register).not.toHaveBeenCalled());
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
        serviceWorkers: /** @type {ServiceWorkerContainer} */ (serviceWorkers),
        getBattery: async () => ({ charging: true, level: 1 }),
        online: () => true,
        scriptUrl: new URL('https://example.test/service-worker.js'),
        now: () => now
      }
    );

    await vi.waitFor(() => expect(
      worker.messages.filter((message) => message.type === 'DOWNLOAD_DATA')
    ).toHaveLength(1));
    expect(currentRegistration.update).toHaveBeenCalled();

    now += 60 * 60 * 1000;
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await vi.waitFor(() => expect(
      worker.messages.filter((message) => message.type === 'DOWNLOAD_DATA')
    ).toHaveLength(2));
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
      /** @type {ServiceWorkerContainer} */ (serviceWorkers),
      new URL('https://example.test/service-worker.js')
    );

    await vi.advanceTimersByTimeAsync(3000);
    await recovery;

    expect(brokenRegistration.unregister).toHaveBeenCalledOnce();
    expect(serviceWorkers.register).toHaveBeenCalledTimes(2);
    expect(String(serviceWorkers.register.mock.calls[1][0])).toContain('force-update=');
  });
});
