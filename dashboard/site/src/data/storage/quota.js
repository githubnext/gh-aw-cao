import { createDebug } from '../../debug.js';

const debugQuota = createDebug('quota');

/** @param {StorageManager | undefined} storage */
export async function inspectStorage(storage) {
  if (!storage?.estimate) return { usage: null, quota: null, available: null };
  const estimate = await storage.estimate();
  const usage = Number.isFinite(estimate.usage) ? Number(estimate.usage) : null;
  const quota = Number.isFinite(estimate.quota) ? Number(estimate.quota) : null;
  const available = usage !== null && quota !== null ? Math.max(0, quota - usage) : null;
  debugQuota({ event: 'storage-inspected', usage, quota, available });
  return { usage, quota, available };
}

/** @param {StorageManager | undefined} storage */
export async function inspectDatabaseUsage(storage) {
  if (!storage?.estimate) return null;
  const estimate = await storage.estimate();
  const details = /** @type {StorageEstimate & { usageDetails?: { indexedDB?: number } }} */ (estimate).usageDetails;
  return Number.isFinite(details?.indexedDB) ? Number(details?.indexedDB) : null;
}

/** @param {StorageManager | undefined} storage */
export async function requestPersistentStorage(storage) {
  if (!storage?.persist) return false;
  const persisted = await storage.persist();
  debugQuota({ event: 'persistence-requested', persisted });
  return persisted;
}

/**
 * Retries one failed write after reclaiming expendable derived state.
 *
 * @template T
 * @param {() => Promise<T>} operation
 * @param {() => Promise<unknown>} reclaim
 * @returns {Promise<T>}
 */
export async function withQuotaRecovery(operation, reclaim) {
  try {
    return await operation();
  } catch (error) {
    if (typeof error !== 'object'
      || error === null
      || /** @type {{ name?: unknown }} */ (error).name !== 'QuotaExceededError') throw error;
    debugQuota({ event: 'quota-recovery-started' });
    await reclaim();
    return operation();
  }
}
export const MAX_DASHBOARD_DATABASE_BYTES = 2 * 1024 * 1024 * 1024;
