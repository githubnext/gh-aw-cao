import { readCollection, readIndex, readRecord } from '../storage/indexeddb.js';

/** @param {IDBFactory} indexedDB */
export function createCanonicalQueries(indexedDB) {
  return {
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
        const runs = await readCollection(indexedDB, 'runs');
        return runs
          .filter((run) => ['failure', 'startup-failure', 'stale', 'timed-out'].includes(String(run.conclusion)))
          .sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)));
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
        const events = await readIndex(indexedDB, 'events', 'bySessionSequence', [sessionId]);
        return events.filter((event) => event.type === type);
      }
    },
    workItems: {
      list: () => readCollection(indexedDB, 'workItems'),
      byLifecycleState: (/** @type {string} */ lifecycleState) =>
        readIndex(indexedDB, 'workItems', 'byLifecycleState', [lifecycleState])
    },
    findings: {
      list: () => readCollection(indexedDB, 'findings'),
      bySeverity: (/** @type {string} */ severity) =>
        readIndex(indexedDB, 'findings', 'bySeverity', [severity])
    }
  };
}