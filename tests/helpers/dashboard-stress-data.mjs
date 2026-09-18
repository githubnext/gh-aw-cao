import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const DEFAULT_SAMPLE = resolve("dashboard/site/test/fixtures/gh-aw-logs/cached-v2.jsonl");
// Keep this aligned with the unconditional run event emitters in the gh-aw
// logs adapter: started, agent session, completed, usage, and working set.
const BASE_DERIVED_EVENTS = 5;
const MAX_DERIVED_EVENTS = 100;
const MAX_TEMPLATES = 256;
const MAX_RUNS = 1_000_000;
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const RUN_CONCLUSIONS = new Set([
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
  "success",
  "timed_out",
]);

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return parsed;
}

function boundedNumber(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= maximum ? parsed : fallback;
}

function categoricalAlias(kind, value) {
  if (value === undefined || value === null || value === "") return "unknown";
  const bucket = Number.parseInt(createHash("sha256").update(String(value)).digest("hex").slice(0, 2), 16) % 32;
  return `${kind}-${String(bucket).padStart(2, "0")}`;
}

function increment(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function sortedCounts(counts) {
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  ));
}

function observedModel(run) {
  return run.model ?? run.resolved_model ?? run.model_id ?? run.aw_info?.model;
}

function observedEngine(run) {
  return run.engine ?? run.engine_id ?? run.aw_info?.engine_name ?? run.aw_info?.engine_id;
}

function observedConclusion(run) {
  return RUN_CONCLUSIONS.has(run.conclusion) ? run.conclusion : "unknown";
}

function templateScore(envelope) {
  return createHash("sha256").update(JSON.stringify(envelope)).digest("hex");
}

function syntheticJobName(name) {
  const normalized = String(name ?? "").toLowerCase();
  for (const role of ["orchestrator", "worker", "agent", "setup"]) {
    if (normalized.includes(role)) return role;
  }
  return "job";
}

function inspectedTemplate(envelope) {
  const run = envelope.run;
  const startedAt = Date.parse(run.started_at ?? run.created_at);
  const completedAt = Date.parse(run.updated_at);
  const durationMs = Number.isFinite(startedAt)
    && Number.isFinite(completedAt)
    && completedAt >= startedAt
    && completedAt - startedAt <= MAX_DURATION_MS
    ? completedAt - startedAt
    : null;
  const sourceUsage = run.token_usage_summary ?? run.token_usage ?? {};
  const sourceWorkingSet = run.working_set ?? {};
  const sourceJob = run.job_details?.[0] ?? run.jobs?.[0] ?? {};
  return {
    conclusion: observedConclusion(run),
    engine: categoricalAlias("engine", observedEngine(run)),
    model: categoricalAlias("model", observedModel(run)),
    durationMs,
    jobName: syntheticJobName(sourceJob.name),
    tokenUsage: {
      totalAic: boundedNumber(sourceUsage.total_aic ?? run.aic, 1, 1_000_000),
      inputTokens: boundedNumber(sourceUsage.input_tokens, 2_000, 100_000_000),
      outputTokens: boundedNumber(sourceUsage.output_tokens, 200, 100_000_000),
    },
    workingSet: {
      files: boundedNumber(sourceWorkingSet.files, 4, 1_000_000),
      bytes: boundedNumber(sourceWorkingSet.bytes, 32_768, 1_000_000_000_000),
    },
    auditGroups: observedAuditGroups(run),
  };
}

async function sampleFiles(samplePath) {
  const metadata = await stat(samplePath);
  if (metadata.isFile()) return [samplePath];
  if (!metadata.isDirectory()) throw new Error(`${samplePath} is not a file or directory.`);
  return (await readdir(samplePath))
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .map((name) => join(samplePath, name));
}

async function inspectSamples(samplePath) {
  const templates = [];
  const profile = {
    sourceRuns: 0,
    retainedTemplates: 0,
    conclusions: {},
    engines: {},
    models: {},
    fieldPresence: {
      jobs: 0,
      tokenUsage: 0,
      workingSet: 0,
      audit: 0,
    },
    durationSeconds: { minimum: null, maximum: null, mean: null },
  };
  let durationTotal = 0;
  let durationCount = 0;
  for (const path of await sampleFiles(samplePath)) {
    const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const line of lines) {
      lineNumber += 1;
      if (!line.trim()) continue;
      let envelope;
      try {
        envelope = JSON.parse(line);
      } catch {
        throw new Error(`${path}:${lineNumber} must contain valid JSON.`);
      }
      if (envelope.schema_version !== 2 || envelope.kind !== "run" || !envelope.run) continue;
      const run = envelope.run;
      profile.sourceRuns += 1;
      increment(profile.conclusions, observedConclusion(run));
      increment(profile.engines, categoricalAlias("engine", observedEngine(run)));
      increment(profile.models, categoricalAlias("model", observedModel(run)));
      if ((run.job_details?.length ?? run.jobs?.length ?? 0) > 0) profile.fieldPresence.jobs += 1;
      if (run.token_usage_summary ?? run.token_usage ?? run.aic) profile.fieldPresence.tokenUsage += 1;
      if (run.working_set) profile.fieldPresence.workingSet += 1;
      if (run.audit) profile.fieldPresence.audit += 1;
      const startedAt = Date.parse(run.started_at ?? run.created_at);
      const completedAt = Date.parse(run.updated_at);
      if (Number.isFinite(startedAt) && Number.isFinite(completedAt) && completedAt >= startedAt) {
        const duration = (completedAt - startedAt) / 1000;
        durationTotal += duration;
        durationCount += 1;
        profile.durationSeconds.minimum = Math.min(profile.durationSeconds.minimum ?? duration, duration);
        profile.durationSeconds.maximum = Math.max(profile.durationSeconds.maximum ?? duration, duration);
      }
      const candidate = { score: templateScore(envelope), template: inspectedTemplate(envelope) };
      templates.push(candidate);
      templates.sort((left, right) => left.score.localeCompare(right.score));
      if (templates.length > MAX_TEMPLATES) templates.pop();
    }
  }
  if (profile.sourceRuns === 0) {
    throw new Error(`${samplePath} does not contain a schema-v2 run record.`);
  }
  profile.retainedTemplates = templates.length;
  profile.conclusions = sortedCounts(profile.conclusions);
  profile.engines = sortedCounts(profile.engines);
  profile.models = sortedCounts(profile.models);
  profile.durationSeconds.mean = durationCount === 0
    ? null
    : Number((durationTotal / durationCount).toFixed(2));
  return { templates: templates.map(({ template }) => template), profile };
}

function observedAuditGroups(run) {
  const audit = run.audit && typeof run.audit === "object" ? run.audit : {};
  return [
    "key_findings",
    "observability_insights",
    "recommendations",
    "missing_tools",
    "missing_data",
    "noops",
    "mcp_failures",
    "skill_activations",
  ].filter((name) => Array.isArray(audit[name]) && audit[name].length > 0);
}

function auditEvents(count, runId, timestamp, template) {
  const groups = {
    key_findings: [],
    observability_insights: [],
    recommendations: [],
    missing_tools: [],
    missing_data: [],
    noops: [],
    mcp_failures: [],
    skill_activations: [],
  };
  const names = [...template.auditGroups];
  if (names.length === 0) names.push("key_findings", "recommendations", "noops", "skill_activations");
  for (let index = 0; index < count; index += 1) {
    const group = names[index % names.length];
    const identity = `${runId}-${index}`;
    if (group === "key_findings") {
      groups[group].push({ title: `Synthetic finding ${identity}`, severity: index % 7 === 0 ? "high" : "low", timestamp });
    } else if (group === "recommendations") {
      groups[group].push({ action: `Review synthetic recommendation ${identity}`, priority: "normal", timestamp });
    } else if (group === "noops") {
      groups[group].push({ message: `No change required for ${identity}`, status: "success", timestamp });
    } else if (group === "skill_activations") {
      groups[group].push({ name: `synthetic-skill-${index % 5}`, status: "activated", timestamp });
    } else if (group === "observability_insights") {
      groups[group].push({ title: `Synthetic insight ${identity}`, severity: "info", timestamp });
    } else if (group === "missing_tools") {
      groups[group].push({ tool: `synthetic-tool-${index % 5}`, status: "missing", timestamp });
    } else if (group === "missing_data") {
      groups[group].push({ data_type: `synthetic-data-${index % 5}`, status: "missing", timestamp });
    } else {
      groups[group].push({ server_name: `synthetic-server-${index % 5}`, status: "failure", timestamp });
    }
  }
  return groups;
}

function syntheticRun(template, index, options) {
  const runId = 1_000_000 + index;
  const repositoryIndex = index % options.repositories;
  const workflowIndex = index % options.workflows;
  const completedAt = new Date(options.startedAt - index * 30_000).toISOString();
  const durationMs = template.durationMs !== null
    ? template.durationMs
    : (20 + index % 180) * 1000;
  const startedAt = new Date(Date.parse(completedAt) - durationMs).toISOString();
  const repository = `synthetic-org/repository-${String(repositoryIndex).padStart(5, "0")}`;
  const workflowName = `Synthetic Agentic Workflow ${String(workflowIndex).padStart(2, "0")}`;
  const conclusion = template.conclusion;
  const automaticEvents = BASE_DERIVED_EVENTS + (conclusion === "failure" ? 1 : 0);
  return {
    schema_version: 2,
    kind: "run",
    run: {
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
      engine: template.engine,
      engine_id: template.engine,
      model: template.model,
      token_usage_summary: {
        total_aic: template.tokenUsage.totalAic,
        input_tokens: template.tokenUsage.inputTokens,
        output_tokens: template.tokenUsage.outputTokens,
      },
      working_set: {
        files: template.workingSet.files,
        bytes: template.workingSet.bytes,
      },
      job_details: [{
        id: 2_000_000 + index,
        name: template.jobName,
        status: "completed",
        conclusion,
        started_at: startedAt,
        completed_at: completedAt,
      }],
      audit: auditEvents(options.derivedEventsPerRun - automaticEvents, runId, completedAt, template),
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
  if (options.workflows > options.runs) {
    throw new TypeError("workflows cannot exceed runs.");
  }
  if (options.shards > options.runs) {
    throw new TypeError("shards cannot exceed runs.");
  }
  if (options.runs > MAX_RUNS) {
    throw new TypeError(`runs must be at most ${MAX_RUNS}.`);
  }
  if (options.derivedEventsPerRun < BASE_DERIVED_EVENTS) {
    throw new TypeError(`derivedEventsPerRun must be at least ${BASE_DERIVED_EVENTS}.`);
  }
  if (options.derivedEventsPerRun > MAX_DERIVED_EVENTS) {
    throw new TypeError(`derivedEventsPerRun must be at most ${MAX_DERIVED_EVENTS}.`);
  }
  if (!Number.isFinite(options.startedAt)) throw new TypeError("startedAt must be a valid timestamp.");

  const inspected = await inspectSamples(samplePath);
  if (options.derivedEventsPerRun === BASE_DERIVED_EVENTS && inspected.profile.conclusions.failure) {
    throw new TypeError("derivedEventsPerRun must be at least 6 when sampled data contains failed runs.");
  }
  await mkdir(outputDirectory, { recursive: true });
  for (const name of await readdir(outputDirectory)) {
    if (/^gh-aw-logs-\d+\.jsonl$/.test(name)) await rm(join(outputDirectory, name));
  }
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
      const template = inspected.templates[index % inspected.templates.length];
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
    sample: "schema-v2-run-data",
    sampleProfile: inspected.profile,
    repositories: options.repositories,
    runs: options.runs,
    workflows: options.workflows,
    derivedEventsPerRun: options.derivedEventsPerRun,
    expected: {
      repositories: options.repositories,
      runs: options.runs,
      audits: options.runs * options.derivedEventsPerRun,
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
