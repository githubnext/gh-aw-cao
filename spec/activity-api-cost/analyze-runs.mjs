#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { spawn, spawnSync } from "node:child_process";

function parseArguments(argv) {
  const options = {
    input: "activity-api-cost-data",
    hourlyLimit: 15000,
    reserve: 4000,
    workflowsPerRepository: 1,
    freshRunsPerWorkflow: 10,
    format: "markdown",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === "--input") options.input = value;
    else if (name === "--hourly-limit") options.hourlyLimit = Number(value);
    else if (name === "--reserve") options.reserve = Number(value);
    else if (name === "--workflows-per-repository") options.workflowsPerRepository = Number(value);
    else if (name === "--fresh-runs-per-workflow") options.freshRunsPerWorkflow = Number(value);
    else if (name === "--format") options.format = value;
    else if (name === "--help") {
      console.log("Usage: analyze-runs.mjs [--input DIR|ZIP|JSONL] [--hourly-limit N] [--reserve N] [--workflows-per-repository N] [--fresh-runs-per-workflow N] [--format markdown|json]");
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete option: ${name}`);
    }
    index += 1;
  }
  for (const [name, value] of [
    ["hourly-limit", options.hourlyLimit],
    ["reserve", options.reserve],
    ["workflows-per-repository", options.workflowsPerRepository],
    ["fresh-runs-per-workflow", options.freshRunsPerWorkflow],
  ]) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} must be a non-negative number`);
  }
  if (options.reserve >= options.hourlyLimit) throw new Error("--reserve must be smaller than --hourly-limit");
  if (!["json", "markdown"].includes(options.format)) throw new Error("--format must be markdown or json");
  return options;
}

async function findInputs(input) {
  const resolved = path.resolve(input);
  const inputStat = await stat(resolved);
  if (inputStat.isFile()) return [resolved];
  const found = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.name === "cao-activity-index.zip" || entry.name.endsWith(".jsonl")) found.push(child);
    }
  }
  await visit(resolved);
  return found.sort();
}

function zipEntries(zipPath) {
  const result = spawnSync("unzip", ["-Z1", zipPath], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Unable to list ${zipPath}: ${result.stderr.trim()}`);
  return result.stdout.split("\n").filter(Boolean);
}

function inputStream(file) {
  if (!file.endsWith(".zip")) return { name: file, stream: createReadStream(file) };
  const entries = zipEntries(file);
  const shards = entries.filter((entry) => /(^|\/)gh-aw-logs-shards\/[^/]+\.jsonl$/.test(entry)).sort();
  const entry = shards.at(-1) || entries.find((candidate) => /(^|\/)gh-aw-logs\.jsonl$/.test(candidate));
  if (!entry) throw new Error(`${file} contains neither a log shard nor gh-aw-logs.jsonl`);
  const child = spawn("unzip", ["-p", file, entry], { stdio: ["ignore", "pipe", "inherit"] });
  child.on("exit", (code) => {
    if (code !== 0) child.stdout.destroy(new Error(`unzip exited with status ${code}`));
  });
  return { name: `${file}:${entry}`, stream: child.stdout };
}

async function analyzeInput(file) {
  const source = inputStream(file);
  let bytes = 0;
  let invalidLines = 0;
  let discoverySincePreviousMarker = { workflowQueries: 0, discoveredRuns: 0 };
  let latestDiscovery = { ...discoverySincePreviousMarker };
  let reportsAfterLatestMarker = new Set();
  let sawRateLimitMarker = false;
  const allReports = new Set();
  for await (const line of createInterface({ input: source.stream, crlfDelay: Infinity })) {
    bytes += Buffer.byteLength(line) + 1;
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      invalidLines += 1;
      continue;
    }
    if (row.kind === "workflow_runs") {
      discoverySincePreviousMarker.workflowQueries += 1;
      discoverySincePreviousMarker.discoveredRuns += Array.isArray(row.payload) ? row.payload.length : 0;
    } else if (row.kind === "github_api_rate_limit") {
      latestDiscovery = { ...discoverySincePreviousMarker };
      discoverySincePreviousMarker = { workflowQueries: 0, discoveredRuns: 0 };
      reportsAfterLatestMarker = new Set();
      sawRateLimitMarker = true;
    } else if (row.kind === "run" && row.run?.run_id != null) {
      allReports.add(String(row.run.run_id));
      if (sawRateLimitMarker) reportsAfterLatestMarker.add(String(row.run.run_id));
    }
  }
  const reports = sawRateLimitMarker ? reportsAfterLatestMarker.size : allReports.size;
  const workflowQueries = sawRateLimitMarker ? latestDiscovery.workflowQueries : discoverySincePreviousMarker.workflowQueries;
  const discoveredRuns = sawRateLimitMarker ? latestDiscovery.discoveredRuns : discoverySincePreviousMarker.discoveredRuns;
  return {
    file,
    source: source.name,
    compressedBytes: file.endsWith(".zip") ? (await stat(file)).size : null,
    jsonlBytes: bytes,
    invalidLines,
    workflowQueries,
    discoveredRuns,
    analyzedReports: reports,
    model: {
      lowerBoundPrimaryUnits: workflowQueries + (5 * reports),
      normalPrimaryUnits: (2 * workflowQueries) + (5 * reports),
      conservativeReservedUnits: (2 * workflowQueries) + (9 * reports),
    },
  };
}

const options = parseArguments(process.argv.slice(2));
const analyses = await Promise.all((await findInputs(options.input)).map(analyzeInput));
if (analyses.length === 0) throw new Error(`No cao-activity-index.zip or JSONL files found under ${path.resolve(options.input)}`);
const totals = analyses.reduce((result, analysis) => {
  result.workflowQueries += analysis.workflowQueries;
  result.discoveredRuns += analysis.discoveredRuns;
  result.analyzedReports += analysis.analyzedReports;
  result.normalPrimaryUnits += analysis.model.normalPrimaryUnits;
  return result;
}, { workflowQueries: 0, discoveredRuns: 0, analyzedReports: 0, normalPrimaryUnits: 0 });
const usablePrimaryUnits = options.hourlyLimit - options.reserve;
const observedUnitsPerRun = totals.analyzedReports > 0 ? totals.normalPrimaryUnits / totals.analyzedReports : 5;
const repositoryCost = options.workflowsPerRepository * (2 + (5 * options.freshRunsPerWorkflow));
const prediction = {
  hourlyLimit: options.hourlyLimit,
  reserve: options.reserve,
  usablePrimaryUnits,
  observedUnitsPerRun,
  runsPerRateLimitWindow: Math.floor(usablePrimaryUnits / observedUnitsPerRun),
  scenario: {
    workflowsPerRepository: options.workflowsPerRepository,
    freshRunsPerWorkflow: options.freshRunsPerWorkflow,
    primaryUnitsPerRepository: repositoryCost,
    repositoriesPerRateLimitWindow: repositoryCost > 0 ? Math.floor(usablePrimaryUnits / repositoryCost) : null,
  },
};

if (options.format === "json") {
  console.log(JSON.stringify({ analyses, totals, prediction }, null, 2));
} else {
  console.log("| Input | Workflow queries | Runs discovered | Reports analyzed | ZIP size | Normal primary units |");
  console.log("| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const analysis of analyses) {
    const name = path.basename(path.dirname(analysis.file)) || path.basename(analysis.file);
    const size = analysis.compressedBytes == null ? "n/a" : `${(analysis.compressedBytes / 1_000_000).toFixed(1)} MB`;
    console.log(`| ${name} | ${analysis.workflowQueries} | ${analysis.discoveredRuns} | ${analysis.analyzedReports} | ${size} | ${analysis.model.normalPrimaryUnits} |`);
  }
  console.log(`\nAggregate: ${totals.analyzedReports} reports at ${observedUnitsPerRun.toFixed(2)} modeled primary units/report.`);
  console.log(`Capacity: ${prediction.runsPerRateLimitWindow} fresh reports per rate-limit window with ${usablePrimaryUnits} usable units.`);
  console.log(`Scenario: ${prediction.scenario.repositoriesPerRateLimitWindow} repositories per window at ${repositoryCost} units/repository.`);
}
