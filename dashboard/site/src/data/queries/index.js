import { countIndex, readCollection, readIndex, readIndexDescending, readRecord, readTransactions } from '../storage/indexeddb.js';

/** @param {IDBFactory} indexedDB */
export function createCanonicalQueries(indexedDB) {
  const recentFailuresPage = async (limit = Number.MAX_SAFE_INTEGER) => {
    const conclusions = ['failure', 'startup-failure', 'stale', 'timed-out'];
    const boundedLimit = limit;
    const [runsByConclusion, counts] = await Promise.all([
      Promise.all(conclusions.map((conclusion) =>
        readIndexDescending(indexedDB, 'runs', 'byConclusionStartedAt', [conclusion], boundedLimit)
      )),
      Promise.all(conclusions.map((conclusion) =>
        countIndex(indexedDB, 'runs', 'byConclusionStartedAt', [conclusion])
      ))
    ]);
    const rows = runsByConclusion.flat()
      .sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt))
        || String(right.id).localeCompare(String(left.id)))
      .slice(0, boundedLimit);
    return { rows, total: counts.reduce((sum, count) => sum + count, 0) };
  };
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
      recentFailures: async () => (await recentFailuresPage()).rows,
      recentFailuresPage
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
    transactions: {
      list: () => readTransactions(indexedDB)
    }
  };
}