import { describe, expect, it, vi } from 'vitest';
import {
  inspectStorage,
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