#!/usr/bin/env node

import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  deepEqual, fail, importValueModule, isIsoUtc, nowUtc, readJson, repoRoot, run, runJson,
  scriptDir, sha256File, shiftDays, writeJson,
} from "./common.mjs";

function usage() {
  return "usage: evaluate.mjs [--end ISO-8601] [--output-dir DIR] [--function PATH] [--campaign SLUG] [--no-runs] [--refresh] OWNER/REPO WORKFLOW-NAME-OR-PATH";
}

const args = process.argv.slice(2);
let endAt = nowUtc();
let outputRoot = "docs/operational-value/reports";
let valueFunction;
let campaign;
let collectRuns = true;
let refresh = false;
while (args[0]?.startsWith("-")) {
  const option = args.shift();
  if (option === "--end") endAt = args.shift() ?? fail("--end requires an ISO-8601 timestamp");
  else if (option === "--output-dir") outputRoot = args.shift() ?? fail("--output-dir requires a directory");
  else if (option === "--function") valueFunction = args.shift() ?? fail("--function requires a path");
  else if (option === "--campaign") campaign = args.shift() ?? fail("--campaign requires a slug");
  else if (option === "--no-runs") collectRuns = false;
  else if (option === "--refresh") refresh = true;
  else if (["-h", "--help"].includes(option)) {
    console.log(usage());
    process.exit(0);
  } else fail(`unknown option: ${option}`);
}
if (args.length !== 2) fail(usage());
const [repository, workflowInput] = args;
const workflowSlug = path.basename(workflowInput, ".md");
if (campaign && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(campaign)) fail("--campaign requires a valid campaign slug");
process.chdir(repoRoot);
const canonicalFunction = run(
  path.join(scriptDir, "value-function-path.mjs"),
  [repository, workflowSlug, ...(campaign ? [campaign] : [])],
).trim();
valueFunction ??= canonicalFunction;
if (!existsSync(valueFunction)) fail(`value function not found: ${valueFunction}`);
if (!isIsoUtc(endAt)) fail("--end must use UTC ISO-8601 format: YYYY-MM-DDTHH:MM:SSZ");

const repositoryKey = repository.toLowerCase().replace("/", "-");
const reportDir = path.join(outputRoot, repositoryKey);
const finalTimeline = path.join(reportDir, `${workflowSlug}-timeline.json`);
const finalSvg = path.join(reportDir, `${workflowSlug}-timeline.svg`);
const finalDefinitions = path.join(reportDir, `${workflowSlug}-definitions.md`);
const evidenceArchive = path.join(reportDir, `${workflowSlug}-evidence-archive.json`);
run(path.join(scriptDir, "verify-value-function.mjs"), [valueFunction]);
const valueModule = await importValueModule(valueFunction);
const definition = valueModule.definition;
if (definition.repository.toLowerCase() !== repository.toLowerCase() || definition.slug !== workflowSlug) {
  fail(`value function does not match ${repository} ${workflowSlug}`);
}

const mode = definition.evaluation?.mode ?? "baseline-comparable";
const preAdoptionPeriods = mode === "attainment-only" ? 0 : 3;
const startAt = mode === "attainment-only"
  ? definition.adoption.adoptedAt
  : shiftDays(definition.adoption.adoptedAt, -definition.evidence.window.cadenceDays * preAdoptionPeriods);
if (Date.parse(endAt) <= Date.parse(startAt)) fail(`evaluation end must follow ${startAt}`);
const initialSha = sha256File(valueFunction);
let archive = { schemaVersion: 1, repository, workflowSlug, functions: {} };
if (existsSync(evidenceArchive)) {
  try {
    const candidate = readJson(evidenceArchive);
    if (candidate.schemaVersion === 1 && candidate.repository.toLowerCase() === repository.toLowerCase()
        && candidate.workflowSlug === workflowSlug) archive = candidate;
  } catch {
    // An invalid cache is ignored and replaced only after successful collection.
  }
}
const archived = archive.functions?.[initialSha]?.snapshots ?? [];
let priorSnapshots = [];
if (!refresh && existsSync(finalTimeline)) {
  try {
    const timeline = readJson(finalTimeline);
    const sameContract = deepEqual(timeline.valueFunction?.definition, definition);
    if ((timeline.valueFunction?.sha256 === initialSha || sameContract)
        && timeline.repository.toLowerCase() === repository.toLowerCase()
        && timeline.workflowSlug === workflowSlug) {
      priorSnapshots = timeline.snapshots ?? [];
    }
  } catch {
    // An invalid report is not a cache hit.
  }
}
const cadenceMs = definition.evidence.window.cadenceDays * 86_400_000;
const scheduled = [];
for (let at = Date.parse(startAt); at <= Date.parse(endAt); at += cadenceMs) {
  scheduled.push(new Date(at).toISOString().replace(".000Z", "Z"));
}
if (scheduled.at(-1) !== endAt) scheduled.push(endAt);
const observationTimes = [...new Set([
  ...scheduled,
  ...archived.map(({ observedAt }) => observedAt).filter((value) => value <= endAt),
  ...priorSnapshots.map(({ observedAt }) => observedAt).filter((value) => value <= endAt),
])].toSorted();
if (observationTimes.length < 2) fail("at least two observation times are required");
const windows = observationTimes.map((observedAt) => {
  const windowEnd = shiftDays(observedAt, -definition.evidence.window.maturationDays);
  return {
    observedAt,
    windowStart: shiftDays(windowEnd, -definition.evidence.window.durationDays),
    windowEnd,
  };
});
const keyFor = ({ observedAt, windowStart, windowEnd, window }) => [
  observedAt, windowStart ?? window.startAt, windowEnd ?? window.endAt,
].join("|");
const cache = new Map([...archived, ...priorSnapshots].map((snapshot) => [keyFor(snapshot), {
  evidence: snapshot.evidence,
  provenance: snapshot.provenance,
  ...(snapshot.commit ? { commit: snapshot.commit } : {}),
}]));
const missing = windows.filter((window) => !cache.has(keyFor(window)));
if (missing.length > 0) {
  let collected;
  try {
    collected = await valueModule.collectBatch(missing);
  } catch (error) {
    fail(`collector failed: ${error.message}`);
  }
  const valid = Array.isArray(collected) && collected.length === missing.length
    && collected.every((item) => item.evidence && typeof item.evidence === "object"
      && Array.isArray(item.provenance) && item.provenance.length > 0
      && item.provenance.every((entry) => typeof entry.repository === "string"
        && typeof entry.kind === "string" && entry.kind && typeof entry.ref === "string" && entry.ref));
  if (!valid) fail("collector returned invalid or incomplete evidence");
  missing.forEach((window, index) => cache.set(keyFor(window), collected[index]));
}
const snapshots = windows.map((window) => {
  const collection = cache.get(keyFor(window));
  return {
    observedAt: window.observedAt,
    window: { startAt: window.windowStart, endAt: window.windowEnd },
    evidence: collection.evidence,
    provenance: collection.provenance,
    ...(collection.commit ? { commit: collection.commit } : {}),
  };
});

let runs = [];
if (collectRuns) {
  const workflowFile = path.basename(definition.sourcePath.replace(/\.md$/, ".lock.yml"));
  try {
    const pages = runJson("gh", [
      "api", "--method", "GET", "--paginate", "--slurp",
      "-f", "per_page=100", "-f", `created=${startAt}..${endAt}`,
      `repos/${repository}/actions/workflows/${workflowFile}/runs`,
    ]);
    runs = pages.flatMap((page) => page.workflow_runs ?? [])
      .filter((item) => item.created_at >= startAt && item.created_at <= endAt)
      .map((item) => ({
        runId: item.id,
        createdAt: item.created_at,
        conclusion: item.conclusion ?? "unknown",
        url: item.html_url,
      }))
      .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt) || left.runId - right.runId);
  } catch {
    console.error(`warning: no Actions workflow found for ${workflowFile}; continuing without run context`);
  }
}

const work = mkdtempSync(path.join(repoRoot, ".aw-value-evaluate."));
try {
  const observations = path.join(work, "observations.json");
  writeFileSync(observations, writeJson({
    generatedAt: nowUtc(),
    repository,
    workflowName: definition.workflowName,
    adoptionAt: definition.adoption.adoptedAt,
    evaluationMode: mode,
    window: { startAt, endAt },
    evidenceCoverage: {
      completeFromAdoption: true,
      hasPreAdoptionBaseline: preAdoptionPeriods > 0,
      baselineDescription: mode === "attainment-only"
        ? "No comparable pre-adoption baseline is available; observations begin at adoption."
        : `${preAdoptionPeriods} cadence-aligned observations precede adoption. The adoption commit first parent is ${definition.adoption.baselineCommit ?? "unavailable"}.`,
      reason: mode === "attainment-only" ? "Comparable historical outcome evidence cannot be reconstructed." : null,
    },
    snapshots,
    runs,
    caveat: mode === "attainment-only"
      ? "The evidence measures post-adoption attainment only; without a comparable pre-adoption baseline it cannot establish improvement or causation."
      : "The evidence is observational and does not establish that workflow adoption caused an outcome change.",
  }));
  const timeline = path.join(work, `${workflowSlug}-timeline.json`);
  const svg = path.join(work, `${workflowSlug}-timeline.svg`);
  const definitions = path.join(work, `${workflowSlug}-definitions.md`);
  run(path.join(scriptDir, "build-timeline.mjs"), [valueFunction, observations, timeline]);
  run(path.join(scriptDir, "render-timeline-svg.mjs"), [timeline, svg]);
  run(path.join(scriptDir, "render-definitions.mjs"), [timeline, definitions]);
  run(path.join(scriptDir, "validate-report-artifacts.mjs"), [timeline, svg, definitions]);
  if (sha256File(valueFunction) !== initialSha) fail("value function changed during deterministic evaluation");

  const builtTimeline = readJson(timeline);
  const primary = definition.metrics.find(({ role }) => role === "primary").id;
  const previous = archive.functions?.[initialSha]?.snapshots ?? [];
  const combined = [...previous, ...builtTimeline.snapshots.filter((snapshot) => snapshot.metrics[primary] !== null)];
  const unique = new Map(combined.map((snapshot) => [keyFor(snapshot), snapshot]));
  const currentSnapshots = [...unique.values()];
  const currentByKey = new Map(currentSnapshots.map((snapshot) => [keyFor(snapshot), snapshot]));
  const retainedFunctions = Object.fromEntries(
    Object.entries(archive.functions ?? {}).filter(([sha, entry]) => (
      sha === initialSha
      || !entry.snapshots.every((snapshot) => {
        const current = currentByKey.get(keyFor(snapshot));
        return current && deepEqual(current, snapshot);
      })
    )),
  );
  archive = {
    ...archive,
    schemaVersion: 1,
    repository,
    workflowSlug,
    functions: {
      ...retainedFunctions,
      [initialSha]: { valueFunctionSha256: initialSha, snapshots: currentSnapshots },
    },
  };
  const archiveOutput = path.join(work, `${workflowSlug}-evidence-archive.json`);
  writeFileSync(archiveOutput, writeJson(archive));
  mkdirSync(reportDir, { recursive: true });
  for (const [source, destination] of [
    [timeline, finalTimeline],
    [svg, finalSvg],
    [definitions, finalDefinitions],
    [archiveOutput, evidenceArchive],
  ]) {
    copyFileSync(source, destination);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`Timeline: ${finalTimeline}`);
console.log(`SVG: ${finalSvg}`);
console.log(`Definitions: ${finalDefinitions}`);
console.log(`Evidence archive: ${evidenceArchive}`);
