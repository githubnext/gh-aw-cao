import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { DATABASE_VERSION } from "../../dashboard/site/src/data/storage/indexeddb.js";
import {
  benchmarkDashboardQueryCost,
  dashboardQueryCostMarkdown,
  readSnapshotDatabaseVersion,
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
  assert.equal(report.database["snapshot-version"], DATABASE_VERSION);
  assert.equal(report.database["version-compatible"], true);
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
  assert.match(markdown, /### Dashboard query cost \(deployed SQLite snapshot\)/);
  assert.match(markdown, /### Computational cost/);
  assert.match(markdown, /### Space cost/);
  assert.match(markdown, /Canonical projection by source/);
  assert.doesNotMatch(markdown, /canonical projection returned no records/);
  for (const measurement of report.measurements) {
    assert.ok(markdown.includes(`\`${measurement.query}\``), `${measurement.query} is missing`);
  }
});

test("benchmark reports an empty snapshot instead of an all-zero measurement", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "cao-query-cost-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = await benchmarkDashboardQueryCost({
    databasePath: path.join(root, "empty.sqlite"),
    document: dashboardDocument,
    limit: 3,
  });
  assert.equal(report.database["records-read"], 0);
  assert.equal(report.database["snapshot-version"], null);
  assert.equal(report.database["version-compatible"], false);
  assert.deepEqual(
    report.database["empty-sources"].toSorted(),
    Object.keys(report.database["source-records"]).toSorted(),
  );
  assert.match(
    dashboardQueryCostMarkdown(report),
    /canonical projection returned no records/,
  );
});

/** Rewrites a snapshot's recorded schema version to simulate lagging data. */
function downgradeSnapshot(database, version) {
  const connection = new DatabaseSync(database);
  connection.prepare("UPDATE __idb_databases SET version = ?").run(version);
  connection.close();
  const reader = new DatabaseSync(database, { readOnly: true });
  const records = Number(reader.prepare("SELECT count(*) AS c FROM __idb_records").get().c);
  reader.close();
  return records;
}

/** Asserts the downloaded snapshot was neither emptied nor upgraded in place. */
function assertSnapshotIntact(database, records, version) {
  const after = new DatabaseSync(database, { readOnly: true });
  assert.equal(Number(after.prepare("SELECT count(*) AS c FROM __idb_records").get().c), records);
  assert.equal(Number(after.prepare("SELECT version FROM __idb_databases").get().version), version);
  after.close();
}

test("benchmark rebuilds an outdated snapshot from the deployed payloads", async (t) => {
  const { root, database } = await syntheticSnapshot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const outdated = DATABASE_VERSION - 1;
  const records = downgradeSnapshot(database, outdated);
  assert.ok(records > 0);
  assert.equal(readSnapshotDatabaseVersion(database), outdated);

  const report = await benchmarkDashboardQueryCost({
    databasePath: database,
    document: dashboardDocument,
    limit: 2,
  });
  assert.equal(report.database["snapshot-version"], outdated);
  assert.equal(report.database["version-compatible"], false);
  // The published snapshot lags the reader after a schema bump, so the
  // authoritative JSONL payloads are re-ingested instead of measuring nothing.
  assert.equal(report.database["rebuilt-from-payloads"], true);
  assert.ok(report.database["records-read"] > 0);
  assert.match(
    dashboardQueryCostMarkdown(report),
    /rebuilt from the deployed JSONL payloads before measuring/,
  );

  assertSnapshotIntact(database, records, outdated);
});

test("benchmark reports an outdated snapshot it cannot rebuild", async (t) => {
  const { root, database } = await syntheticSnapshot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await rm(path.join(root, "gh-aw-logs-shards"), { recursive: true, force: true });
  const outdated = DATABASE_VERSION - 1;
  const records = downgradeSnapshot(database, outdated);

  const report = await benchmarkDashboardQueryCost({
    databasePath: database,
    document: dashboardDocument,
    limit: 2,
  });
  assert.equal(report.database["rebuilt-from-payloads"], false);
  assert.ok(
    dashboardQueryCostMarkdown(report)
      .includes(`written at canonical schema version **${outdated}** but the reader expects **${DATABASE_VERSION}**`),
  );

  // Opening an outdated canonical database rebuilds its stores, so the
  // benchmark must measure a copy and leave the downloaded snapshot intact.
  assertSnapshotIntact(database, records, outdated);
});
