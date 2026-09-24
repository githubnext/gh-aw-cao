import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import config from "../playwright/configs/dashboard-query-performance.config.mjs";
import {
  QUERY_CHUNK_SIZE,
  deployedProxyTarget,
  mergeQueryPerformanceReports,
  overviewPhaseBreakdown,
  parseQueryPerformanceShard,
  partitionQueryDefinitions,
  queryPerformanceMarkdown,
  summarizeQueryTiming,
} from "../e2e/dashboard-query-performance-helpers.mjs";

test("dashboard query benchmark runs serially with enough time for deployed data", () => {
  assert.equal(config.workers, 1);
  assert.equal(config.timeout, 1_800_000);
  assert.equal(QUERY_CHUNK_SIZE, 25);
});

test("deployed integration isolates query benchmark reporting from test permissions", () => {
  const workflow = readFileSync(".github/workflows/dashboard-deployed-integration.yml", "utf8");
  assert.match(workflow, /pull_request:\n\s+paths:/);
  assert.match(workflow, /group: dashboard-deployed-integration-\$\{\{[\s\S]*github\.event\.pull_request\.number/);
  assert.match(workflow, /tests\/e2e\/dashboard-deployed-refresh-helpers\.mjs/);
  assert.match(workflow, /tests\/e2e\/dashboard-view-assessment\.mjs/);
  assert.match(workflow, /run: npm run test:performance:dashboard-queries/);
  assert.match(workflow, /test-results\/dashboard-query-performance\//);
  assert.match(workflow, /query-performance:\n[\s\S]*permissions:\n\s+contents: read/);
  assert.match(workflow, /query-performance-comment:\n[\s\S]*needs: query-performance/);
  assert.match(
    workflow,
    /query-performance-comment:[\s\S]*pull-requests: write/,
  );
  assert.match(workflow, /shard: \[1, 2, 3\]/);
  assert.match(workflow, /DASHBOARD_QUERY_PERFORMANCE_SHARD: \$\{\{ matrix\.shard \}\}\/3/);
  assert.match(workflow, /name: dashboard-query-performance-\$\{\{ matrix\.shard \}\}/);
  assert.match(workflow, /pattern: dashboard-query-performance-\*/);
  assert.match(workflow, /scripts\/merge-dashboard-query-performance\.mjs/);
  assert.match(workflow, /dashboard-query-performance-results/);
});

test("deployed proxy targets remain under the trusted dashboard URL", () => {
  const base = "https://githubnext.github.io/gh-aw-cao/cao/";
  assert.equal(
    deployedProxyTarget("/gh-aw-logs-runs/shard.jsonl", base)?.href,
    `${base}gh-aw-logs-runs/shard.jsonl`,
  );
  assert.equal(
    deployedProxyTarget("/https://example.com/private", base)?.origin,
    "https://githubnext.github.io",
  );
  assert.equal(deployedProxyTarget("/../private", base), null);
});

test("dashboard query timing summary distinguishes initial, continuation, and fill timings", () => {
  assert.deepEqual(summarizeQueryTiming({
    name: "recent-runs",
    firstChunkMs: 10.126,
    continuationChunkMs: 4.333,
    fillIterationMs: 20.555,
    rows: 75,
  }), {
    query: "recent-runs",
    rows: 75,
    chunks: 3,
    firstChunkMs: 10.13,
    continuationChunkMs: 4.33,
    fillIterationMs: 20.56,
  });
});

test("dashboard query Markdown keeps unpaginated results explicit", () => {
  const markdown = queryPerformanceMarkdown({
    populateMs: 123.45,
    chunkSize: 25,
    indexedDbCount: {
      durationMs: 3.21,
      stores: 8,
      records: 12345,
      counts: {
        campaigns: 3,
        repositories: 42,
        workflows: 100,
        runs: 12200,
      },
    },
    overview: {
      initialReadyMs: 350.25,
      requestMs: 100,
      worker: {
        databaseMs: 20,
        projectionMs: 30,
        queryMs: 70,
        totalMs: 90,
        recordsRead: 1234,
      },
      slowestSources: [{
        query: "overview-outcome-summary",
        rows: 1,
        firstChunkMs: 75,
      }],
    },
    queries: [{
      query: "repositories",
      rows: 4,
      chunks: 1,
      firstChunkMs: 2.5,
      continuationChunkMs: null,
      fillIterationMs: 2.75,
    }],
  });
  assert.match(markdown, /Population time: \*\*123\.45 ms\*\*/);
  assert.match(markdown, /### IndexedDB count\(\)/);
  assert.match(markdown, /Counted \*\*12,345 records\*\* across \*\*8 stores\*\* in \*\*3\.21 ms\*\*\./);
  assert.match(markdown, /Initial Overview ready: \*\*350\.25 ms\*\*/);
  assert.match(markdown, /Settled deployed-data query: \*\*100\.00 ms\*\* \(1,234 records read\)/);
  assert.match(markdown, /\| Declarative queries \| 40\.00 \| 40\.00% \|/);
  assert.match(markdown, /\| `overview-outcome-summary` \| 75\.00 \| 1 \|/);
  assert.match(markdown, /\n\| `repositories` \| 4 \| 1 \| 2\.50 \| — \| 2\.75 \|\n/);
});

test("overview phase breakdown attributes worker and messaging time", () => {
  assert.deepEqual(overviewPhaseBreakdown({
    requestMs: 100,
    worker: {
      databaseMs: 20,
      projectionMs: 30,
      queryMs: 70,
      totalMs: 90,
    },
  }), [
    { phase: "Declarative queries", durationMs: 40, percent: 40 },
    { phase: "Canonical projection", durationMs: 30, percent: 30 },
    { phase: "IndexedDB reads", durationMs: 20, percent: 20 },
    { phase: "Worker messaging", durationMs: 10, percent: 10 },
  ]);
});

test("query performance shard descriptor parses valid N/M pairs and falls back otherwise", () => {
  assert.deepEqual(parseQueryPerformanceShard("2/3"), { index: 2, total: 3 });
  assert.deepEqual(parseQueryPerformanceShard(undefined), { index: 1, total: 1 });
  assert.deepEqual(parseQueryPerformanceShard("bogus"), { index: 1, total: 1 });
  assert.deepEqual(parseQueryPerformanceShard("0/3"), { index: 1, total: 1 });
  assert.deepEqual(parseQueryPerformanceShard("4/3"), { index: 1, total: 1 });
});

test("query definitions partition into near-even, deterministic, gapless shards", () => {
  const queries = Array.from({ length: 8 }, (_, index) => ({ name: `q${index}` }));
  const shards = [1, 2, 3].map((index) => partitionQueryDefinitions(queries, index, 3));
  assert.deepEqual(shards.map((shard) => shard.length), [3, 3, 2]);
  assert.deepEqual(shards.flat(), queries);
  assert.deepEqual(partitionQueryDefinitions(queries, 1, 1), queries);
});

test("merging a single shard report returns it unchanged", () => {
  const report = { queries: [{ query: "a" }] };
  assert.equal(mergeQueryPerformanceReports([report]), report);
});

test("merging shard reports concatenates queries in shard order and recomputes the slowest overview sources", () => {
  const merged = mergeQueryPerformanceReports([
    {
      shard: { index: 1, total: 2 },
      overview: {
        returnedRows: { "overview-a": 1, "overview-b": 2 },
        slowestSources: [],
      },
      queries: [
        { query: "overview-a", firstChunkMs: 5 },
        { query: "other-1", firstChunkMs: 50 },
      ],
    },
    {
      shard: { index: 2, total: 2 },
      overview: null,
      queries: [
        { query: "overview-b", firstChunkMs: 40 },
        { query: "other-2", firstChunkMs: 1 },
      ],
    },
  ]);
  assert.deepEqual(merged.queries.map(({ query }) => query), [
    "overview-a",
    "other-1",
    "overview-b",
    "other-2",
  ]);
  assert.deepEqual(merged.overview.slowestSources.map(({ query }) => query), [
    "overview-b",
    "overview-a",
  ]);
});
