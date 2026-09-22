/**
 * Query-planner fast path for eligible additive Overview queries (spec
 * §72.6). Reduces O(records in window) canonical scans to O(days in
 * window) by summing the materialized `dailyOverviewAggregates` projection
 * instead of loading and reducing every canonical `runs` record.
 *
 * This is intentionally narrow rather than a general query-shape
 * compiler: each eligible query name is matched against the *exact*
 * structural shape it is known to have today (source, filter, aggregate
 * values). Any drift from that shape — a joined field, an extra
 * predicate, a different reducer — disqualifies the query and it falls
 * back unmodified to the canonical declarative execution path. Query
 * semantic parity is the highest-risk part of this optimization, so
 * eligibility is fail-closed by construction: an unrecognized shape is
 * always treated as ineligible, never guessed at.
 */

import { DISPATCH_EVENT, FAILED_RUN_CONCLUSIONS } from '../analytics/daily-overview-aggregates.js';
import { readDailyOverviewAggregates, readOverviewAggregateMetadata } from '../storage/indexeddb.js';
import { dashboardQueryIndex } from './declarative.js';
import { createDebug } from '../../debug.js';

const debugQuery = createDebug('data:query');

const monotonicNow = () => globalThis.performance?.now() ?? Date.now();

/**
 * Emits the §72.7 diagnostics record. Field names intentionally match the
 * spec's camelCase instrumentation contract (`executionPath`, `durationMs`,
 * etc.) rather than the kebab-case convention used for `LogicalSourceInput`
 * metadata elsewhere in the query layer, since this is a separate
 * observability surface, not part of the returned source payload.
 *
 * @param {{
 *   query: string,
 *   executionPath: 'canonical' | 'daily-aggregate',
 *   durationMs: number,
 *   requestCount: number,
 *   recordsScanned: number,
 *   recordsReturned: number,
 *   aggregateVersion: number | null,
 *   generation: string | null,
 *   fallbackReason: string | null
 * }} record
 */
function reportDiagnostics(record) {
  debugQuery('daily-aggregate fast path', record);
}

/** @param {unknown} value */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} predicates
 * @param {{ field: string, equals?: unknown, in?: unknown[] }} expected
 */
function matchesSinglePredicate(predicates, expected) {
  if (!Array.isArray(predicates) || predicates.length !== 1) return false;
  const [predicate] = predicates;
  if (!isPlainObject(predicate) || predicate.field !== expected.field) return false;
  if ('equals' in expected) return predicate.equals === expected.equals && !('in' in predicate);
  if ('in' in expected && Array.isArray(expected.in)) {
    return Array.isArray(predicate.in)
      && predicate.in.length === expected.in.length
      && expected.in.every((value) => predicate.in.includes(value));
  }
  return false;
}

/**
 * Recognizes the exact shape of `overview-dispatch-summary` (dashboard.json):
 * `from: runs`, filtered to `event = workflow_dispatch`, with exactly two
 * `count` aggregate values — an unfiltered total and one filtered to the
 * failed-conclusion set — matching `buildDailyOverviewAggregates`'s
 * `dispatches`/`failedDispatches` fields one for one.
 *
 * @param {import('./declarative.js').DashboardQuery} definition
 */
function isDispatchSummaryShape(definition) {
  if (definition.from !== 'runs') return false;
  if (definition.joins?.length || definition.union?.length || definition.compute?.length
      || definition.select?.length || definition['order-by']?.length || definition.limit !== undefined
      || definition.aggregate?.by?.length || definition['temporal-series'] || definition.predict?.length) {
    return false;
  }
  if (!matchesSinglePredicate(definition.filter?.predicates, { field: 'event', equals: DISPATCH_EVENT })) {
    return false;
  }
  const values = definition.aggregate?.values;
  if (!Array.isArray(values) || values.length !== 2) return false;
  const [total, failed] = values;
  if (!isPlainObject(total) || total.reducer !== 'count' || total.filter) return false;
  if (!isPlainObject(failed) || failed.reducer !== 'count') return false;
  if (!matchesSinglePredicate(failed.filter?.predicates, { field: 'run-conclusion', in: FAILED_RUN_CONCLUSIONS })) {
    return false;
  }
  return { totalAs: String(total.as), failedAs: String(failed.as) };
}

/**
 * Recognizes the exact shape of `overview-failed-run-count` (dashboard.json):
 * `from: runs`, filtered to `run-conclusion in FAILED_RUN_CONCLUSIONS`, with
 * exactly one unfiltered `count` aggregate value — matching
 * `buildDailyOverviewAggregates`'s `failedRuns` field one for one.
 *
 * @param {import('./declarative.js').DashboardQuery} definition
 */
function isFailedRunCountShape(definition) {
  if (definition.from !== 'runs') return false;
  if (definition.joins?.length || definition.union?.length || definition.compute?.length
      || definition.select?.length || definition['order-by']?.length || definition.limit !== undefined
      || definition.aggregate?.by?.length || definition['temporal-series'] || definition.predict?.length) {
    return false;
  }
  if (!matchesSinglePredicate(definition.filter?.predicates, { field: 'run-conclusion', in: FAILED_RUN_CONCLUSIONS })) {
    return false;
  }
  const values = definition.aggregate?.values;
  if (!Array.isArray(values) || values.length !== 1) return false;
  const [total] = values;
  if (!isPlainObject(total) || total.reducer !== 'count' || total.filter) return false;
  return { countAs: String(total.as) };
}

/**
 * Recognizes the daily conclusion query used by the Runs swimlane. Request
 * scoped `@time` predicates are allowed because the materialized records use
 * the same UTC day computed by the query.
 *
 * @param {import('./declarative.js').DashboardQuery} definition
 */
function isRunsDailyConclusionsShape(definition) {
  if (definition.from !== 'runs' || definition.joins?.length || definition.union?.length
      || definition.select?.length || definition['order-by']?.length || definition.limit !== undefined
      || definition['temporal-series'] || definition.predict?.length) {
    return false;
  }
  const compute = definition.compute;
  if (!Array.isArray(compute) || compute.length !== 1) return false;
  const [day] = compute;
  const dayArgument = isPlainObject(day) && Array.isArray(day.args) && isPlainObject(day.args[0])
    ? /** @type {Record<string, unknown>} */ (day.args[0])
    : null;
  if (!isPlainObject(day) || day.as !== 'day' || day.function !== 'date-day'
      || !Array.isArray(day.args) || day.args.length !== 1
      || dayArgument?.field !== 'started-at') {
    return false;
  }
  const by = definition.aggregate?.by;
  const values = definition.aggregate?.values;
  if (!Array.isArray(by) || by.length !== 2 || by[0] !== 'day' || by[1] !== 'run-conclusion'
      || !Array.isArray(values) || values.length !== 1) {
    return false;
  }
  const [count] = values;
  if (!isPlainObject(count) || count.field !== 'run' || count.reducer !== 'count' || count.filter) {
    return false;
  }
  const predicates = definition.filter?.predicates ?? [];
  if (!Array.isArray(predicates) || predicates.some((predicate) => (
    !isPlainObject(predicate)
    || predicate.field !== '@time'
    || (typeof predicate.gte !== 'string' && typeof predicate.lt !== 'string')
  ))) {
    return false;
  }
  return {
    countAs: String(count.as),
    startDay: String(predicates.find((predicate) => typeof predicate.gte === 'string')?.gte ?? '').slice(0, 10) || null,
    endDay: String(predicates.find((predicate) => typeof predicate.lt === 'string')?.lt ?? '').slice(0, 10) || null
  };
}

/**
 * Eligible query names mapped to their shape validator and daily-record
 * summarizer. A query is only ever fast-pathed if the live definition still
 * matches the validator; otherwise it is left for canonical execution.
 */
const ELIGIBLE_QUERIES = /** @type {const} */ ({
  'overview-dispatch-summary': {
    matchShape: isDispatchSummaryShape,
    /**
     * @param {import('../analytics/daily-overview-aggregates.js').DailyOverviewAggregateRecord[]} records
     * @param {{ totalAs: string, failedAs: string }} shape
     */
    summarize: (records, shape) => {
      let dispatches = 0;
      let failedDispatches = 0;
      for (const record of records) {
        dispatches += record.dispatches ?? 0;
        failedDispatches += record.failedDispatches ?? 0;
      }
      return { [shape.totalAs]: dispatches, [shape.failedAs]: failedDispatches };
    }
  },
  'overview-failed-run-count': {
    matchShape: isFailedRunCountShape,
    /**
     * @param {import('../analytics/daily-overview-aggregates.js').DailyOverviewAggregateRecord[]} records
     * @param {{ countAs: string }} shape
     */
    summarize: (records, shape) => {
      let failedRuns = 0;
      for (const record of records) {
        failedRuns += record.failedRuns ?? 0;
      }
      return { [shape.countAs]: failedRuns };
    }
  },
  'runs-daily-conclusions': {
    matchShape: isRunsDailyConclusionsShape,
    /**
     * @param {import('../analytics/daily-overview-aggregates.js').DailyOverviewAggregateRecord[]} records
     * @param {{ countAs: string, startDay: string | null, endDay: string | null }} shape
     */
    summarize: (records, shape) => records
      .filter((record) => (
        (!shape.startDay || record.day >= shape.startDay)
        && (!shape.endDay || record.day <= shape.endDay)
      ))
      .flatMap((record) => Object.entries(record.runsByConclusion ?? {})
        .filter(([, count]) => Number.isFinite(count) && count > 0)
        .map(([conclusion, count]) => ({
          day: record.day,
          'run-conclusion': conclusion,
          [shape.countAs]: count
        })))
  }
});

/**
 * @param {string} name
 * @param {string | null} generation
 * @param {number | null} version
 * @param {'available' | 'unavailable'} availability
 * @param {Record<string, unknown>} [extra]
 * @returns {import('../../presenter.js').SourceMetadata}
 */
function fastPathMetadata(name, generation, version, availability, extra = {}) {
  return /** @type {import('../../presenter.js').SourceMetadata} */ ({
    'source-id': `${name}-query`,
    'source-kind': 'derived',
    'as-of': new Date().toISOString(),
    'retrieved-at': new Date().toISOString(),
    completeness: availability === 'available' ? 'complete' : 'unknown',
    freshness: availability === 'available' ? 'fresh' : 'unknown',
    availability,
    'query-name': name,
    'execution-path': 'daily-aggregate',
    generation,
    'aggregate-version': version,
    ...extra
  });
}

/**
 * Attempts the daily-aggregate fast path for every requested query that is
 * both structurally eligible and backed by available materialized
 * aggregates. Ineligible or unavailable queries are simply omitted from the
 * result so callers fall back to canonical execution for them (spec
 * §72.6/§72.8) — this function never throws to signal ineligibility.
 *
 * @param {IDBFactory} indexedDB
 * @param {unknown} definitions
 * @param {Iterable<string>} requested
 * @returns {Promise<Record<string, import('../../presenter.js').LogicalSourceInput>>}
 */
export async function queryDailyOverviewAggregateSources(indexedDB, definitions, requested) {
  const index = dashboardQueryIndex(definitions);
  /** @type {Array<{ name: string, shape: unknown, summarize: (records: import('../analytics/daily-overview-aggregates.js').DailyOverviewAggregateRecord[], shape: unknown) => Record<string, unknown> | Array<Record<string, unknown>> }>} */
  const candidates = [];
  for (const name of requested) {
    const definition = index.get(name);
    const eligible = ELIGIBLE_QUERIES[/** @type {keyof typeof ELIGIBLE_QUERIES} */ (name)]
      ?? (definition && isRunsDailyConclusionsShape(definition)
        ? ELIGIBLE_QUERIES['runs-daily-conclusions']
        : undefined);
    if (!eligible) continue;
    const shape = definition ? eligible.matchShape(definition) : false;
    if (!shape) {
      reportDiagnostics({
        query: name,
        executionPath: 'canonical',
        durationMs: 0,
        requestCount: 1,
        recordsScanned: 0,
        recordsReturned: 0,
        aggregateVersion: null,
        generation: null,
        fallbackReason: definition ? 'shape-mismatch' : 'unknown-query'
      });
      continue;
    }
    candidates.push({
      name,
      shape,
      summarize: /** @type {(records: import('../analytics/daily-overview-aggregates.js').DailyOverviewAggregateRecord[], shape: unknown) => Record<string, unknown> | Array<Record<string, unknown>>} */ (eligible.summarize)
    });
  }
  if (candidates.length === 0) return {};

  const startedAt = monotonicNow();
  const metadata = await readOverviewAggregateMetadata(indexedDB);
  if (!metadata.available || !metadata.firstDay || !metadata.lastDay) {
    for (const { name } of candidates) {
      reportDiagnostics({
        query: name,
        executionPath: 'canonical',
        durationMs: Math.round(monotonicNow() - startedAt),
        requestCount: 1,
        recordsScanned: 0,
        recordsReturned: 0,
        aggregateVersion: null,
        generation: null,
        fallbackReason: metadata.fallbackReason ?? 'metadata-unavailable'
      });
    }
    return {};
  }

  const read = await readDailyOverviewAggregates(indexedDB, {
    startDay: metadata.firstDay,
    endDay: metadata.lastDay
  });
  if (!read.available) {
    for (const { name } of candidates) {
      reportDiagnostics({
        query: name,
        executionPath: 'canonical',
        durationMs: Math.round(monotonicNow() - startedAt),
        requestCount: 1,
        recordsScanned: 0,
        recordsReturned: 0,
        aggregateVersion: metadata.version ?? null,
        generation: metadata.generation ?? null,
        fallbackReason: read.fallbackReason ?? 'aggregates-unavailable'
      });
    }
    return {};
  }

  /** @type {Record<string, import('../../presenter.js').LogicalSourceInput>} */
  const results = {};
  for (const { name, shape, summarize } of candidates) {
    const summary = summarize(read.records, shape);
    const rows = Array.isArray(summary) ? summary : [summary];
    const durationMs = Math.round(monotonicNow() - startedAt);
    results[name] = {
      source: name,
      rows,
      metadata: fastPathMetadata(name, read.generation, read.version, 'available', {
        'records-scanned': read.recordsScanned,
        'duration-ms': durationMs
      })
    };
    reportDiagnostics({
      query: name,
      executionPath: 'daily-aggregate',
      durationMs,
      requestCount: 1,
      recordsScanned: read.recordsScanned,
      recordsReturned: rows.length,
      aggregateVersion: read.version,
      generation: read.generation,
      fallbackReason: null
    });
  }
  return results;
}
