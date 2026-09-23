import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  benchmarkDashboardQueryCost,
  dashboardQueryCostMarkdown,
} from "../helpers/dashboard-query-cost.mjs";

const dashboardDocument = JSON.parse(
  await readFile("dashboard/site/dashboard.json", "utf8"),
);

/** Builds a small canonical SQLite snapshot with the shipped ingestion path. */
async function syntheticSnapshot() {
  const root = await mkdtemp(path.join(tmpdir(), "cao-query-cost-"));
  const shards = path.join(root, "gh-aw-logs-shards");
  const database = path.join(root, "gh-aw-logs.sqlite");
  execFileSync(process.execPath, [
    "tests/helpers/dashboard-stress-data.mjs",
    "--output", shards,
    "--repositories", "3",
    "--runs", "12",
    "--shards", "1",
    "--workflows", "3",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  execFileSync(process.execPath, [
    "activity/cao.mjs",
    "ingest-jsonl",
    "--database", database,
    "--input-dir", shards,
    "--retention-days", "all",
    "--run-retention-days", "all",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  return { root, database };
}

const CANDIDATE_LIMIT = 10;

test("benchmark measures computational and space cost per query", async (t) => {
  const { root, database } = await syntheticSnapshot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = await benchmarkDashboardQueryCost({
    databasePath: database,
    document: dashboardDocument,
    limit: 3,
  });
  assert.equal(report.candidates, 3);
  assert.equal(report.measurements.length, 3);
  assert.equal(report.queries, dashboardDocument.dashboard.queries.length);
  assert.ok(report.database["records-read"] > 0);
  for (const measurement of report.measurements) {
    assert.notEqual(measurement.status, "failed", measurement.failure ?? "");
    assert.ok(measurement["duration-ms"] >= 0);
    assert.ok(measurement.operations >= 0);
    assert.ok(measurement["result-bytes"] > 0);
    assert.ok(measurement["retained-heap-bytes"] >= 0);
    assert.ok(measurement["execution-heap-bytes"] >= 0);
    assert.equal(typeof measurement["heap-measured"], "boolean");
    assert.ok(measurement["input-row-total"] >= 0);
  }
  assert.deepEqual(
    report["most-costly-by-time"],
    [...report.measurements]
      .sort((left, right) => right["duration-ms"] - left["duration-ms"])
      .map(({ query }) => query),
  );
  assert.deepEqual(
    report["most-costly-by-memory"],
    [...report.measurements]
      .sort((left, right) => right["result-bytes"] - left["result-bytes"]
        || right["retained-heap-bytes"] - left["retained-heap-bytes"])
      .map(({ query }) => query),
  );

  const markdown = dashboardQueryCostMarkdown(report);
  assert.match(markdown, /## Dashboard query cost \(deployed SQLite snapshot\)/);
  assert.match(markdown, /### Computational cost/);
  assert.match(markdown, /### Space cost/);
  for (const measurement of report.measurements) {
    assert.ok(markdown.includes(`\`${measurement.query}\``), `${measurement.query} is missing`);
  }
});
