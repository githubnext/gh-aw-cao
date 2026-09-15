import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const DEFAULT_SAMPLE = resolve("dashboard/site/test/fixtures/gh-aw-logs/cached-v2.jsonl");
// Keep this aligned with the unconditional run event emitters in the gh-aw
// logs adapter: started, agent session, completed, usage, and working set.
const BASE_DERIVED_EVENTS = 5;
const MAX_TEMPLATES = 256;

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return parsed;
}

function increment(counts, value) {
  const key = value === undefined || value === null || value === "" ? "unknown" : String(value);
  counts[key] = (counts[key] ?? 0) + 1;
}

function observedModel(run) {
  return run.model ?? run.resolved_model ?? run.model_id ?? run.aw_info?.model;
}

function observedEngine(run) {
  return run.engine ?? run.engine_id ?? run.aw_info?.engine_name ?? run.aw_info?.engine_id;
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
      increment(profile.conclusions, run.conclusion);
      increment(profile.engines, observedEngine(run));
      increment(profile.models, observedModel(run));
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
      const candidate = { score: templateScore(envelope), envelope };
      templates.push(candidate);
      templates.sort((left, right) => left.score.localeCompare(right.score));
      if (templates.length > MAX_TEMPLATES) templates.pop();
    }
  }
  if (profile.sourceRuns === 0) {
    throw new Error(`${samplePath} does not contain a schema-v2 run record.`);
  }
  profile.retainedTemplates = templates.length;
  profile.durationSeconds.mean = durationCount === 0
    ? null
    : Number((durationTotal / durationCount).toFixed(2));
  return { templates: templates.map(({ envelope }) => envelope), profile };
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
  const names = observedAuditGroups(template.run);
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
  const source = template.run;
  const runId = 1_000_000 + index;
  const repositoryIndex = index % options.repositories;
  const workflowIndex = index % options.workflows;
  const completedAt = new Date(options.startedAt - index * 30_000).toISOString();
  const observedDuration = Date.parse(source.updated_at) - Date.parse(source.started_at ?? source.created_at);
  const durationMs = Number.isFinite(observedDuration) && observedDuration >= 0
    ? observedDuration
    : (20 + index % 180) * 1000;
  const startedAt = new Date(Date.parse(completedAt) - durationMs).toISOString();
  const repository = `synthetic-org/repository-${String(repositoryIndex).padStart(5, "0")}`;
  const workflowName = `Synthetic Agentic Workflow ${String(workflowIndex).padStart(2, "0")}`;
  const observedConclusion = typeof source.conclusion === "string" && source.conclusion.trim()
    ? source.conclusion
    : "unknown";
  const conclusion = observedConclusion === "failure" && options.derivedEventsPerRun === BASE_DERIVED_EVENTS
    ? "success"
    : observedConclusion;
  const automaticEvents = BASE_DERIVED_EVENTS + (conclusion === "failure" ? 1 : 0);
  const sourceJob = source.job_details?.[0] ?? source.jobs?.[0] ?? {};
  const sourceUsage = source.token_usage_summary ?? source.token_usage ?? {};
  const sourceWorkingSet = source.working_set ?? {};
  return {
    schema_version: template.schema_version,
    kind: template.kind,
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
      engine: source.engine ?? source.aw_info?.engine_name ?? "copilot",
      engine_id: source.engine_id ?? source.aw_info?.engine_id ?? "copilot",
      model: observedModel(source) ?? "auto",
      token_usage_summary: {
        total_aic: Number(sourceUsage.total_aic ?? source.aic ?? 1),
        input_tokens: Number(sourceUsage.input_tokens ?? 2_000),
        output_tokens: Number(sourceUsage.output_tokens ?? 200),
      },
      working_set: {
        files: Number(sourceWorkingSet.files ?? 4),
        bytes: Number(sourceWorkingSet.bytes ?? 32_768),
      },
      job_details: [{
        id: 2_000_000 + index,
        name: syntheticJobName(sourceJob.name),
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
  if (options.derivedEventsPerRun < BASE_DERIVED_EVENTS) {
    throw new TypeError(`derivedEventsPerRun must be at least ${BASE_DERIVED_EVENTS}.`);
  }
  if (!Number.isFinite(options.startedAt)) throw new TypeError("startedAt must be a valid timestamp.");

  const inspected = await inspectSamples(samplePath);
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
    sample: basename(samplePath),
    sampleProfile: inspected.profile,
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
