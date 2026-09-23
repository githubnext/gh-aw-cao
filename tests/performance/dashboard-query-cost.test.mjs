/**
 * Headless query cost benchmark. Runs one test per statically selected query
 * against the deployed SQLite snapshot, measures computational and space cost,
 * and renders a report with the most costly queries.
 *
 * Prepare the snapshot with `npm run dashboard:data:download` (or point
 * DASHBOARD_QUERY_COST_DATABASE at another SQLite snapshot) and run:
 *   npm run test:performance:dashboard-query-cost
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { after, before } from "node:test";
import {
  benchmarkDashboardQueryCost,
  dashboardQueryCostMarkdown,
  DEFAULT_QUERY_COST_CANDIDATES,
  readDashboardDocument,
  selectCostlyQueries,
} from "../helpers/dashboard-query-cost.mjs";

const databasePath = path.resolve(
  process.env.DASHBOARD_QUERY_COST_DATABASE || ".cao/gh-aw-logs.sqlite",
);
const documentPath = path.resolve(
  process.env.DASHBOARD_QUERY_COST_DOCUMENT || "dashboard/site/dashboard.json",
);
const outputDirectory = path.resolve(
  process.env.DASHBOARD_QUERY_COST_OUTPUT || "test-results/dashboard-query-cost",
);

/** @param {string} name @param {number} fallback */
function budget(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be a positive number.`);
  return value;
}

const candidateLimit = budget("DASHBOARD_QUERY_COST_CANDIDATES", DEFAULT_QUERY_COST_CANDIDATES);
const maximumDurationMs = budget("DASHBOARD_QUERY_COST_MAX_DURATION_MS", 5_000);
const maximumOperations = budget("DASHBOARD_QUERY_COST_MAX_OPERATIONS", 50_000_000);
const maximumResultBytes = budget("DASHBOARD_QUERY_COST_MAX_RESULT_MB", 48) * 1024 * 1024;
const maximumRetainedBytes = budget("DASHBOARD_QUERY_COST_MAX_RETAINED_MB", 96) * 1024 * 1024;
const snapshotAvailable = existsSync(databasePath);

/** @type {Awaited<ReturnType<typeof benchmarkDashboardQueryCost>> | undefined} */
let report;
/** @type {any} */
let document;

before(async () => {
  document = await readDashboardDocument(documentPath);
  if (!snapshotAvailable) {
    console.warn(
      `Skipping deployed query cost measurements: ${databasePath} is missing. Run "npm run dashboard:data:download" first.`,
    );
    return;
  }
  report = await benchmarkDashboardQueryCost({
    databasePath,
    document,
    limit: candidateLimit,
  });
});

after(async () => {
  if (!report) return;
  const markdown = dashboardQueryCostMarkdown(report);
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`),
    writeFile(path.join(outputDirectory, "summary.md"), markdown),
  ]);
  console.log(markdown);
});

test("static query cost evaluator selects the queries to investigate", () => {
  const { candidates } = selectCostlyQueries(document, candidateLimit);
  assert.equal(candidates.length, Math.min(candidateLimit, document.dashboard.queries.length));
  assert.deepEqual(candidates.map(({ rank }) => rank), candidates.map((_, index) => index + 1));
  for (const candidate of candidates) {
    assert.ok(candidate["static-total-row-read-units"] > 0, `${candidate.name} has no static cost`);
  }
});

test(
  "deployed queries stay within the computational and space budget",
  { skip: snapshotAvailable ? false : "deployed SQLite snapshot is unavailable" },
  async (t) => {
    assert.ok(report, "benchmark report is available");
    assert.equal(report.measurements.length, report.candidates);
    for (const measurement of report.measurements) {
      await t.test(`${measurement.query} costs stay bounded`, () => {
        assert.notEqual(
          measurement.status,
          "failed",
          `${measurement.query} failed to execute: ${measurement.failure ?? ""}`,
        );
        assert.ok(
          measurement["duration-ms"] <= maximumDurationMs,
          `${measurement.query} took ${measurement["duration-ms"]} ms (limit ${maximumDurationMs} ms)`,
        );
        assert.ok(
          measurement.operations <= maximumOperations,
          `${measurement.query} spent ${measurement.operations} row operations (limit ${maximumOperations})`,
        );
        assert.ok(
          measurement["result-bytes"] <= maximumResultBytes,
          `${measurement.query} materialized ${measurement["result-bytes"]} result bytes (limit ${maximumResultBytes})`,
        );
        assert.ok(
          measurement["retained-heap-bytes"] <= maximumRetainedBytes,
          `${measurement.query} retained ${measurement["retained-heap-bytes"]} heap bytes (limit ${maximumRetainedBytes})`,
        );
      });
    }
  },
);
