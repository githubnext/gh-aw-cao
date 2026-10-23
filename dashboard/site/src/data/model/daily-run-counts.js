export const DAILY_RUN_COUNT_STORES = /** @type {const} */ ([
  'dailyRunCounts', 'runCountContributions', 'dailyRunCountState'
]);
export const DAILY_RUN_COUNT_STATE_ID = 'daily-run-counts';
export const RUN_COUNT_FIELDS = /** @type {const} */ ([
  'total', 'successful', 'failed', 'approval', 'pending', 'other'
]);
const COMPACT_FIELDS = [
  'id', 'repositoryId', 'workflowId', 'owner', 'repository', 'workflowPath',
  'startedAt', 'status', 'conclusion', 'attempt', 'updatedAt', 'completedAt'
];

/** @param {Record<string, unknown>} run */
export function compactRunCountRecord(run) {
  return Object.fromEntries(COMPACT_FIELDS.filter((field) => run[field] !== undefined)
    .map((field) => [field, run[field]]));
}

/** @param {unknown} value */
function timestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
}

/**
 * Receipts retain only count-relevant run facts, not run detail or telemetry.
 * Explicit attempt and update/end timestamps fence stale replay after eviction.
 * @param {Record<string, unknown> | undefined} previous
 * @param {Record<string, unknown>} incoming
 */
export function reconcileRunCountRecord(previous, incoming) {
  const next = compactRunCountRecord(incoming);
  if (!previous) return { run: next, conflict: false };
  const before = compactRunCountRecord(previous);
  let merged = { ...before, ...next };
  const attemptDelta = Number(merged.attempt ?? 1) - Number(before.attempt ?? 1);
  const oldTime = Math.max(timestamp(before.updatedAt), timestamp(before.completedAt));
  const newTime = Math.max(timestamp(next.updatedAt), timestamp(next.completedAt));
  if (attemptDelta < 0 || (attemptDelta === 0 && newTime > 0 && oldTime > newTime)) {
    return { run: before, conflict: false };
  }
  if (attemptDelta > 0) {
    for (const field of ['startedAt', 'status', 'conclusion', 'updatedAt', 'completedAt']) {
      if (!Object.hasOwn(next, field)) delete merged[field];
    }
  }
  if (attemptDelta === 0 && oldTime > 0 && newTime === 0) {
    merged = { ...next, ...before };
  }
  const different = JSON.stringify(COMPACT_FIELDS.map((field) => before[field] ?? null))
    !== JSON.stringify(COMPACT_FIELDS.map((field) => merged[field] ?? null));
  const conflict = attemptDelta === 0 && oldTime > 0 && oldTime === newTime && different;
  if (conflict) {
    const key = (/** @type {Record<string, unknown>} */ value) =>
      JSON.stringify(COMPACT_FIELDS.map((field) => value[field] ?? null));
    const rank = (/** @type {Record<string, unknown>} */ value) =>
      Number(value.status === 'completed' || ['success', 'failure', 'startup-failure', 'stale',
        'timed-out', 'action-required'].includes(String(value.conclusion)));
    return { run: rank(before) !== rank(merged)
      ? rank(before) > rank(merged) ? before : merged
      : key(before) > key(merged) ? before : merged, conflict: true };
  }
  return { run: merged, conflict: false };
}

/** @param {Record<string, unknown>} run */
export function dailyRunCountContribution(run) {
  const startedAt = typeof run.startedAt === 'string' ? run.startedAt : '';
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(startedAt)
      || !Number.isFinite(Date.parse(startedAt))) return null;
  if (![run.repositoryId, run.workflowId, run.owner, run.repository, run.workflowPath]
    .every((value) => typeof value === 'string' && value.length > 0)) return null;
  const day = new Date(startedAt).toISOString().slice(0, 10);
  const conclusion = run.conclusion;
  const status = String(run.status ?? '');
  const category = conclusion === 'success' ? 'successful'
    : ['failure', 'startup-failure', 'stale', 'timed-out'].includes(String(conclusion)) ? 'failed'
    : conclusion === 'action-required' ? 'approval'
    : status !== '' && status !== 'completed' ? 'pending' : 'other';
  return {
    id: JSON.stringify([day, run.repositoryId, run.workflowId]),
    day, repositoryId: run.repositoryId, workflowId: run.workflowId,
    owner: run.owner, repository: run.repository, workflowPath: run.workflowPath,
    ...Object.fromEntries(RUN_COUNT_FIELDS.map((field) => [field, Number(field === 'total' || field === category)]))
  };
}

/** @template T @param {IDBRequest<T>} request @returns {Promise<T>} */
function result(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Daily run count storage failed'));
  });
}

/** @param {Record<string, unknown> | undefined | null} record */
function storedBytes(record) {
  return record ? new TextEncoder().encode(JSON.stringify(record)).byteLength + 512 : 0;
}

/** @param {Record<string, unknown> | undefined} state */
export function protectedRunCountBytes(state) {
  return Number(state?.receiptBytes ?? 0) + Number(state?.dailyBytes ?? 0) + storedBytes(state);
}

/** @param {IDBDatabase} database */
export async function readProtectedRunCountBytes(database) {
  return protectedRunCountBytes(await result(database.transaction('dailyRunCountState')
    .objectStore('dailyRunCountState').get(DAILY_RUN_COUNT_STATE_ID)));
}

/**
 * Called inside the canonical run write transaction, after its canonical merge.
 * Detail deletion deliberately does not call this function.
 * @param {IDBTransaction} transaction
 * @param {Record<string, unknown>} record
 * @param {boolean} [batchConflict]
 */
export async function reconcileDailyRunCounts(transaction, record, batchConflict = false) {
  const receipts = transaction.objectStore('runCountContributions');
  const daily = transaction.objectStore('dailyRunCounts');
  const states = transaction.objectStore('dailyRunCountState');
  const previous = await result(receipts.get(/** @type {IDBValidKey} */ (record.id)));
  const reconciled = reconcileRunCountRecord(previous?.run, record);
  const run = reconciled.run;
  const contribution = dailyRunCountContribution(run);
  const conflict = Boolean(batchConflict || reconciled.conflict || (previous?.conflict
    && run.attempt === previous.run.attempt
    && run.updatedAt === previous.run.updatedAt && run.completedAt === previous.run.completedAt));
  const changes = JSON.stringify(previous?.contribution ?? null) === JSON.stringify(contribution)
    ? [] : [[previous?.contribution, -1], [contribution, 1]];
  let dailyBytesDelta = 0;
  let dailyCountDelta = 0;
  for (const [value, sign] of changes) {
    if (!value) continue;
    const current = await result(daily.get(value.id));
    const next = { ...value };
    for (const field of RUN_COUNT_FIELDS) {
      next[field] = Number(current?.[field] ?? 0) + Number(sign) * Number(value[field]);
      if (!Number.isSafeInteger(next[field]) || next[field] < 0) throw new Error('Invalid daily run count delta');
    }
    if (next.total === 0) daily.delete(next.id);
    else daily.put(next);
    dailyBytesDelta += storedBytes(next.total === 0 ? null : next) - storedBytes(current);
    dailyCountDelta += Number(next.total !== 0) - Number(Boolean(current));
  }
  const receipt = { id: record.id, run, contribution, conflict };
  receipts.put(receipt);
  const state = await result(states.get(DAILY_RUN_COUNT_STATE_ID));
  if (state) {
    state.excludedRuns = Number(state.excludedRuns ?? 0) + Number(!contribution) - Number(Boolean(previous && !previous.contribution));
    state.conflictedRuns = Number(state.conflictedRuns ?? 0) + Number(conflict) - Number(previous?.conflict ?? false);
    state.receiptBytes = Number(state.receiptBytes ?? 0) + storedBytes(receipt) - storedBytes(previous);
    state.dailyBytes = Number(state.dailyBytes ?? 0) + dailyBytesDelta;
    state.receiptCount = Number(state.receiptCount ?? 0) + Number(!previous);
    state.dailyBucketCount = Number(state.dailyBucketCount ?? 0) + dailyCountDelta;
    states.put(state);
  }
}
