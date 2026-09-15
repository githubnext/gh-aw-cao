import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { once } from "node:events";
import { pathToFileURL } from "node:url";

const DEFAULT_SAMPLE = resolve("dashboard/site/test/fixtures/gh-aw-logs/cached-v2.jsonl");
// Keep this aligned with the unconditional run event emitters in the gh-aw
// logs adapter: started, agent session, completed, usage, and working set.
const BASE_DERIVED_EVENTS = 5;

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return parsed;
}

async function runTemplate(samplePath) {
  const content = await readFile(samplePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const envelope = JSON.parse(line);
    if (envelope.schema_version === 2 && envelope.kind === "run" && envelope.run) {
      return envelope;
    }
  }
  throw new Error(`${samplePath} does not contain a schema-v2 run record.`);
}

function auditEvents(count, runId, timestamp) {
  const groups = {
    key_findings: [],
    recommendations: [],
    noops: [],
    skill_activations: [],
  };
  const names = Object.keys(groups);
  for (let index = 0; index < count; index += 1) {
    const group = names[index % names.length];
    const identity = `${runId}-${index}`;
    if (group === "key_findings") {
      groups[group].push({ title: `Synthetic finding ${identity}`, severity: index % 7 === 0 ? "high" : "low", timestamp });
    } else if (group === "recommendations") {
      groups[group].push({ action: `Review synthetic recommendation ${identity}`, priority: "normal", timestamp });
    } else if (group === "noops") {
      groups[group].push({ message: `No change required for ${identity}`, status: "success", timestamp });
    } else {
      groups[group].push({ name: `synthetic-skill-${index % 5}`, status: "activated", timestamp });
    }
  }
  return groups;
}

function syntheticRun(template, index, options) {
  const runId = 1_000_000 + index;
  const repositoryIndex = index % options.repositories;
  const workflowIndex = index % options.workflows;
  const completedAt = new Date(options.startedAt - index * 30_000).toISOString();
  const startedAt = new Date(Date.parse(completedAt) - (20 + index % 180) * 1000).toISOString();
  const repository = `synthetic-org/repository-${String(repositoryIndex).padStart(5, "0")}`;
  const workflowName = `Synthetic Agentic Workflow ${String(workflowIndex).padStart(2, "0")}`;
  const conclusion = options.derivedEventsPerRun > BASE_DERIVED_EVENTS && index % 17 === 0
    ? "failure"
    : "success";
  const automaticEvents = BASE_DERIVED_EVENTS + (conclusion === "failure" ? 1 : 0);
  return {
    schema_version: template.schema_version,
    kind: template.kind,
    run: {
      ...template.run,
      run_id: runId,
      run_attempt: 1,
      organization: "synthetic-org",
      repository,
      workflow_name: workflowName,
      workflow_path: `.github/workflows/synthetic-agentic-${String(workflowIndex).padStart(2, "0")}.md`,
      display_title: `${workflowName} · ${repository} · review`,
      event: "workflow_dispatch",
      status: "completed",
      conclusion,
      classification: conclusion,
      created_at: startedAt,
      started_at: startedAt,
      updated_at: completedAt,
      url: `https://github.com/${repository}/actions/runs/${runId}`,
      engine: "copilot",
      engine_id: "copilot",
      model: index % 3 === 0 ? "claude-sonnet-4.5" : "gpt-5",
      token_usage_summary: {
        total_aic: Number((0.5 + (index % 25) / 10).toFixed(1)),
        input_tokens: 2_000 + index % 8_000,
        output_tokens: 200 + index % 1_000,
      },
      working_set: {
        files: 4 + index % 20,
        bytes: 32_768 + (index % 128) * 1024,
      },
      job_details: [{
        id: 2_000_000 + index,
        name: "agent",
        status: "completed",
        conclusion,
        started_at: startedAt,
        completed_at: completedAt,
      }],
      audit: auditEvents(options.derivedEventsPerRun - automaticEvents, runId, completedAt),
    },
  };
}

async function writeLine(stream, line) {
  if (!stream.write(line)) await once(stream, "drain");
}

/**
 * Generates deterministic schema-v2 activity shards without retaining the
 * generated payload in memory.
 */
export async function generateDashboardStressData({
  outputDirectory,
  repositories = 10_000,
  runs = 20_000,
  derivedEventsPerRun = 6,
  shards = 20,
  workflows = 24,
  samplePath = DEFAULT_SAMPLE,
  startedAt = "2026-09-15T12:00:00Z",
} = {}) {
  if (!outputDirectory) throw new TypeError("outputDirectory is required.");
  const options = {
    repositories: positiveInteger(repositories, "repositories"),
    runs: positiveInteger(runs, "runs"),
    derivedEventsPerRun: positiveInteger(derivedEventsPerRun, "derivedEventsPerRun"),
    shards: positiveInteger(shards, "shards"),
    workflows: positiveInteger(workflows, "workflows"),
    startedAt: Date.parse(startedAt),
  };
  if (options.repositories > options.runs) {
    throw new TypeError("repositories cannot exceed runs.");
  }
  if (options.derivedEventsPerRun < BASE_DERIVED_EVENTS) {
    throw new TypeError(`derivedEventsPerRun must be at least ${BASE_DERIVED_EVENTS}.`);
  }
  if (!Number.isFinite(options.startedAt)) throw new TypeError("startedAt must be a valid timestamp.");

  const template = await runTemplate(samplePath);
  await mkdir(outputDirectory, { recursive: true });
  const shardSize = Math.ceil(options.runs / options.shards);
  const files = [];
  for (let shardIndex = 0; shardIndex < options.shards; shardIndex += 1) {
    const firstRun = shardIndex * shardSize;
    const lastRun = Math.min(options.runs, firstRun + shardSize);
    if (firstRun >= lastRun) break;
    const name = `gh-aw-logs-${String(shardIndex).padStart(4, "0")}.jsonl`;
    const path = join(outputDirectory, name);
    const stream = createWriteStream(path, { encoding: "utf8" });
    const hash = createHash("sha256");
    for (let index = firstRun; index < lastRun; index += 1) {
      const line = `${JSON.stringify(syntheticRun(template, index, options))}\n`;
      hash.update(line);
      await writeLine(stream, line);
    }
    stream.end();
    await once(stream, "close");
    files.push({
      name,
      runs: lastRun - firstRun,
      bytes: (await stat(path)).size,
      sha256: hash.digest("hex"),
    });
  }

  const manifest = {
    schemaVersion: 1,
    sample: basename(samplePath),
    repositories: options.repositories,
    runs: options.runs,
    workflows: options.workflows,
    derivedEventsPerRun: options.derivedEventsPerRun,
    expected: {
      repositories: options.repositories,
      runs: options.runs,
      jobs: options.runs,
      sessions: options.runs,
      events: options.runs * options.derivedEventsPerRun,
    },
    files,
  };
  await writeFile(join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const manifest = await generateDashboardStressData({
    outputDirectory: resolve(argument("output", "")),
    repositories: argument("repositories", 10_000),
    runs: argument("runs", 20_000),
    derivedEventsPerRun: argument("derived-events", 6),
    shards: argument("shards", 20),
    workflows: argument("workflows", 24),
    samplePath: resolve(argument("sample", DEFAULT_SAMPLE)),
  });
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
}
