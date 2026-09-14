import { describe, expect, it, vi } from 'vitest';
import {
  inspectStorage,
  inspectDatabaseUsage,
  MAX_DASHBOARD_DATABASE_BYTES,
  requestPersistentStorage,
  withQuotaRecovery
} from '../../src/data/storage/quota.js';

describe('canonical storage quota recovery', () => {
  it('reports storage capacity and requests persistence when supported', async () => {
    const storage = /** @type {StorageManager} */ (/** @type {unknown} */ ({
      estimate: vi.fn().mockResolvedValue({ usage: 40, quota: 100 }),
      persist: vi.fn().mockResolvedValue(true)
    }));

    await expect(inspectStorage(storage)).resolves.toEqual({ usage: 40, quota: 100, available: 60 });
    await expect(requestPersistentStorage(storage)).resolves.toBe(true);
  });

  it('caps dashboard IndexedDB storage at 2 GB', async () => {
    const storage = /** @type {StorageManager} */ (/** @type {unknown} */ ({
      estimate: vi.fn().mockResolvedValue({
        usage: MAX_DASHBOARD_DATABASE_BYTES + 100,
        quota: MAX_DASHBOARD_DATABASE_BYTES * 2,
        usageDetails: { indexedDB: MAX_DASHBOARD_DATABASE_BYTES }
      })
    }));

    expect(MAX_DASHBOARD_DATABASE_BYTES).toBe(2 * 1024 * 1024 * 1024);
    await expect(inspectDatabaseUsage(storage)).resolves.toBe(MAX_DASHBOARD_DATABASE_BYTES);
  });

  it('retries once after quota recovery', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'))
      .mockResolvedValue('written');
    const reclaim = vi.fn().mockResolvedValue(undefined);

    await expect(withQuotaRecovery(operation, reclaim)).resolves.toBe('written');
    expect(reclaim).toHaveBeenCalledOnce();
    expect(operation).toHaveBeenCalledTimes(2);
  });
});