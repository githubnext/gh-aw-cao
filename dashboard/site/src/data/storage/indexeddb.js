import { CANONICAL_SCHEMA_VERSION, relationshipErrors } from '../model/schema.js'

export const DATABASE_NAME = 'gh-aw-cao-dashboard-data'
export const DATABASE_VERSION = 4

const ENTITY_STORES = /** @type {const} */ (['repositories', 'workflows', 'runs', 'jobs', 'sessions', 'events', 'workItems', 'findings'])
const GENERATION_STORES = ENTITY_STORES
const META_STORE = 'meta'
const ACTIVE_GENERATION_KEY = 'activeGeneration'
const CHECKPOINT_STORE = 'ingestionCheckpoints'
const DEFAULT_WRITE_BATCH_SIZE = 1000

/**
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

/** @param {IDBTransaction} transaction */
function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve(undefined)
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
  })
}

/**
 * @param {IDBObjectStore} store
 * @param {string} name
 * @param {string | string[]} keyPath
 */
function createIndex(store, name, keyPath) {
  store.createIndex(name, keyPath)
}

/** @param {IDBDatabase} database */
function createSchema(database) {
  database.createObjectStore(META_STORE, { keyPath: 'key' })

  const repositories = database.createObjectStore('repositories', {
    keyPath: ['generation', 'id'],
  })
  createIndex(repositories, 'generation', 'generation')
  createIndex(repositories, 'byGithubId', ['generation', 'githubId'])
  createIndex(repositories, 'byFullName', ['generation', 'fullName'])

  const workflows = database.createObjectStore('workflows', {
    keyPath: ['generation', 'id'],
  })
  createIndex(workflows, 'generation', 'generation')
  createIndex(workflows, 'byRepository', ['generation', 'repositoryId'])
  createIndex(workflows, 'byRepositoryPath', ['generation', 'repositoryId', 'path'])

  const runs = database.createObjectStore('runs', {
    keyPath: ['generation', 'id'],
  })
  createIndex(runs, 'generation', 'generation')
  createIndex(runs, 'byRepository', ['generation', 'repositoryId'])
  createIndex(runs, 'byWorkflow', ['generation', 'workflowId'])
  createIndex(runs, 'byStatus', ['generation', 'status'])
  createIndex(runs, 'byRepositoryStartedAt', ['generation', 'repositoryId', 'startedAt'])
  createIndex(runs, 'byWorkflowStartedAt', ['generation', 'workflowId', 'startedAt'])

  const jobs = database.createObjectStore('jobs', {
    keyPath: ['generation', 'id'],
  })
  createIndex(jobs, 'generation', 'generation')
  createIndex(jobs, 'byRun', ['generation', 'runId'])
  createIndex(jobs, 'byRunStartedAt', ['generation', 'runId', 'startedAt'])

  const sessions = database.createObjectStore('sessions', {
    keyPath: ['generation', 'id'],
  })
  createIndex(sessions, 'generation', 'generation')
  createIndex(sessions, 'byRun', ['generation', 'runId'])
  createIndex(sessions, 'byJob', ['generation', 'jobId'])
  createIndex(sessions, 'byRunStartedAt', ['generation', 'runId', 'startedAt'])
  createIndex(sessions, 'byJobStartedAt', ['generation', 'jobId', 'startedAt'])

  const events = database.createObjectStore('events', {
    keyPath: ['generation', 'id'],
  })
  createIndex(events, 'generation', 'generation')
  createIndex(events, 'bySessionSequence', ['generation', 'sessionId', 'sequence'])
  createIndex(events, 'bySessionTimestamp', ['generation', 'sessionId', 'timestamp'])
  createIndex(events, 'byType', ['generation', 'type'])
  createIndex(events, 'bySource', ['generation', 'source'])
  createIndex(events, 'byCorrelation', ['generation', 'correlationId'])

  createOperationalEntityStores(database)

  const checkpoints = database.createObjectStore('ingestionCheckpoints', {
    keyPath: ['generation', 'chunk'],
  })
  createIndex(checkpoints, 'generation', 'generation')
}

/** @param {IDBDatabase} database */
function createOperationalEntityStores(database) {
  if (!database.objectStoreNames.contains('workItems')) {
    const workItems = database.createObjectStore('workItems', {
      keyPath: ['generation', 'id'],
    })
    createIndex(workItems, 'generation', 'generation')
    createIndex(workItems, 'byLifecycleState', ['generation', 'lifecycleState'])
  }
  if (!database.objectStoreNames.contains('findings')) {
    const findings = database.createObjectStore('findings', {
      keyPath: ['generation', 'id'],
    })
    createIndex(findings, 'generation', 'generation')
    createIndex(findings, 'bySeverity', ['generation', 'severity'])
  }
}

/** @param {IDBDatabase} database */
function deleteLegacySourceStores(database) {
  for (const storeName of ['sourceMetadata', 'sourceRecords']) {
    if (database.objectStoreNames.contains(storeName)) database.deleteObjectStore(storeName)
  }
}

/**
 * @param {IDBFactory} indexedDB
 * @returns {Promise<IDBDatabase>}
 */
export function openCanonicalDatabase(indexedDB) {
  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
  return new Promise((resolve, reject) => {
    request.onupgradeneeded = (event) => {
      if (event.oldVersion < 1) createSchema(request.result)
      if (event.oldVersion < 3) deleteLegacySourceStores(request.result)
      if (event.oldVersion >= 1 && event.oldVersion < 4) createOperationalEntityStores(request.result)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Unable to open canonical dashboard data'))
    request.onblocked = () => reject(new Error('Opening canonical dashboard data was blocked'))
  })
}

/**
 * @param {IDBDatabase} database
 * @param {string} key
 */
async function readMeta(database, key) {
  const transaction = database.transaction(META_STORE)
  const result = await requestResult(transaction.objectStore(META_STORE).get(key))
  return result && typeof result === 'object'
    ? /** @type {{ key: string, value?: unknown, state?: unknown, canonicalSchemaVersion?: unknown }} */ (result)
    : null
}

/**
 * @param {IDBDatabase} database
 * @param {Record<string, unknown>} value
 */
async function writeMeta(database, value) {
  const transaction = database.transaction(META_STORE, 'readwrite')
  transaction.objectStore(META_STORE).put(value)
  await transactionDone(transaction)
}

/**
 * @param {IDBDatabase} database
 * @param {string} generation
 * @param {string} chunk
 */
async function readStoredCheckpoint(database, generation, chunk) {
  const transaction = database.transaction(CHECKPOINT_STORE)
  const result = await requestResult(transaction.objectStore(CHECKPOINT_STORE).get([generation, chunk]))
  return result && typeof result === 'object' ? /** @type {Record<string, unknown>} */ (result) : null
}

/**
 * @param {IDBFactory} indexedDB
 * @param {import('../model/schema.js').CanonicalBatch} batch
 * @param {string} generation
 * @param {{ batchSize?: number, onBatchCommitted?: (progress: { committedBatches: number, committedRecords: number }) => void | Promise<void> }} [options]
 */
export async function stageCanonicalBatch(indexedDB, batch, generation, options = {}) {
  const database = await openCanonicalDatabase(indexedDB)
  try {
    const metaTransaction = database.transaction(META_STORE, 'readwrite')
    metaTransaction.objectStore(META_STORE).put({
      key: `generation:${generation}`,
      state: 'staging',
    })
    await transactionDone(metaTransaction)

    const batchSize = options.batchSize ?? DEFAULT_WRITE_BATCH_SIZE
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new TypeError('Write batch size must be a positive integer')
    }
    let committedRecords = 0
    let committedBatches = 0
    for (const storeName of GENERATION_STORES) {
      const records = batch[storeName]
      for (let offset = 0; offset < records.length; offset += batchSize) {
        const boundedRecords = records.slice(offset, offset + batchSize)
        const invalid = boundedRecords.find((record) => record.generation !== generation)
        if (invalid) {
          throw new Error(`${storeName} record does not belong to generation ${generation}`)
        }
        const transaction = database.transaction(storeName, 'readwrite')
        for (const record of boundedRecords) transaction.objectStore(storeName).put(record)
        await transactionDone(transaction)
        committedRecords += boundedRecords.length
        committedBatches += 1
        await options.onBatchCommitted?.({ committedBatches, committedRecords })
      }
    }

    const checkpointTransaction = database.transaction(CHECKPOINT_STORE, 'readwrite')
    checkpointTransaction.objectStore(CHECKPOINT_STORE).put({
      generation,
      chunk: 'dashboard-sources',
      digest: generation,
      status: 'committed',
      recordCount: committedRecords,
      committedAt: new Date().toISOString(),
    })
    await transactionDone(checkpointTransaction)
  } finally {
    database.close()
  }
}

/**
 * @param {IDBFactory} indexedDB
 * @param {string} generation
 * @param {string} [chunk]
 */
export async function readCheckpoint(indexedDB, generation, chunk = 'dashboard-sources') {
  const database = await openCanonicalDatabase(indexedDB)
  try {
    return await readStoredCheckpoint(database, generation, chunk)
  } finally {
    database.close()
  }
}

/**
 * @param {IDBFactory} indexedDB
 * @param {string} generation
 */
export async function generationState(indexedDB, generation) {
  const database = await openCanonicalDatabase(indexedDB)
  try {
    const metadata = await readMeta(database, `generation:${generation}`)
    return typeof metadata?.state === 'string' ? metadata.state : null
  } finally {
    database.close()
  }
}

/** @param {IDBRequest<IDBCursor | null>} request @param {IDBObjectStore} store */
function deleteCursorRecords(request, store) {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error('Unable to delete generation records'))
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) {
        resolve(undefined)
        return
      }
      store.delete(cursor.primaryKey)
      cursor.continue()
    }
  })
}

/** @param {IDBFactory} indexedDB */
export async function listGenerationStates(indexedDB) {
  const database = await openCanonicalDatabase(indexedDB)
  try {
    const transaction = database.transaction(META_STORE)
    const records = await requestResult(transaction.objectStore(META_STORE).getAll())
    return records
      .filter((record) => typeof record?.key === 'string' && record.key.startsWith('generation:'))
      .map((record) => ({
        generation: record.key.slice('generation:'.length),
        state: typeof record.state === 'string' ? record.state : 'unknown',
      }))
  } finally {
    database.close()
  }
}

/**
 * @param {IDBFactory} indexedDB
 * @param {string} generation
 */
export async function deleteGeneration(indexedDB, generation) {
  const database = await openCanonicalDatabase(indexedDB)
  try {
    const active = await readMeta(database, ACTIVE_GENERATION_KEY)
    if (active?.value === generation) {
      throw new Error(`Cannot delete active generation ${generation}`)
    }
    const transaction = database.transaction([META_STORE, CHECKPOINT_STORE, ...GENERATION_STORES], 'readwrite')
    const done = transactionDone(transaction)
    const deletions = GENERATION_STORES.map((storeName) => {
      const store = transaction.objectStore(storeName)
      return deleteCursorRecords(store.index('generation').openKeyCursor(generation), store)
    })
    const checkpoints = transaction.objectStore(CHECKPOINT_STORE)
    deletions.push(deleteCursorRecords(checkpoints.index('generation').openKeyCursor(generation), checkpoints))
    transaction.objectStore(META_STORE).delete(`generation:${generation}`)
    await Promise.all(deletions)
    await done
  } finally {
    database.close()
  }
}

/**
 * @param {IDBDatabase} database
 * @param {string} generation
 * @returns {Promise<import('../model/schema.js').CanonicalBatch>}
 */
async function readGeneration(database, generation) {
  const transaction = database.transaction(ENTITY_STORES)
  const records = await Promise.all(ENTITY_STORES.map((storeName) => requestResult(transaction.objectStore(storeName).index('generation').getAll(generation))))
  return /** @type {import('../model/schema.js').CanonicalBatch} */ (Object.fromEntries(ENTITY_STORES.map((storeName, index) => [storeName, records[index]])))
}

/**
 * @param {IDBFactory} indexedDB
 * @param {string} generation
 */
export async function activateGeneration(indexedDB, generation) {
  const database = await openCanonicalDatabase(indexedDB)
  let validating = false
  try {
    const generationMeta = await readMeta(database, `generation:${generation}`)
    if (generationMeta?.state !== 'staging') {
      throw new Error(`Generation ${generation} is not staging`)
    }
    const checkpoint = await readStoredCheckpoint(database, generation, 'dashboard-sources')
    if (checkpoint?.status !== 'committed' || checkpoint.digest !== generation) {
      throw new Error(`Generation ${generation} is incomplete`)
    }
    await writeMeta(database, {
      key: `generation:${generation}`,
      state: 'validating',
    })
    validating = true
    const errors = relationshipErrors(await readGeneration(database, generation))
    if (errors.length > 0) {
      throw new Error(`Generation relationship validation failed: ${errors.join('; ')}`)
    }

    const previousActive = await readMeta(database, ACTIVE_GENERATION_KEY)
    const transaction = database.transaction(META_STORE, 'readwrite')
    const store = transaction.objectStore(META_STORE)
    if (typeof previousActive?.value === 'string' && previousActive.value !== generation) {
      store.put({ key: `generation:${previousActive.value}`, state: 'retired' })
    }
    store.put({ key: `generation:${generation}`, state: 'complete' })
    store.put({
      key: ACTIVE_GENERATION_KEY,
      value: generation,
      canonicalSchemaVersion: CANONICAL_SCHEMA_VERSION,
    })
    await transactionDone(transaction)
  } catch (error) {
    if (validating) {
      await writeMeta(database, {
        key: `generation:${generation}`,
        state: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      })
    }
    throw error
  } finally {
    database.close()
  }
}

/** @param {IDBFactory} indexedDB */
export async function activeGeneration(indexedDB) {
  const database = await openCanonicalDatabase(indexedDB)
  try {
    const active = await readMeta(database, ACTIVE_GENERATION_KEY)
    return typeof active?.value === 'string' ? active.value : null
  } finally {
    database.close()
  }
}

/** @param {IDBFactory} indexedDB */
export async function activeGenerationMetadata(indexedDB) {
  const database = await openCanonicalDatabase(indexedDB)
  try {
    const active = await readMeta(database, ACTIVE_GENERATION_KEY)
    return typeof active?.value === 'string'
      ? {
          generation: active.value,
          canonicalSchemaVersion: Number(active.canonicalSchemaVersion) || null,
        }
      : null
  } finally {
    database.close()
  }
}

/**
 * Verifies active-generation metadata and bounded store counts without loading
 * the generation into memory.
 * @param {IDBFactory} indexedDB
 * @param {string} expectedGeneration
 */
export async function activeGenerationIsUsable(indexedDB, expectedGeneration) {
  const database = await openCanonicalDatabase(indexedDB)
  try {
    const active = await readMeta(database, ACTIVE_GENERATION_KEY)
    if (active?.value !== expectedGeneration || Number(active.canonicalSchemaVersion) !== CANONICAL_SCHEMA_VERSION) return false
    const generation = await readMeta(database, `generation:${expectedGeneration}`)
    const checkpoint = await readStoredCheckpoint(database, expectedGeneration, 'dashboard-sources')
    if (generation?.state !== 'complete' || checkpoint?.status !== 'committed' || checkpoint.digest !== expectedGeneration) return false

    const transaction = database.transaction(GENERATION_STORES)
    const counts = await Promise.all(
      GENERATION_STORES.map((storeName) => requestResult(transaction.objectStore(storeName).index('generation').count(expectedGeneration))),
    )
    return counts.reduce((total, count) => total + count, 0) === Number(checkpoint.recordCount)
  } finally {
    database.close()
  }
}

/**
 * @param {IDBFactory} indexedDB
 * @param {typeof ENTITY_STORES[number]} storeName
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function readActiveCollection(indexedDB, storeName) {
  const database = await openCanonicalDatabase(indexedDB)
  try {
    const active = await readMeta(database, ACTIVE_GENERATION_KEY)
    if (typeof active?.value !== 'string') return []
    const transaction = database.transaction(storeName)
    return await requestResult(transaction.objectStore(storeName).index('generation').getAll(active.value))
  } finally {
    database.close()
  }
}

/**
 * @param {IDBFactory} indexedDB
 * @param {typeof ENTITY_STORES[number]} storeName
 * @param {string} id
 */
export async function readActiveRecord(indexedDB, storeName, id) {
  const database = await openCanonicalDatabase(indexedDB)
  try {
    const active = await readMeta(database, ACTIVE_GENERATION_KEY)
    if (typeof active?.value !== 'string') return null
    const transaction = database.transaction(storeName)
    const result = await requestResult(transaction.objectStore(storeName).get([active.value, id]))
    return result && typeof result === 'object' ? result : null
  } finally {
    database.close()
  }
}

/**
 * @param {IDBFactory} indexedDB
 * @param {typeof ENTITY_STORES[number]} storeName
 * @param {string} indexName
 * @param {(string | number)[]} key
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function readActiveIndex(indexedDB, storeName, indexName, key) {
  const database = await openCanonicalDatabase(indexedDB)
  try {
    const active = await readMeta(database, ACTIVE_GENERATION_KEY)
    if (typeof active?.value !== 'string') return []
    const transaction = database.transaction(storeName)
    const prefix = [active.value, ...key]
    return await requestResult(
      transaction
        .objectStore(storeName)
        .index(indexName)
        .getAll(IDBKeyRange.bound(prefix, [...prefix, []], false, true)),
    )
  } finally {
    database.close()
  }
}
