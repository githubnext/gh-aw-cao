import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/**
 * @param {string} search
 * @returns {Promise<{ output: { debug: import('vitest').Mock }, mod: typeof import('../../src/data/storage/quota.js') }>}
 */
async function loadQuotaWithDebug(search) {
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
  const mod = await import('../../src/data/storage/quota.js');
  return { output, mod };
}

describe('canonical storage quota debug logging', () => {
  it('does not log when the debug query is absent', async () => {
    const { output, mod } = await loadQuotaWithDebug('');
    const storage = /** @type {StorageManager} */ (/** @type {unknown} */ ({
      estimate: vi.fn().mockResolvedValue({ usage: 40, quota: 100 }),
      persist: vi.fn().mockResolvedValue(true)
    }));

    await mod.inspectStorage(storage);
    await mod.requestPersistentStorage(storage);
    await mod.withQuotaRecovery(
      vi.fn()
        .mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'))
        .mockResolvedValue('written'),
      vi.fn().mockResolvedValue(undefined)
    );

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs storage inspection under the predictable "quota" category when enabled', async () => {
    const { output, mod } = await loadQuotaWithDebug('?debug=quota');
    const storage = /** @type {StorageManager} */ (/** @type {unknown} */ ({
      estimate: vi.fn().mockResolvedValue({ usage: 40, quota: 100 })
    }));

    await mod.inspectStorage(storage);

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:quota]',
      { event: 'storage-inspected', usage: 40, quota: 100, available: 60 }
    );
  });

  it('logs persistence requests with a scalar result', async () => {
    const { output, mod } = await loadQuotaWithDebug('?debug=quota');
    const storage = /** @type {StorageManager} */ (/** @type {unknown} */ ({
      persist: vi.fn().mockResolvedValue(true)
    }));

    await mod.requestPersistentStorage(storage);

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:quota]',
      { event: 'persistence-requested', persisted: true }
    );
  });

  it('logs when quota recovery begins, without logging on the successful retry', async () => {
    const { output, mod } = await loadQuotaWithDebug('?debug=quota');
    const operation = vi.fn()
      .mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'))
      .mockResolvedValue('written');
    const reclaim = vi.fn().mockResolvedValue(undefined);

    await expect(mod.withQuotaRecovery(operation, reclaim)).resolves.toBe('written');

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:quota]',
      { event: 'quota-recovery-started' }
    );
    expect(output.debug).toHaveBeenCalledTimes(1);
  });

  it('never logs secrets or non-scalar values', async () => {
    const { output, mod } = await loadQuotaWithDebug('?debug=1');
    const storage = /** @type {StorageManager} */ (/** @type {unknown} */ ({
      estimate: vi.fn().mockResolvedValue({ usage: 10, quota: 20 }),
      persist: vi.fn().mockResolvedValue(false)
    }));

    await mod.inspectStorage(storage);
    await mod.requestPersistentStorage(storage);
    await mod.withQuotaRecovery(
      vi.fn()
        .mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'))
        .mockResolvedValue('written'),
      vi.fn().mockResolvedValue(undefined)
    );

    expect(output.debug.mock.calls.length).toBeGreaterThan(0);
    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(['string', 'number', 'boolean'].includes(typeof value)).toBe(true);
      }
    }
  });
});
