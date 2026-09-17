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
    domains: runLinkedQueries(indexedDB, 'domains'),
    tools: runLinkedQueries(indexedDB, 'tools'),
    audits: runLinkedQueries(indexedDB, 'audits'),
    issues: runLinkedQueries(indexedDB, 'issues'),
    transactions: {
      list: () => readTransactions(indexedDB)
    }
  };
}

/** @param {IDBFactory} indexedDB @param {'domains' | 'tools' | 'audits' | 'issues'} collection */
function runLinkedQueries(indexedDB, collection) {
  return {
    list: () => readCollection(indexedDB, collection),
    forRun: async (/** @type {string} */ runId) => (
      await readIndex(indexedDB, collection, 'byRun', [runId])
    ).sort((left, right) => Number(left.sequence) - Number(right.sequence))
  };
}