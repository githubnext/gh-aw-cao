#!/usr/bin/env node
// Merges the per-shard `summary.json` reports produced by the sharded
// "Benchmark deployed dashboard queries" jobs into a single combined
// report, then regenerates the combined `summary.md`.
//
// Usage: node scripts/merge-dashboard-query-performance.mjs <outputDir> <shardDir...>
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  mergeQueryPerformanceReports,
  queryPerformanceMarkdown,
} from "../tests/e2e/dashboard-query-performance-helpers.mjs";

const [outputDir, ...shardDirs] = process.argv.slice(2);
if (!outputDir || shardDirs.length === 0) {
  console.error(
    "Usage: node scripts/merge-dashboard-query-performance.mjs <outputDir> <shardDir...>",
  );
  process.exit(1);
}

const reports = await Promise.all(
  shardDirs.map(async (shardDir) =>
    JSON.parse(await readFile(resolve(shardDir, "summary.json"), "utf8"))
  ),
);
reports.sort((left, right) => (left.shard?.index ?? 1) - (right.shard?.index ?? 1));

const merged = mergeQueryPerformanceReports(reports);
await mkdir(outputDir, { recursive: true });
const jsonPath = resolve(outputDir, "summary.json");
const markdownPath = resolve(outputDir, "summary.md");
await writeFile(jsonPath, `${JSON.stringify(merged, null, 2)}\n`);
await writeFile(markdownPath, queryPerformanceMarkdown(merged));
console.log(`Merged ${reports.length} shard report(s) into ${markdownPath}`);
