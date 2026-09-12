const ENABLED_STORAGE_KEY = 'central-agentic-ops.dashboard.automatic-data-updates';
const LAST_SUCCESS_STORAGE_KEY = 'central-agentic-ops.dashboard.automatic-data-update-last-success';
const SETTING_EVENT = 'dashboard-automatic-data-updates-setting-change';
const UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const RETRY_INTERVAL_MS = 5 * 60 * 1000;
const LOW_BATTERY_LEVEL = 0.2;
const CANARY_TIMEOUT_MS = 3000;
const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;

/** @typedef {{ saveData?: boolean, metered?: boolean, addEventListener?: EventTarget['addEventListener'], removeEventListener?: EventTarget['removeEventListener'] }} ConnectionState */
/** @typedef {{ charging: boolean, level: number, addEventListener?: EventTarget['addEventListener'], removeEventListener?: EventTarget['removeEventListener'] }} BatteryState */

/** @param {Storage} [storage] */
export function automaticDashboardDataUpdatesEnabled(storage = localStorage) {
  return storage.getItem(ENABLED_STORAGE_KEY) === 'true';
}

/** @param {boolean} enabled @param {Storage} [storage] */
export function setAutomaticDashboardDataUpdatesEnabled(enabled, storage = localStorage) {
  if (enabled) storage.setItem(ENABLED_STORAGE_KEY, 'true');
  else {
    storage.removeItem(ENABLED_STORAGE_KEY);
    storage.removeItem(LAST_SUCCESS_STORAGE_KEY);
  }
  window.dispatchEvent(new Event(SETTING_EVENT));
}

/**
 * @param {ConnectionState | undefined} connection
 * @param {BatteryState | undefined} battery
 */
export function dashboardDataUpdateBlockedReason(connection, battery) {
  if (connection?.saveData || connection?.metered) return 'metered connection';
  if (battery && !battery.charging && battery.level <= LOW_BATTERY_LEVEL) return 'low battery';
  return null;
}

/**
 * @param {ServiceWorker} worker
 * @param {unknown} message
 * @param {number} timeoutMs
 * @returns {Promise<unknown>}
 */
function requestWorker(worker, message, timeoutMs) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = window.setTimeout(() => {
      channel.port1.close();
      reject(new Error('Service worker response timed out.'));
    }, timeoutMs);
    channel.port1.onmessage = (event) => {
      window.clearTimeout(timeout);
      channel.port1.close();
      resolve(event.data);
    };
    worker.postMessage(message, [channel.port2]);
  });
}

/** @param {ServiceWorker} worker */
async function canaryWorker(worker) {
  const response = await requestWorker(worker, { type: 'CANARY' }, CANARY_TIMEOUT_MS);
  return Boolean(response && typeof response === 'object'
    && /** @type {{ type?: unknown }} */ (response).type === 'CANARY_OK');
}

/** @param {ServiceWorker | null} worker */
function waitForWorker(worker) {
  if (!worker || worker.state === 'redundant') return Promise.resolve(null);
  if (worker.state === 'installed' || worker.state === 'activated') return Promise.resolve(worker);
  return new Promise((resolve) => {
    const onStateChange = () => {
      if (!['installed', 'activated', 'redundant'].includes(worker.state)) return;
      worker.removeEventListener('statechange', onStateChange);
      resolve(worker.state === 'redundant' ? null : worker);
    };
    worker.addEventListener('statechange', onStateChange);
  });
}

/**
 * Updates the registration without HTTP cache reuse, canaries a waiting worker
 * before activation, and force-registers a cache-busted script if the active
 * worker cannot answer the canary.
 * @param {ServiceWorkerContainer} serviceWorkers
 * @param {URL} scriptUrl
 */
export async function ensureHealthyDashboardServiceWorker(serviceWorkers, scriptUrl) {
  const options = { scope: new URL('./', scriptUrl).pathname, updateViaCache: /** @type {ServiceWorkerUpdateViaCache} */ ('none') };
  let registration = await serviceWorkers.register(scriptUrl, options);
  await registration.update();

  const candidate = await waitForWorker(registration.waiting ?? registration.installing);
  if (candidate) {
    try {
      if (await canaryWorker(candidate)) candidate.postMessage({ type: 'ACTIVATE' });
    } catch {
      // Keep the healthy active worker; a later update can replace this candidate.
    }
  }

  const active = registration.active ?? candidate;
  if (active) {
    try {
      if (await canaryWorker(active)) return { registration, worker: active };
    } catch {
      // Force recovery below when the controlling worker cannot answer.
    }
  }

  await registration.unregister();
  const recoveryUrl = new URL(scriptUrl);
  recoveryUrl.searchParams.set('force-update', String(Date.now()));
  registration = await serviceWorkers.register(recoveryUrl, options);
  const recovered = await waitForWorker(registration.active ?? registration.waiting ?? registration.installing);
  if (!recovered || !await canaryWorker(recovered)) {
    await registration.unregister();
    throw new Error('Unable to install a healthy dashboard service worker.');
  }
  if (registration.waiting === recovered) recovered.postMessage({ type: 'ACTIVATE' });
  return { registration, worker: recovered };
}

/**
 * @param {string[]} dataUrls
 * @param {{
 *   serviceWorkers?: ServiceWorkerContainer,
 *   storage?: Storage,
 *   connection?: ConnectionState,
 *   getBattery?: () => Promise<BatteryState>,
 *   online?: () => boolean,
 *   scriptUrl?: URL,
 *   now?: () => number,
 *   setTimer?: typeof window.setTimeout,
 *   clearTimer?: typeof window.clearTimeout
 * }} [dependencies]
 */
export function startAutomaticDashboardDataUpdates(dataUrls, dependencies = {}) {
  const serviceWorkers = dependencies.serviceWorkers ?? navigator.serviceWorker;
  const storage = dependencies.storage ?? localStorage;
  const connection = dependencies.connection
    ?? /** @type {Navigator & { connection?: ConnectionState }} */ (navigator).connection;
  const getBattery = dependencies.getBattery
    ?? /** @type {Navigator & { getBattery?: () => Promise<BatteryState> }} */ (navigator).getBattery?.bind(navigator);
  const online = dependencies.online ?? (() => navigator.onLine);
  const scriptUrl = dependencies.scriptUrl ?? new URL('../service-worker.js', import.meta.url);
  const now = dependencies.now ?? Date.now;
  const setTimer = dependencies.setTimer ?? window.setTimeout.bind(window);
  const clearTimer = dependencies.clearTimer ?? window.clearTimeout.bind(window);
  let timer;
  let stopped = false;
  /** @type {BatteryState | undefined} */
  let battery;
  /** @type {ServiceWorkerRegistration | undefined} */
  let registration;

  const schedule = (delay) => {
    if (timer !== undefined) clearTimer(timer);
    timer = setTimer(() => void reconcile(), delay);
  };
  const reconcile = async () => {
    if (stopped) return;
    if (!automaticDashboardDataUpdatesEnabled(storage)) {
      if (registration) {
        await registration.unregister();
        registration = undefined;
      }
      return;
    }
    if (!online()) {
      schedule(RETRY_INTERVAL_MS);
      return;
    }
    if (!battery && getBattery) battery = await getBattery().catch(() => undefined);
    if (dashboardDataUpdateBlockedReason(connection, battery)) {
      schedule(RETRY_INTERVAL_MS);
      return;
    }
    try {
      const healthy = await ensureHealthyDashboardServiceWorker(serviceWorkers, scriptUrl);
      registration = healthy.registration;
      const lastSuccess = Number(storage.getItem(LAST_SUCCESS_STORAGE_KEY) ?? 0);
      const remaining = UPDATE_INTERVAL_MS - (now() - lastSuccess);
      if (lastSuccess > 0 && remaining > 0) {
        schedule(remaining);
        return;
      }
      const response = await requestWorker(
        healthy.worker,
        { type: 'DOWNLOAD_DATA', urls: dataUrls },
        DOWNLOAD_TIMEOUT_MS
      );
      if (!response || typeof response !== 'object'
          || /** @type {{ type?: unknown }} */ (response).type !== 'DOWNLOAD_COMPLETE') {
        throw new Error('Service worker data download failed.');
      }
      storage.setItem(LAST_SUCCESS_STORAGE_KEY, String(now()));
      schedule(UPDATE_INTERVAL_MS);
    } catch (error) {
      console.error(`Unable to update dashboard data automatically: ${error instanceof Error ? error.message : String(error)}`);
      schedule(RETRY_INTERVAL_MS);
    }
  };
  const onSettingChange = () => void reconcile();
  const onConstraintChange = () => void reconcile();
  window.addEventListener(SETTING_EVENT, onSettingChange);
  window.addEventListener('online', onConstraintChange);
  connection?.addEventListener?.('change', onConstraintChange);
  if (getBattery) {
    void getBattery().then((currentBattery) => {
      if (stopped) return;
      battery = currentBattery;
      battery.addEventListener?.('chargingchange', onConstraintChange);
      battery.addEventListener?.('levelchange', onConstraintChange);
      void reconcile();
    }).catch(() => {});
  }
  void reconcile();

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimer(timer);
    window.removeEventListener(SETTING_EVENT, onSettingChange);
    window.removeEventListener('online', onConstraintChange);
    connection?.removeEventListener?.('change', onConstraintChange);
    battery?.removeEventListener?.('chargingchange', onConstraintChange);
    battery?.removeEventListener?.('levelchange', onConstraintChange);
  };
}
