import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { activateGeneration, DATABASE_NAME, generationState, stageCanonicalBatch } from '../../src/data/storage/indexeddb.js'
import { inspectStorage, reclaimExpendableGenerations, requestPersistentStorage, withQuotaRecovery } from '../../src/data/storage/quota.js'
import { normalize } from '../../src/data/normalize/index.js'

/** @param {string} generation */
const batch = (generation) => normalize([], { generation })

beforeEach(async () => {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME)
    request.onsuccess = () => resolve(undefined)
    request.onerror = () => reject(request.error)
  })
})

describe('canonical storage quota recovery', () => {
  it('reports storage capacity and requests persistence when supported', async () => {
    const storage = /** @type {StorageManager} */ (
      /** @type {unknown} */ ({
        estimate: vi.fn().mockResolvedValue({ usage: 40, quota: 100 }),
        persist: vi.fn().mockResolvedValue(true),
      })
    )

    await expect(inspectStorage(storage)).resolves.toEqual({
      usage: 40,
      quota: 100,
      available: 60,
    })
    await expect(requestPersistentStorage(storage)).resolves.toBe(true)
  })

  it('reclaims failed generations before retired generations and preserves active data', async () => {
    await stageCanonicalBatch(indexedDB, batch('generation-a'), 'generation-a')
    await activateGeneration(indexedDB, 'generation-a')
    await stageCanonicalBatch(indexedDB, batch('generation-b'), 'generation-b')
    await activateGeneration(indexedDB, 'generation-b')
    await stageCanonicalBatch(indexedDB, batch('generation-failed'), 'generation-failed')
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const transaction = database.transaction('meta', 'readwrite')
    transaction.objectStore('meta').put({ key: 'generation:generation-failed', state: 'failed' })
    await new Promise((resolve) => {
      transaction.oncomplete = resolve
    })
    database.close()

    await expect(reclaimExpendableGenerations(indexedDB)).resolves.toEqual(['generation-failed', 'generation-a'])
    expect(await generationState(indexedDB, 'generation-a')).toBeNull()
    expect(await generationState(indexedDB, 'generation-b')).toBe('complete')
  })

  it('retries once after quota recovery', async () => {
    const operation = vi.fn().mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError')).mockResolvedValue('written')
    const reclaim = vi.fn().mockResolvedValue(undefined)

    await expect(withQuotaRecovery(operation, reclaim)).resolves.toBe('written')
    expect(reclaim).toHaveBeenCalledOnce()
    expect(operation).toHaveBeenCalledTimes(2)
  })
})
