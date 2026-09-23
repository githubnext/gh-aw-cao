/**
 * Headless computational and space cost measurement for Dashboard Language
 * queries executed against the deployed SQLite snapshot.
 *
 * The static query cost evaluator (`analyzeDashboardComplexity`) ranks every
 * query by normalized row-read units; the most expensive candidates are then
 * executed through the production query boundary so the measured time,
 * operation count, result size, and retained heap footprint are observable in
 * CI without a browser.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { analyzeDashboardComplexity } from "../../activity/dashboard-complexity.mjs";
import {
  executeDashboardQueries,
  executeDashboardQuery,
  createDashboardQueryBudget,
  dashboardQueryDefects,
  queryInputNames,
  resolveDashboardQuerySources,
} from "../../dashboard/site/src/data/queries/declarative.js";
import { queryDatabaseSources } from "../../dashboard/site/src/data/queries/database.js";
import { installSqliteIndexedDB } from "../../dashboard/site/src/data/storage/sqlite-indexeddb.js";

export const DEFAULT_QUERY_COST_CANDIDATES = 10;
// Generous bounds: the benchmark measures cost instead of enforcing the
// production budget, and the deployed snapshot is larger than a browser page.
const BENCHMARK_TIMEOUT_MS = 600_000;
const BENCHMARK_MAX_OPERATIONS = 2_000_000_000;

/** @param {string} databasePath */
export function openDeployedDatabase(databasePath) {
  return installSqliteIndexedDB(path.resolve(databasePath));
}

/** @param {string} documentPath */
export async function readDashboardDocument(documentPath) {
  return JSON.parse(await readFile(path.resolve(documentPath), "utf8"));
}

/**
 * Ranks every declared query with the static cost evaluator and returns the
 * most expensive candidates to investigate.
 *
 * @param {unknown} document
 * @param {number} [limit]
 */
export function selectCostlyQueries(document, limit = DEFAULT_QUERY_COST_CANDIDATES) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError("Query cost candidate limit must be a positive integer.");
  }
  const analysis = analyzeDashboardComplexity(document);
  return {
    analysis,
    candidates: analysis.ranking.slice(0, limit).map((query) => ({
      name: query.name,
      rank: query.rank,
      class: query.class,
      "used-by": query["used-by"],
      "static-total-row-read-units": query["total-row-read-units"],
      "static-direct-row-read-units": query["direct-row-read-units"],
      "static-dependency-row-read-units": query["dependency-row-read-units"],
    })),
  };
}

/**
 * Approximates the retained bytes of a materialized query result. Object
 * identity is tracked so shared rows are only counted once, matching what the
 * dashboard retains in the worker heap.
 *
 * @param {unknown} value
 */
export function estimateRetainedBytes(value) {
  const seen = new Set();
  /** @param {unknown} current */
  const walk = (current) => {
    if (current === null || current === undefined) return 0;
    if (typeof current === "boolean") return 4;
    if (typeof current === "number") return 8;
    if (typeof current === "bigint") return 16;
    if (typeof current === "string") return 16 + current.length * 2;
    if (typeof current !== "object") return 8;
    if (seen.has(current)) return 0;
    seen.add(current);
    if (Array.isArray(current)) {
      return 32 + current.reduce((total, entry) => total + 8 + walk(entry), 0);
    }
    return Object.entries(current).reduce(
      (total, [key, entry]) => total + 16 + key.length * 2 + walk(entry),
      32,
    );
  };
  return walk(value);
}

function collectGarbage() {
  if (typeof globalThis.gc === "function") {
    globalThis.gc();
    globalThis.gc();
    return true;
  }
  return false;
}

/**
 * Measures one query executed over already materialized input sources.
 *
 * @param {Record<string, any>} definition
 * @param {Record<string, any>} sources
 * @param {string | undefined} defect
 */
export function measureDashboardQueryCost(definition, sources, defect) {
  const inputRows = Object.fromEntries(queryInputNames(definition).map((name) => [
    name,
    Array.isArray(sources[name]?.rows) ? sources[name].rows.length : 0,
  ]));
  const budget = createDashboardQueryBudget({
    timeout: BENCHMARK_TIMEOUT_MS,
    maxOperations: BENCHMARK_MAX_OPERATIONS,
  });
  const collected = collectGarbage();
  const baselineHeapBytes = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  let rows = [];
  let status = "available";
  let failure;
  try {
    const result = executeDashboardQuery(definition, sources, defect, budget);
    rows = result.rows;
    status = String(result.metadata?.availability ?? "available");
    if (status === "unavailable") {
      failure = String(result.metadata?.["query-diagnostic"] ?? "query is unavailable");
    }
  } catch (error) {
    status = "failed";
    failure = error instanceof Error ? error.message : String(error);
  }
  const durationMs = performance.now() - startedAt;
  // Sampled once after execution: allocations already collected by the engine
  // are invisible, so this is an approximation of the execution high-water
  // mark rather than an exact peak.
  const executedHeapBytes = Math.max(0, process.memoryUsage().heapUsed - baselineHeapBytes);
  const resultBytes = estimateRetainedBytes(rows);
  collectGarbage();
  const retainedHeapBytes = Math.max(0, process.memoryUsage().heapUsed - baselineHeapBytes);
  const executionHeapBytes = Math.max(executedHeapBytes, retainedHeapBytes);
  return {
    query: definition.name,
    status,
    ...(failure ? { failure } : {}),
    "duration-ms": Number(durationMs.toFixed(3)),
    operations: budget.operations,
    "input-rows": inputRows,
    "input-row-total": Object.values(inputRows).reduce((total, count) => total + count, 0),
    rows: rows.length,
    "result-bytes": resultBytes,
    "bytes-per-row": rows.length === 0 ? 0 : Math.round(resultBytes / rows.length),
    "retained-heap-bytes": retainedHeapBytes,
    "execution-heap-bytes": executionHeapBytes,
    "heap-measured": collected,
  };
}

/**
 * Executes each statically selected query against the deployed SQLite
 * snapshot and reports its computational and space cost.
 *
 * @param {{ databasePath: string, document: unknown, limit?: number }} options
 */
export async function benchmarkDashboardQueryCost({ databasePath, document, limit }) {
  const dashboard = /** @type {any} */ (document)?.dashboard;
  const definitions = Array.isArray(dashboard?.queries) ? dashboard.queries : [];
  const { analysis, candidates } = selectCostlyQueries(document, limit ?? DEFAULT_QUERY_COST_CANDIDATES);
  const index = new Map(definitions
    .filter((query) => query && typeof query.name === "string")
    .map((query) => [query.name, query]));
  const defects = dashboardQueryDefects(definitions);
  const previousIndexedDB = globalThis.indexedDB;
  const previousKeyRange = globalThis.IDBKeyRange;
  try {
    const indexedDB = openDeployedDatabase(databasePath);
    const required = resolveDashboardQuerySources(definitions, candidates.map(({ name }) => name));
    const databaseStartedAt = performance.now();
    // Mirrors the production worker boundary: the canonical projection resolves
    // every required name and declared queries execute over its result.
    const databaseSources = await queryDatabaseSources(indexedDB, {}, required);
    const databaseMs = performance.now() - databaseStartedAt;
    const dependencySources = executeDashboardQueries(
      definitions,
      databaseSources,
      required.filter((name) => index.has(name)),
      { timeout: BENCHMARK_TIMEOUT_MS, maxOperations: BENCHMARK_MAX_OPERATIONS },
    );
    /** @type {Record<string, any>} */
    const sources = { ...databaseSources };
    for (const [name, source] of Object.entries(dependencySources)) {
      // Materialize every dependency before measurement so each candidate
      // reports only its own execution cost.
      sources[name] = { source: name, rows: source.rows, metadata: source.metadata };
    }
    const measurements = candidates
      .filter((candidate) => index.has(candidate.name))
      .map((candidate) => ({
        ...candidate,
        ...measureDashboardQueryCost(index.get(candidate.name), sources, defects.get(candidate.name)),
      }));
    const databaseRecords = Object.entries(databaseSources)
      .filter(([name]) => !index.has(name))
      .reduce((total, [, source]) => total + (Array.isArray(source?.rows) ? source.rows.length : 0), 0);
    return {
      dashboard: typeof dashboard?.id === "string" ? dashboard.id : "dashboard",
      queries: definitions.length,
      candidates: measurements.length,
      database: {
        path: path.resolve(databasePath),
        "duration-ms": Number(databaseMs.toFixed(3)),
        "records-read": databaseRecords,
        sources: Object.keys(databaseSources).filter((name) => !index.has(name)).length,
      },
      "static-model": analysis.summary.model,
      "static-materialize-all-row-read-units": analysis.summary["materialize-all-row-read-units"],
      measurements,
      "most-costly-by-time": rankMeasurements(measurements, "duration-ms"),
      "most-costly-by-memory": rankMeasurements(measurements, "result-bytes", "retained-heap-bytes"),
    };
  } finally {
    globalThis.indexedDB = previousIndexedDB;
    globalThis.IDBKeyRange = previousKeyRange;
  }
}

/**
 * @param {any[]} measurements
 * @param {string} field
 * @param {string} [tiebreak]
 */
function rankMeasurements(measurements, field, tiebreak = "duration-ms") {
  return measurements
    .toSorted((left, right) => right[field] - left[field] || right[tiebreak] - left[tiebreak])
    .map(({ query }) => query);
}

/** @param {number} value */
function formatBytes(value) {
  const units = ["B", "KiB", "MiB", "GiB"];
  let size = Math.max(0, Number(value) || 0);
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? Math.round(size) : size.toFixed(2)} ${units[unit]}`;
}

/** @param {number} value */
function formatCount(value) {
  return Number(value ?? 0).toLocaleString("en-US");
}

/** @param {string} value */
function markdownCode(value) {
  const safe = String(value).replaceAll("`", "'").replaceAll("|", "\\|").replaceAll("\n", " ");
  return `\`${safe}\``;
}

/**
 * Renders the top most costly queries for a CI job summary or pull request.
 *
 * @param {Awaited<ReturnType<typeof benchmarkDashboardQueryCost>>} report
 */
export function dashboardQueryCostMarkdown(report) {
  const index = new Map(report.measurements.map((measurement) => [measurement.query, measurement]));
  const byTime = report["most-costly-by-time"].map((query) => index.get(query));
  const byMemory = report["most-costly-by-memory"].map((query) => index.get(query));
  const failures = report.measurements.filter((measurement) =>
    !["available", "empty"].includes(measurement.status));
  return [
    "## Dashboard query cost (deployed SQLite snapshot)",
    "",
    `Measured the **${report.candidates} most expensive of ${report.queries} queries** chosen by the static query cost evaluator (${report["static-model"]}, ${formatCount(report["static-materialize-all-row-read-units"])} normalized row-read units to materialize all queries).`,
    "",
    `Canonical projection read **${formatCount(report.database["records-read"])} records** across **${report.database.sources} sources** in **${report.database["duration-ms"].toFixed(2)} ms**.`,
    "",
    "### Computational cost",
    "",
    "| Rank | Query | Static rank | Input rows | Output rows | Operations | Time (ms) |",
    "| ---: | --- | ---: | ---: | ---: | ---: | ---: |",
    ...byTime.map((measurement, index) => `| ${index + 1} | ${markdownCode(measurement.query)} | ${measurement.rank} | ${formatCount(measurement["input-row-total"])} | ${formatCount(measurement.rows)} | ${formatCount(measurement.operations)} | ${measurement["duration-ms"].toFixed(2)} |`),
    "",
    "### Space cost",
    "",
    "| Rank | Query | Output rows | Result size | Bytes/row | Retained heap | Heap after run |",
    "| ---: | --- | ---: | ---: | ---: | ---: | ---: |",
    ...byMemory.map((measurement, index) => `| ${index + 1} | ${markdownCode(measurement.query)} | ${formatCount(measurement.rows)} | ${formatBytes(measurement["result-bytes"])} | ${formatBytes(measurement["bytes-per-row"])} | ${formatBytes(measurement["retained-heap-bytes"])} | ${formatBytes(measurement["execution-heap-bytes"])} |`),
    "",
    report.measurements.every((measurement) => measurement["heap-measured"])
      ? "_Retained heap is measured after collection while the result is held; heap after run is a single post-execution sample, not an exact peak._"
      : "_Heap measurements are approximate: run Node.js with `--expose-gc` for settled retained-heap readings._",
    ...(failures.length === 0
      ? []
      : [
        "",
        "### Unavailable queries",
        "",
        ...failures.map((measurement) => `- ${markdownCode(measurement.query)}: ${measurement.failure ?? measurement.status}`),
      ]),
    "",
  ].join("\n");
}
