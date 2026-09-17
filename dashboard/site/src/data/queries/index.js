import {
  queryCollection,
  readCollection,
  readIndex,
  readRecord,
  readTransactions
} from '../storage/indexeddb.js';

/** @param {IDBFactory} indexedDB */
export function createCanonicalQueries(indexedDB) {
  return {
    packages: {
      list: () => readCollection(indexedDB, 'packages'),
      getBySlug: async (/** @type {string} */ slug) =>
        (await readIndex(indexedDB, 'packages', 'bySlug', [slug]))[0] ?? null
    },
    repositories: {
      list: () => readCollection(indexedDB, 'repositories'),
      get: (/** @type {string} */ id) => readRecord(indexedDB, 'repositories', id)
    },
    workflows: {
      list: () => readCollection(indexedDB, 'workflows'),
      forRepository: (/** @type {string} */ repositoryId) =>
        readIndex(indexedDB, 'workflows', 'byRepository', [repositoryId])
    },
    runs: {
      list: () => readCollection(indexedDB, 'runs'),
      forRepository: (/** @type {string} */ repositoryId) =>
        readIndex(indexedDB, 'runs', 'byRepository', [repositoryId]),
      forWorkflow: (/** @type {string} */ workflowId) =>
        readIndex(indexedDB, 'runs', 'byWorkflow', [workflowId]),
      recentFailures: async () => {
        return queryCollection(indexedDB, 'runs', [
          {
            op: 'filter',
            predicates: [{
              field: 'conclusion',
              in: ['failure', 'startup-failure', 'stale', 'timed-out']
            }]
          },
          { op: 'arrange', by: [{ field: 'startedAt', direction: 'desc' }] }
        ]);
      }
    },
    events: {
      list: () => readCollection(indexedDB, 'events'),
      forRun: (/** @type {string} */ runId) =>
        readIndex(indexedDB, 'events', 'byRunSequence', [runId]),
      forRunByType: async (/** @type {string} */ runId, /** @type {string} */ type) => {
        return queryCollection(indexedDB, 'events', [{
          op: 'filter',
          predicates: [
            { field: 'runId', equals: runId },
            { field: 'type', equals: type }
          ]
        }, {
          op: 'arrange',
          by: [{ field: 'sequence', direction: 'asc' }]
        }]);
      }
    },
    transactions: {
      list: () => readTransactions(indexedDB)
    }
  };
}