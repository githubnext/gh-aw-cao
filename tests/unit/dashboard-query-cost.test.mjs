import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";
import { dashboardQueryCostMarkdown, estimateRetainedBytes, selectCostlyQueries } from "../helpers/dashboard-query-cost.mjs";
import { authoritativeDashboard as dashboardDocument } from "../helpers/authoritative-dashboard.mjs";
import { postgresQueryCostMarkdown } from "../helpers/dashboard-query-cost-report.mjs";

const CANDIDATE_LIMIT = 10;

test("static query cost evaluator picks the highest ranked queries to investigate", () => {
  const { candidates, analysis } = selectCostlyQueries(dashboardDocument, CANDIDATE_LIMIT);
  assert.equal(candidates.length, Math.min(CANDIDATE_LIMIT, analysis.ranking.length));
  assert.deepEqual(
    candidates.map(({ name }) => name),
    analysis.ranking.slice(0, CANDIDATE_LIMIT).map(({ name }) => name),
  );
  assert.deepEqual(
    candidates.map(({ rank }) => rank),
    candidates.map((_, index) => index + 1),
  );
  for (const candidate of candidates) {
    assert.ok(candidate["static-total-row-read-units"] >= candidate["static-direct-row-read-units"]);
    assert.ok(candidate["webgpu-filter"]?.status);
  }
});

test("candidate limit must be a positive integer", () => {
  assert.throws(() => selectCostlyQueries(dashboardDocument, 0), TypeError);
  assert.throws(() => selectCostlyQueries(dashboardDocument, 1.5), TypeError);
});

test("cost report identifies WebGPU potential without claiming a measured speedup", () => {
  const { candidates } = selectCostlyQueries({
    dashboard: { queries: [
      { name: "attempts", from: "runs", filter: { predicates: [{ field: "run-attempt", equals: 1 }] } },
    ] },
  }, 1);
  const report = {
    dashboard: "example",
    queries: 1, candidates: 1,
    database: {
      path: "snapshot", sources: 1, "records-read": 4100,
      "duration-ms": 1, "source-records": { runs: 4100 },
      "empty-sources": [], "version-compatible": true,
    },
    "static-model": "normalized-upper-bound",
    "static-materialize-all-row-read-units": 2,
    measurements: [{
      ...candidates[0], query: "attempts", rows: 1000, status: "available",
      "input-row-total": 4100, operations: 4100, "duration-ms": 5,
      "result-bytes": 100, "bytes-per-row": 1,
      "retained-heap-bytes": 100, "execution-heap-bytes": 100, "heap-measured": true,
    }],
    "most-costly-by-time": ["attempts"], "most-costly-by-memory": ["attempts"],
  };
  const markdown = dashboardQueryCostMarkdown(report);
  assert.match(markdown, /\| `attempts` \| `runs` \(potentially-large\) \| unknown \| `run-attempt` \| 1 \|/);
  assert.match(markdown, /CPU timings below are not GPU speedup measurements/);
  report.measurements[0]["webgpu-filter"] = {
    ...candidates[0]["webgpu-filter"],
    "input-rows": 2000,
    "input-cardinality": "below-threshold",
  };
  assert.match(dashboardQueryCostMarkdown(report), /\| `runs` \(potentially-large\) \| below-threshold \(2,000 rows\) \|/);
});

test("retained byte estimate counts shared rows once", () => {
  const row = { name: "run", value: 12 };
  const single = estimateRetainedBytes([row]);
  assert.ok(single > 0);
  assert.equal(estimateRetainedBytes([row, row]), single + 8);
  assert.ok(estimateRetainedBytes([row, { ...row }]) > estimateRetainedBytes([row, row]));
});

test("deployed integration runs both SQLite and Postgres query cost benchmarks", async () => {
  const workflow = await readFile(".github/workflows/dashboard-deployed-integration.yml", "utf8");
  assert.match(workflow, /tests\/performance\/dashboard-query-cost\.test\.mjs/);
  assert.match(workflow, /tests\/performance\/dashboard-query-cost-postgres\.test\.mjs/);
  assert.match(workflow, /tests\/helpers\/dashboard-query-cost\.mjs/);
  assert.match(workflow, /run: npm run dashboard:data:download/);
  assert.match(workflow, /run: npm run test:performance:dashboard-query-cost/);
  assert.match(workflow, /run: npm run test:performance:dashboard-query-cost-postgres/);
  assert.match(workflow, /image: postgres:16-alpine/);
  assert.match(workflow, /go -C server build -o \.\.\/\.tmp\/cao-dashboard/);
  assert.match(workflow, /name: dashboard-query-cost\n/);
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(
    manifest.scripts["test:performance:dashboard-query-cost"],
    "node --expose-gc --test tests/performance/dashboard-query-cost.test.mjs",
  );
  assert.equal(
    manifest.scripts["test:performance:dashboard-query-cost-postgres"],
    "node --test tests/performance/dashboard-query-cost-postgres.test.mjs",
  );
});

test("Postgres query cost report includes Go measurements", () => {
  const report = {
    records: 42,
    measurements: [{
      query: "test-query", rows: 2, "duration-ms": 1.25,
      metrics: { operations: 12, peakWorkingRows: 7, retainedBytes: 128 },
    }],
  };
  const markdown = postgresQueryCostMarkdown(report, [{ name: "test-query", rank: 1 }]);
  assert.match(markdown, /Postgres \+ Go/);
  assert.match(markdown, /\| `test-query` \| 1 \| 2 \| 12 \| 1\.25 \| 7 \| 128 \|/);
});

test("deployed integration reports the query cost report in a pull request comment", async () => {
  const workflow = parse(await readFile(".github/workflows/dashboard-deployed-integration.yml", "utf8"));
  const job = workflow.jobs["query-cost-comment"];
  assert.ok(job, "expected a query-cost-comment job");
  assert.deepEqual(job.needs, "query-cost");
  assert.match(job.if, /github\.event_name == 'pull_request'/);
  assert.match(job.if, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.deepEqual(job.permissions, { actions: "read", "pull-requests": "write" });
  const download = job.steps.find((step) => step.uses?.startsWith("actions/download-artifact@"));
  assert.equal(download.with.name, "dashboard-query-cost");
  const comment = job.steps.find((step) => step.uses?.startsWith("actions/github-script@"));
  assert.match(comment.with.script, /<!-- dashboard-query-cost-results -->/);
  assert.match(comment.with.script, /summary\.md/);
  assert.match(comment.with.script, /<details><summary><b>SQLite query cost report<\/b><\/summary>/);
  assert.match(comment.with.script, /summary,[\s\S]*?<\/details>/);
  assert.match(comment.with.script, /<details><summary><b>Postgres query cost report<\/b><\/summary>/);
  assert.match(comment.with.script, /postgres,[\s\S]*?<\/details>/);
  assert.match(comment.with.script, /sqlite=success/);
  assert.match(comment.with.script, /postgres=success/);
  assert.match(comment.with.script, /issues\.createComment/);
  assert.match(comment.with.script, /issues\.updateComment/);
});
