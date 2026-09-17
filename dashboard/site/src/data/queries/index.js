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
    jobs: {
      list: () => readCollection(indexedDB, 'jobs'),
      forRun: (/** @type {string} */ runId) =>
        readIndex(indexedDB, 'jobs', 'byRun', [runId])
    },
    sessions: {
      list: () => readCollection(indexedDB, 'sessions'),
      forRun: (/** @type {string} */ runId) =>
        readIndex(indexedDB, 'sessions', 'byRun', [runId]),
      forJob: (/** @type {string} */ jobId) =>
        readIndex(indexedDB, 'sessions', 'byJob', [jobId])
    },
    events: {
      list: () => readCollection(indexedDB, 'events'),
      forSession: (/** @type {string} */ sessionId) =>
        readIndex(indexedDB, 'events', 'bySessionSequence', [sessionId]),
      forSessionByType: async (/** @type {string} */ sessionId, /** @type {string} */ type) => {
        return queryCollection(indexedDB, 'events', [{
          op: 'filter',
          predicates: [
            { field: 'sessionId', equals: sessionId },
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