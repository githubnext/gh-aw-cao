/**
 * Pure, IndexedDB-free daily aggregation for the Overview page.
 *
 * This module derives per-UTC-day additive counters from the canonical
 * `runs` records already produced during ingestion normalization. It does
 * not read or write any storage; callers are responsible for persisting
 * the returned records (see storage/indexeddb.js) behind a generation so
 * that publication remains crash-safe.
 *
 * Only metrics that are provably additive across days are computed here.
 * Snapshot (registered repositories, campaigns, current workers) and
 * non-additive (distinct delivered repositories) aggregates MUST NOT be
 * derived by summing daily values and are intentionally excluded.
 */

/** Conclusions treated as failed for run/dispatch aggregation. */
export const FAILED_RUN_CONCLUSIONS = ['failure', 'startup-failure', 'stale', 'timed-out'];
const FAILED_CONCLUSIONS = new Set(FAILED_RUN_CONCLUSIONS);
export const DISPATCH_EVENT = 'workflow_dispatch';

/**
 * @typedef {object} DailyOverviewAggregateRecord
 * @property {string} day UTC calendar day, `YYYY-MM-DD`.
 * @property {number} runs Total runs started on this day.
 * @property {number} successfulRuns Runs with conclusion `success`.
 * @property {number} failedRuns Runs with a failed conclusion.
 * @property {number} dispatches `workflow_dispatch` runs started on this day.
 * @property {number} failedDispatches Failed `workflow_dispatch` runs.
 */

/**
 * Resolves the UTC calendar day (`YYYY-MM-DD`) for a run, preferring
 * `startedAt` and falling back to `createdAt`. Returns `null` when neither
 * timestamp is a parseable date, so callers can skip/attribute the record
 * instead of silently corrupting a bucket.
 *
 * @param {Record<string, unknown>} run
 * @returns {string | null}
 */
export function resolveRunUtcDay(run) {
  for (const candidate of [run?.startedAt, run?.createdAt]) {
    if (typeof candidate !== 'string' || !candidate) continue;
    const milliseconds = Date.parse(candidate);
    if (!Number.isFinite(milliseconds)) continue;
    return new Date(milliseconds).toISOString().slice(0, 10);
  }
  return null;
}

/**
 * Builds deterministic per-UTC-day additive counters from canonical runs.
 *
 * Deterministic: identical input (including duplicate identities) always
 * produces identical output regardless of input ordering, because runs
 * are deduplicated by `id` before aggregation (last-write-wins, matching
 * canonical replace-by-id semantics) and results are sorted by day.
 *
 * @param {Record<string, unknown>[] | null | undefined} runs Canonical run records.
 * @returns {DailyOverviewAggregateRecord[]} Sorted ascending by `day`.
 */
export function buildDailyOverviewAggregates(runs) {
  /** @type {Map<string, Record<string, unknown>>} */
  const runsById = new Map();
  for (const run of runs ?? []) {
    const id = run?.id;
    if (typeof id !== 'string' || !id) continue;
    runsById.set(id, run);
  }

  /** @type {Map<string, DailyOverviewAggregateRecord>} */
  const byDay = new Map();
  /** @param {string} day */
  const dayRecord = (day) => {
    let record = byDay.get(day);
    if (!record) {
      record = { day, runs: 0, successfulRuns: 0, failedRuns: 0, dispatches: 0, failedDispatches: 0 };
      byDay.set(day, record);
    }
    return record;
  };

  for (const run of runsById.values()) {
    const day = resolveRunUtcDay(run);
    // Intentionally excluded from every metric (spec §72.3) rather than
    // attributed to a fallback bucket: a run without any parseable timestamp
    // cannot be placed on the UTC day axis this projection is keyed by.
    if (!day) continue;
    const record = dayRecord(day);
    const conclusion = typeof run.conclusion === 'string' ? run.conclusion : null;
    const isDispatch = run.event === DISPATCH_EVENT;

    record.runs += 1;
    if (conclusion === 'success') record.successfulRuns += 1;
    if (conclusion && FAILED_CONCLUSIONS.has(conclusion)) record.failedRuns += 1;
    if (isDispatch) {
      record.dispatches += 1;
      if (conclusion && FAILED_CONCLUSIONS.has(conclusion)) record.failedDispatches += 1;
    }
  }

  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}
