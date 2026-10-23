/**
 * node --test tests/performance/dashboard-daily-workflow-aggregates.test.mjs
 * CAO_DAILY_WORKFLOW_FULL=1 node --test tests/performance/dashboard-daily-workflow-aggregates.test.mjs
 *
 * Full mode writes 25,000 runs, 1,250,000 tools and 125,000 domains to the
 * production SQLite-backed canonical store. The smaller identical fixture also
 * runs through fake-indexeddb; its timings are NOT browser performance numbers.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { loadDatabaseQuerySources, queryDatabaseSources } from "../../dashboard/site/src/data/queries/database.js";
import {
  countCollections,
  openCanonicalDatabase,
  upsertCanonicalBatchWithConnection,
} from "../../dashboard/site/src/data/storage/indexeddb.js";
import { installSqliteIndexedDB } from "../../dashboard/site/src/data/storage/sqlite-indexeddb.js";

const DAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const WORKFLOWS = 10;
const TOOLS_PER_RUN = 50;
const DOMAINS_PER_RUN = 5;
const SAMPLE_RUNS = 250;
const RUNS_PER_BATCH = 25;
const full = process.env.CAO_DAILY_WORKFLOW_FULL === "1";
const runCount = full ? 25_000 : SAMPLE_RUNS;
const output = path.resolve("test-results/daily-workflow-aggregates");
const maximumWriteDurationMs = Number(process.env.CAO_DAILY_WORKFLOW_MAX_WRITE_MS ?? (full ? 900_000 : 60_000));
assert.ok(Number.isFinite(maximumWriteDurationMs) && maximumWriteDurationMs > 0,
  "CAO_DAILY_WORKFLOW_MAX_WRITE_MS must be positive");
const dailyQuery = [{
  name: "daily-workflow-benchmark",
  from: "daily-workflow-aggregates",
  aggregate: {
    by: ["date"],
    values: [
      { field: "run-count", as: "runs", reducer: "sum" },
      { field: "aic-total-sum", as: "aic", reducer: "sum" },
      { field: "mcp-tool-calls-sum", as: "toolCalls", reducer: "sum" },
    ],
  },
  "order-by": [{ field: "date", direction: "asc" }],
}];

function inventory() {
  return {
    repositories: [{ id: "daily:repository", owner: "benchmark", name: "daily" }],
    workflows: Array.from({ length: WORKFLOWS }, (_, index) => ({
      id: `daily:workflow:${index}`, repositoryId: "daily:repository",
      path: `.github/workflows/daily-${index}.md`, name: `Daily ${index}`,
    })),
  };
}

function workload(offset, length) {
  const batch = { runs: [], tools: [], domains: [] };
  for (let index = offset; index < offset + length; index += 1) {
    const id = `daily:run:${index}`;
    const timestamp = `${DAY}T${String(index % 24).padStart(2, "0")}:00:00.000Z`;
    batch.runs.push({
      id, repositoryId: "daily:repository", workflowId: `daily:workflow:${index % WORKFLOWS}`,
      owner: "benchmark", repository: "daily", workflowPath: `.github/workflows/daily-${index % WORKFLOWS}.md`,
      githubRunId: String(index + 1), attempt: 1, event: "schedule",
      conclusion: index % 5 === 0 ? "failure" : "success",
      startedAt: timestamp, createdAt: timestamp, observedAt: timestamp,
      durationMs: 60_000 + index % 10 * 1_000, aicTotal: 1 + index % 4,
      actionMinutes: 1 + index % 10 / 60, mcpToolCalls: TOOLS_PER_RUN,
      toolCallCount: TOOLS_PER_RUN, domainCount: DOMAINS_PER_RUN,
    });
    for (let child = 0; child < TOOLS_PER_RUN; child += 1) {
      batch.tools.push({
        id: `${id}:tool:${child}`, runId: id, source: "mcp", type: "mcp.tool_call",
        mcpServer: "github", mcpTool: `tool_${child}`, status: "success",
        timestamp, observedAt: timestamp,
      });
    }
    for (let child = 0; child < DOMAINS_PER_RUN; child += 1) {
      batch.domains.push({
        id: `${id}:domain:${child}`, runId: id, domain: `domain-${child}.example`,
        timestamp, observedAt: timestamp,
      });
    }
  }
  return batch;
}

async function analyticalQuery(factory, runs) {
  let reads;
  const sourceStart = performance.now();
  const sources = await queryDatabaseSources(factory, {}, ["daily-workflow-aggregates"], {
    onMetrics: (metrics) => { reads = metrics; },
  });
  const sourceDurationMs = performance.now() - sourceStart;
  assert.equal(sources["daily-workflow-aggregates"].rows.length, WORKFLOWS);
  assert.deepEqual(reads.stores, ["daily_workflow_aggregates", "repositories", "workflows"]);
  assert.equal(reads.recordsRead, 2 * WORKFLOWS + 1, "analytics must read workflow groups and inventory, not run/tool history");
  for (const row of sources["daily-workflow-aggregates"].rows) {
    const workflow = Number(row["workflow-id"].split(":").at(-1));
    let expectedRuns = 0;
    let expectedAic = 0;
    for (let index = workflow; index < runs; index += WORKFLOWS) {
      expectedRuns += 1;
      expectedAic += 1 + index % 4;
    }
    assert.equal(row["run-count"], expectedRuns);
    assert.equal(row["aic-total-sum"], expectedAic);
    assert.equal(row["aic-total-observed-count"], expectedRuns);
    assert.equal(row["mcp-tool-calls-sum"], expectedRuns * TOOLS_PER_RUN);
  }
  const durationsMs = [];
  let rows;
  for (let repeat = 0; repeat < 5; repeat += 1) {
    const startedAt = performance.now();
    const result = await loadDatabaseQuerySources(factory, {}, {
      sourceNames: ["daily-workflow-benchmark"], queries: dailyQuery,
    });
    durationsMs.push(performance.now() - startedAt);
    rows = result["daily-workflow-benchmark"].rows;
    assert.deepEqual(rows, [{
      date: DAY, runs,
      aic: Math.floor(runs / 4) * 10 + Array.from({ length: runs % 4 }, (_, i) => i + 1).reduce((a, b) => a + b, 0),
      toolCalls: runs * TOOLS_PER_RUN,
    }]);
  }
  assert.ok(Math.max(...durationsMs) < 10_000, "daily analytical query exceeded 10 seconds");
  return {
    sourceDurationMs, sourceRecordsRead: reads.recordsRead,
    sourceStores: reads.stores, durationsMs, rows,
  };
}

async function verifyReplacement(factory, runs) {
  const before = await analyticalQuery(factory, runs);
  const database = await openCanonicalDatabase(factory);
  try {
    await upsertCanonicalBatchWithConnection(database, workload(0, RUNS_PER_BATCH), {
      validateRelationships: false,
    });
  } finally {
    database.close();
  }
  const replay = await analyticalQuery(factory, runs);
  assert.deepEqual(replay.rows, before.rows, "replaying identical canonical IDs must not inflate totals");
  const correction = workload(0, 1).runs[0];
  const writer = await openCanonicalDatabase(factory);
  try {
    await upsertCanonicalBatchWithConnection(writer, { runs: [{ ...correction, aicTotal: 99 }] }, {
      validateRelationships: false,
    });
    const corrected = await loadDatabaseQuerySources(factory, {}, {
      sourceNames: ["daily-workflow-benchmark"], queries: dailyQuery,
    });
    assert.deepEqual(corrected["daily-workflow-benchmark"].rows, [{
      ...before.rows[0], aic: before.rows[0].aic + 98,
    }], "a corrected run replaces its contribution without changing run/tool counts");
    await upsertCanonicalBatchWithConnection(writer, { runs: [correction] }, { validateRelationships: false });
  } finally {
    writer.close();
  }
  const source = await queryDatabaseSources(factory, {}, ["daily-workflow-aggregates"]);
  for (const row of source["daily-workflow-aggregates"].rows) {
    assert.equal(row["input-tokens-sum"], null, "missing usage is not a measured zero");
    assert.equal(row["input-tokens-observed-count"], 0);
    assert.equal(row["mcp-tool-calls-observed-count"], runs / WORKFLOWS);
  }
  return before;
}

async function ingest(factory, runs) {
  const database = await openCanonicalDatabase(factory);
  let committedRecords = 0;
  const start = performance.now();
  try {
    await upsertCanonicalBatchWithConnection(database, inventory(), { validateRelationships: false });
    for (let offset = 0; offset < runs; offset += RUNS_PER_BATCH) {
      const result = await upsertCanonicalBatchWithConnection(
        database, workload(offset, Math.min(RUNS_PER_BATCH, runs - offset)),
        { validateRelationships: false, batchSize: 1_000 },
      );
      committedRecords += result.committedRecords;
    }
  } finally {
    database.close();
  }
  const durationMs = performance.now() - start;
  assert.ok(durationMs <= maximumWriteDurationMs,
    `canonical writes took ${durationMs}ms, exceeding ${maximumWriteDurationMs}ms`);
  assert.equal(committedRecords, runs * (1 + TOOLS_PER_RUN + DOMAINS_PER_RUN));
  assert.deepEqual(await countCollections(factory, ["runs", "tools", "domains"]), {
    runs, tools: runs * TOOLS_PER_RUN, domains: runs * DOMAINS_PER_RUN,
  });
  return {
    runs, tools: runs * TOOLS_PER_RUN, domains: runs * DOMAINS_PER_RUN,
    committedRecords, durationMs,
    runsPerSecond: runs * 1_000 / durationMs,
    recordsPerSecond: committedRecords * 1_000 / durationMs,
  };
}

function storage(filename) {
  const connection = new DatabaseSync(filename, { readOnly: true });
  try {
    return connection.prepare(`
      SELECT store_name AS store, count(*) AS records,
        sum(length(CAST(value AS BLOB))) AS jsonBytes
      FROM __idb_records GROUP BY store_name ORDER BY store_name
    `).all().map((row) => ({ ...row }));
  } finally {
    connection.close();
  }
}

test("daily workflow aggregate workload uses real bounded canonical writes", { timeout: 1_200_000 }, async () => {
  await mkdir(output, { recursive: true });
  const filename = path.join(output, `workload-${randomUUID()}.sqlite`);
  const previous = { indexedDB: globalThis.indexedDB, IDBKeyRange: globalThis.IDBKeyRange };
  const report = {
    target: { runsPerDay: 25_000, toolsPerRun: TOOLS_PER_RUN, domainsPerRun: DOMAINS_PER_RUN },
    full,
    limitations: [
      "Synthetic canonical evidence, not artifact download, normalization, or network ingestion.",
      "fake-indexeddb measures a Node correctness harness, not a native browser.",
      "SQLite is the production local adapter, not PostgreSQL; PostgreSQL is not measured here.",
      "Storage JSON bytes exclude index pages; physical database bytes include them.",
      "Write throughput includes bounded fixture generation but excludes opening/provisioning the database.",
    ],
  };
  try {
    const browser = new IDBFactory();
    report.indexedDB = await ingest(browser, SAMPLE_RUNS);
    report.indexedDB.query = await verifyReplacement(browser, SAMPLE_RUNS);
    const sqlite = installSqliteIndexedDB(filename);
    report.sqlite = await ingest(sqlite, runCount);
    report.sqlite.query = await verifyReplacement(sqlite, runCount);
    if (!full) assert.deepEqual(report.sqlite.query.rows, report.indexedDB.query.rows);
    report.sqlite.stores = storage(filename);
    const aggregateStore = report.sqlite.stores.find((entry) => entry.store === "daily_workflow_aggregates");
    const ledgerStore = report.sqlite.stores.find((entry) => entry.store === "daily_workflow_contributions");
    assert.equal(aggregateStore.records, WORKFLOWS);
    assert.equal(ledgerStore.records, runCount);
    assert.ok(aggregateStore.jsonBytes < WORKFLOWS * 4_096, "aggregate storage must not copy raw children");
    assert.ok(ledgerStore.jsonBytes < runCount * 2_048, "contribution ledger must stay compact per run");
    report.sqlite.physicalBytes = (await stat(filename)).size;
    assert.ok(report.sqlite.physicalBytes > 0);
    assert.ok(report.sqlite.recordsPerSecond > 0);
  } finally {
    globalThis.indexedDB = previous.indexedDB;
    globalThis.IDBKeyRange = previous.IDBKeyRange;
    await writeFile(path.join(output, `report-${full ? "full" : "sample"}.json`), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report));
    await rm(filename, { force: true });
    await rm(`${filename}-wal`, { force: true });
    await rm(`${filename}-shm`, { force: true });
  }
});
