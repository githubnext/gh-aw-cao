import {
  readActiveCollection,
  readActiveIndex,
  readActiveRecord,
} from '../storage/indexeddb.js'

/** @param {IDBFactory} indexedDB */
export function createCanonicalQueries(indexedDB) {
  return {
    repositories: {
      list: () => readActiveCollection(indexedDB, 'repositories'),
      get: (/** @type {string} */ id) =>
        readActiveRecord(indexedDB, 'repositories', id),
    },
    workflows: {
      list: () => readActiveCollection(indexedDB, 'workflows'),
      forRepository: (/** @type {string} */ repositoryId) =>
        readActiveIndex(indexedDB, 'workflows', 'byRepository', [repositoryId]),
    },
    runs: {
      list: () => readActiveCollection(indexedDB, 'runs'),
      forRepository: (/** @type {string} */ repositoryId) =>
        readActiveIndex(indexedDB, 'runs', 'byRepository', [repositoryId]),
      forWorkflow: (/** @type {string} */ workflowId) =>
        readActiveIndex(indexedDB, 'runs', 'byWorkflow', [workflowId]),
      recentFailures: async () => {
        const runs = await readActiveCollection(indexedDB, 'runs')
        return runs
          .filter((run) =>
            ['failure', 'startup-failure', 'stale', 'timed-out'].includes(
              String(run.conclusion),
            ),
          )
          .sort((left, right) =>
            String(right.startedAt).localeCompare(String(left.startedAt)),
          )
      },
    },
    jobs: {
      list: () => readActiveCollection(indexedDB, 'jobs'),
      forRun: (/** @type {string} */ runId) =>
        readActiveIndex(indexedDB, 'jobs', 'byRun', [runId]),
    },
    sessions: {
      forRun: (/** @type {string} */ runId) =>
        readActiveIndex(indexedDB, 'sessions', 'byRun', [runId]),
      forJob: (/** @type {string} */ jobId) =>
        readActiveIndex(indexedDB, 'sessions', 'byJob', [jobId]),
    },
    events: {
      forSession: (/** @type {string} */ sessionId) =>
        readActiveIndex(indexedDB, 'events', 'bySessionSequence', [sessionId]),
      forSessionByType: async (
        /** @type {string} */ sessionId,
        /** @type {string} */ type,
      ) => {
        const events = await readActiveIndex(
          indexedDB,
          'events',
          'bySessionSequence',
          [sessionId],
        )
        return events.filter((event) => event.type === type)
      },
    },
    workItems: {
      list: () => readActiveCollection(indexedDB, 'workItems'),
      byLifecycleState: (/** @type {string} */ lifecycleState) =>
        readActiveIndex(indexedDB, 'workItems', 'byLifecycleState', [
          lifecycleState,
        ]),
    },
    findings: {
      list: () => readActiveCollection(indexedDB, 'findings'),
      bySeverity: (/** @type {string} */ severity) =>
        readActiveIndex(indexedDB, 'findings', 'bySeverity', [severity]),
    },
  }
}
