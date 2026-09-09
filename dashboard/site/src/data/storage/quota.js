import { deleteGeneration, listGenerationStates } from './indexeddb.js'

/** @param {StorageManager | undefined} storage */
export async function inspectStorage(storage) {
  if (!storage?.estimate) return { usage: null, quota: null, available: null }
  const estimate = await storage.estimate()
  const usage = Number.isFinite(estimate.usage) ? Number(estimate.usage) : null
  const quota = Number.isFinite(estimate.quota) ? Number(estimate.quota) : null
  return {
    usage,
    quota,
    available:
      usage !== null && quota !== null ? Math.max(0, quota - usage) : null,
  }
}

/** @param {StorageManager | undefined} storage */
export async function requestPersistentStorage(storage) {
  return storage?.persist ? storage.persist() : false
}

/** @param {IDBFactory} indexedDB */
export async function reclaimExpendableGenerations(indexedDB) {
  const states = await listGenerationStates(indexedDB)
  const deleted = []
  for (const state of ['failed', 'retired']) {
    for (const item of states.filter(
      (candidate) => candidate.state === state,
    )) {
      await deleteGeneration(indexedDB, item.generation)
      deleted.push(item.generation)
    }
  }
  return deleted
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
    return await operation()
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== 'QuotaExceededError')
      throw error
    await reclaim()
    return operation()
  }
}
