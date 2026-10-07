/**
 * Measure deployed dashboard queries through the production Go query engine
 * after ingesting downloaded artifacts into an isolated Postgres instance.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  DEFAULT_QUERY_COST_CANDIDATES,
  readDashboardDocument,
  selectCostlyQueries,
} from "../helpers/dashboard-query-cost.mjs";
import { postgresQueryCostMarkdown } from "../helpers/dashboard-query-cost-report.mjs";

const execute = promisify(execFile);
const outputDirectory = path.resolve(process.env.DASHBOARD_QUERY_COST_POSTGRES_OUTPUT || "test-results/dashboard-query-cost/postgres");

function positiveBudget(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be positive`);
  return value;
}

test("deployed query cost uses Postgres and the production Go engine", async () => {
  const document = await readDashboardDocument(process.env.DASHBOARD_QUERY_COST_DOCUMENT || "dashboard/site/dashboard.json");
  const limit = positiveBudget("DASHBOARD_QUERY_COST_CANDIDATES", DEFAULT_QUERY_COST_CANDIDATES);
  assert.ok(Number.isInteger(limit));
  const { candidates } = selectCostlyQueries(document, limit);
  assert.ok(candidates.length > 0, "no queries selected");
  await mkdir(outputDirectory, { recursive: true });
  const candidatesPath = path.join(outputDirectory, "candidates.json");
  const definitionsPath = path.join(outputDirectory, "queries.json");
  await writeFile(candidatesPath, `${JSON.stringify(candidates.map(({ name }) => name))}\n`);
  await writeFile(definitionsPath, `${JSON.stringify(document.dashboard.queries)}\n`);
  let stdout;
  try {
    ({ stdout } = await execute(process.env.DASHBOARD_SERVER_BINARY || ".tmp/cao-dashboard", [
      "benchmark-queries",
      "--source", process.env.DASHBOARD_QUERY_COST_SOURCE || ".cao",
      "--database-queries", "dashboard/site/src/data/queries/database.json",
      "--dashboard-queries", definitionsPath,
      "--candidates", candidatesPath,
    ], { maxBuffer: 8 * 1024 * 1024 }));
  } finally {
    await Promise.all([rm(candidatesPath, { force: true }), rm(definitionsPath, { force: true })]);
  }
  const report = JSON.parse(stdout);
  await writeFile(path.join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(outputDirectory, "summary.md"), postgresQueryCostMarkdown(report, candidates));

  assert.equal(report.engine, "postgres-native-sql");
  assert.ok(Number.isInteger(report["page-limit"]) && report["page-limit"] > 0 && report["page-limit"] <= 100_000);
  assert.ok(report.records >= positiveBudget("DASHBOARD_QUERY_COST_MIN_RECORDS", 1));
  assert.ok(report["source-counts"]["$runs"] > 0, "deployed runs are empty");
  assert.deepEqual(report.measurements.map(({ query }) => query), candidates.map(({ name }) => name));
  for (const entry of report.measurements) {
    assert.ok(Number.isInteger(entry["total-rows"]) && entry["total-rows"] >= 0);
    assert.equal(entry.rows, Math.min(entry["total-rows"], report["page-limit"]));
    assert.equal(entry.metrics.outputRows, entry.rows);
    assert.ok(entry["duration-ms"] <= positiveBudget("DASHBOARD_QUERY_COST_MAX_DURATION_MS", 30_000),
      `${entry.query} exceeded the duration budget`);
    assert.ok(entry.metrics.operations <= positiveBudget("DASHBOARD_QUERY_COST_MAX_OPERATIONS", 50_000_000),
      `${entry.query} exceeded the operations budget`);
    assert.ok(entry.metrics.retainedBytes <= positiveBudget("DASHBOARD_QUERY_COST_MAX_RETAINED_MB", 256) * 1024 * 1024,
      `${entry.query} exceeded the retained bytes budget`);
    assert.ok(entry.rows >= 0 && entry.metrics.peakWorkingRows >= 0);
  }
});
