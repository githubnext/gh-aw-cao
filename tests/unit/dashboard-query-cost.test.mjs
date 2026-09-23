import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  benchmarkDashboardQueryCost,
  dashboardQueryCostMarkdown,
  estimateRetainedBytes,
  selectCostlyQueries,
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

test("static query cost evaluator picks the highest ranked queries to investigate", () => {
  const { candidates, analysis } = selectCostlyQueries(dashboardDocument, CANDIDATE_LIMIT);
  assert.equal(candidates.length, CANDIDATE_LIMIT);
  assert.deepEqual(
    candidates.map(({ name }) => name),
    analysis.ranking.slice(0, CANDIDATE_LIMIT).map(({ name }) => name),
  );
  assert.deepEqual(
    candidates.map(({ rank }) => rank),
    Array.from({ length: CANDIDATE_LIMIT }, (_, index) => index + 1),
  );
  for (const candidate of candidates) {
    assert.ok(candidate["static-total-row-read-units"] >= candidate["static-direct-row-read-units"]);
  }
});

test("candidate limit must be a positive integer", () => {
  assert.throws(() => selectCostlyQueries(dashboardDocument, 0), TypeError);
  assert.throws(() => selectCostlyQueries(dashboardDocument, 1.5), TypeError);
});

test("retained byte estimate counts shared rows once", () => {
  const row = { name: "run", value: 12 };
  const single = estimateRetainedBytes([row]);
  assert.ok(single > 0);
  assert.equal(estimateRetainedBytes([row, row]), single + 8);
  assert.ok(estimateRetainedBytes([row, { ...row }]) > estimateRetainedBytes([row, row]));
});

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
    assert.ok(measurement["peak-heap-bytes"] >= measurement["retained-heap-bytes"]);
  }
  assert.deepEqual(
    [...report["most-costly-by-time"]].sort(),
    report.measurements.map(({ query }) => query).sort(),
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

test("deployed integration runs the headless query cost benchmark", async () => {
  const workflow = await readFile(".github/workflows/dashboard-deployed-integration.yml", "utf8");
  assert.match(workflow, /tests\/performance\/dashboard-query-cost\.test\.mjs/);
  assert.match(workflow, /tests\/helpers\/dashboard-query-cost\.mjs/);
  assert.match(workflow, /run: npm run dashboard:data:download/);
  assert.match(workflow, /run: npm run test:performance:dashboard-query-cost/);
  assert.match(workflow, /name: dashboard-query-cost\n/);
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(
    manifest.scripts["test:performance:dashboard-query-cost"],
    "node --expose-gc --test tests/performance/dashboard-query-cost.test.mjs",
  );
});
