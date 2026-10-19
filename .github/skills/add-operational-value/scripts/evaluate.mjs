#!/usr/bin/env node

import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { writeJsonArchive } from "./json-archive.mjs";
import {
  deepEqual, fail, importValueModule, isIsoUtc, nowUtc, observationWindows, readJson, repoRoot, run, runJson,
  scriptDir, sha256File, shiftDays, writeJson,
} from "./common.mjs";

function usage() {
  return "usage: evaluate.mjs [--root DIR] [--end ISO-8601] [--output-dir DIR] [--function PATH] [--campaign SLUG] [--runs|--no-runs] [--refresh] OWNER/REPO NAME-OR-PATH";
}

const args = process.argv.slice(2);
let endAt = nowUtc();
let outputRoot = "docs/operational-value/reports";
let valueFunction;
let campaign;
let collectRuns = false;
let refresh = false;
let root = repoRoot;
while (args[0]?.startsWith("-")) {
  const option = args.shift();
  if (option === "--end") endAt = args.shift() ?? fail("--end requires an ISO-8601 timestamp");
  else if (option === "--output-dir") outputRoot = args.shift() ?? fail("--output-dir requires a directory");
  else if (option === "--function") valueFunction = args.shift() ?? fail("--function requires a path");
  else if (option === "--campaign") campaign = args.shift() ?? fail("--campaign requires a slug");
  else if (option === "--no-runs") collectRuns = false;
  else if (option === "--runs") collectRuns = true;
  else if (option === "--refresh") refresh = true;
  else if (option === "--root") root = path.resolve(args.shift() ?? fail("--root requires a directory"));
  else if (["-h", "--help"].includes(option)) {
    console.log(usage());
    process.exit(0);
  } else fail(`unknown option: ${option}`);
}
if (args.length !== 2) fail(usage());
const [repository, workflowInput] = args;
const workflowSlug = path.basename(workflowInput, ".md");
if (campaign && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(campaign)) fail("--campaign requires a valid campaign slug");
process.chdir(root);
const canonicalFunction = run(
  path.join(scriptDir, "value-function-path.mjs"),
  [repository, workflowSlug, ...(campaign ? [campaign] : [])],
).trim();
valueFunction ??= canonicalFunction;
// Preserve the old noncampaign layout without moving existing definitions.
if (!existsSync(valueFunction) && !campaign && valueFunction === canonicalFunction) {
  const legacyFunction = `${workflowSlug}/operational-value/${workflowSlug}.mjs`;
  if (existsSync(legacyFunction)) valueFunction = legacyFunction;
}
if (!existsSync(valueFunction)) fail(`value function not found: ${valueFunction}`);
if (!isIsoUtc(endAt)) fail("--end must use UTC ISO-8601 format: YYYY-MM-DDTHH:MM:SSZ");

const repositoryKey = repository.toLowerCase().replace("/", "-");
const reportDir = path.join(outputRoot, repositoryKey);
const finalTimeline = path.join(reportDir, `${workflowSlug}-timeline.json`);
const finalDefinitions = path.join(reportDir, `${workflowSlug}-definitions.md`);
const finalPulse = path.join(reportDir, `${workflowSlug}-pulse.html`);
const archiveBase = path.join(reportDir, `${workflowSlug}-evidence-archive.json`);
let evidenceArchive = existsSync(`${archiveBase}.gz`) ? `${archiveBase}.gz` : archiveBase;
run(path.join(scriptDir, "verify-value-function.mjs"), [valueFunction]);
const valueModule = await importValueModule(valueFunction);
const definition = valueModule.definition;
if (definition.repository.toLowerCase() !== repository.toLowerCase() || definition.slug !== workflowSlug) {
  fail(`value function does not match ${repository} ${workflowSlug}`);
}
if (collectRuns && (!/^\.github\/workflows\/[^/]+\.(?:md|ya?ml)$/.test(definition.sourcePath)
  || definition.intent?.temporalAnchor === "contract-activation")) {
  fail("--runs requires a workflow source and workflow-adoption context");
}

const mode = definition.evaluation?.mode ?? "baseline-comparable";
const activation = definition.intent?.temporalAnchor === "contract-activation";
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
        && candidate.workflowSlug === workflowSlug && candidate.functions
        && typeof candidate.functions === "object" && !Array.isArray(candidate.functions)) archive = candidate;
    else fail("preserved evidence archive has an invalid schema or scope");
  } catch (error) {
    fail(`cannot read preserved evidence archive: ${error.message}`);
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
const windows = observationWindows(definition, startAt, endAt, [...archived, ...priorSnapshots]);
const keyFor = ({ observedAt, windowStart, windowEnd, window }) => [
  observedAt, windowStart ?? window.startAt, windowEnd ?? window.endAt,
].join("|");
const cache = new Map((refresh ? [] : [...archived, ...priorSnapshots]).map((snapshot) => [keyFor(snapshot), {
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

const work = mkdtempSync(path.join(root, ".aw-value-evaluate."));
try {
  const postAdoption = snapshots.filter(snapshot => Date.parse(snapshot.window.startAt) >= Date.parse(definition.adoption.adoptedAt));
  const primaryId = definition.metrics.find(metric => metric.role === "primary").id;
  const continuous = definition.evidence.measurementKind !== "interval"
    || postAdoption.length > 0
      && Date.parse(postAdoption[0].window.startAt) === Date.parse(definition.adoption.adoptedAt)
      && Date.parse(postAdoption.at(-1).window.endAt)
        === Date.parse(shiftDays(endAt, -definition.evidence.window.maturationDays))
      && postAdoption.every((snapshot, index) => !index
        || Date.parse(postAdoption[index - 1].window.endAt) === Date.parse(snapshot.window.startAt));
  const completeFromAdoption = continuous && postAdoption.length > 0 && postAdoption.every(snapshot =>
    valueModule.scoreMetric(primaryId, snapshot.evidence) !== null
      && Date.parse(snapshot.observedAt) >= Date.parse(shiftDays(snapshot.window.endAt, definition.evidence.window.maturationDays))
      && !["missing", "partial", "unknown"].includes(snapshot.evidence.coverageStatus));
  const observations = path.join(work, "observations.json");
  writeFileSync(observations, writeJson({
    generatedAt: nowUtc(),
    repository,
    workflowName: definition.workflowName,
    adoptionAt: definition.adoption.adoptedAt,
    evaluationMode: mode,
    window: { startAt, endAt },
    evidenceCoverage: {
      completeFromAdoption,
      hasPreAdoptionBaseline: preAdoptionPeriods > 0,
      baselineDescription: mode === "attainment-only"
        ? activation
          ? "No historical reference has been established; observations begin at contract activation."
          : "No pre-adoption comparison is included; observations begin at adoption."
        : `${preAdoptionPeriods} cadence-aligned observations precede adoption. The adoption commit first parent is ${definition.adoption.baselineCommit ?? "unavailable"}.`,
      reason: mode === "attainment-only"
        ? activation ? "Prospective goal contract without an established historical reference."
          : "No comparable pre-adoption outcome evaluation is established for this contract."
        : null,
    },
    snapshots,
    runs,
    caveat: activation
      ? "The evidence measures repository outcomes against a frozen goal, not the causal impact of an agent or contract activation."
      : mode === "attainment-only"
      ? "The evidence measures post-adoption attainment only; without a comparable pre-adoption baseline it cannot establish improvement or causation."
      : "The evidence is observational and does not establish that workflow adoption caused an outcome change.",
  }));
  const timeline = path.join(work, `${workflowSlug}-timeline.json`);
  const definitions = path.join(work, `${workflowSlug}-definitions.md`);
  const pulse = path.join(work, `${workflowSlug}-pulse.html`);
  run(path.join(scriptDir, "build-timeline.mjs"), [valueFunction, observations, timeline]);
  run(path.join(scriptDir, "render-definitions.mjs"), [timeline, definitions]);
  run(path.join(scriptDir, "validate-report-artifacts.mjs"), [timeline, definitions]);
  run(path.join(scriptDir, "render-pulse.mjs"), [timeline, pulse]);
  if (sha256File(valueFunction) !== initialSha) fail("value function changed during deterministic evaluation");

  const builtTimeline = readJson(timeline);
  const previous = archive.functions?.[initialSha]?.snapshots ?? [];
  const combined = [...previous, ...builtTimeline.snapshots.filter((snapshot) =>
    definition.metrics.some(metric => snapshot.metrics[metric.id] !== null))];
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
  const archiveJson = writeJson(archive, 0);
  const compressArchive = Buffer.byteLength(archiveJson) > 256 * 1024;
  const archiveOutput = path.join(work, `${workflowSlug}-evidence-archive.json${compressArchive ? ".gz" : ""}`);
  const archiveFiles = writeJsonArchive(archiveOutput, archive, {
    spacing: 0, gzipLevel: 9, maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512,
  });
  const timelineFiles = writeJsonArchive(timeline, builtTimeline, {
    spacing: 0, maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512,
  });
  const previousArchive = evidenceArchive;
  evidenceArchive = `${archiveBase}${compressArchive ? ".gz" : ""}`;
  mkdirSync(reportDir, { recursive: true });
  for (const [source, destination] of [
    ...timelineFiles.map(file => [file, path.join(reportDir, path.basename(file))]),
    [definitions, finalDefinitions],
    [pulse, finalPulse],
    [pulse.replace(/\.html$/, ".json"), finalPulse.replace(/\.html$/, ".json")],
    ...archiveFiles.map(file => [file, path.join(reportDir, path.basename(file))]),
  ]) {
    copyFileSync(source, destination);
  }
  if (previousArchive !== evidenceArchive && existsSync(previousArchive)) rmSync(previousArchive);
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`Timeline: ${finalTimeline}`);
console.log(`Definitions: ${finalDefinitions}`);
console.log(`Interactive pulse: ${finalPulse}`);
console.log(`Evidence archive: ${evidenceArchive}`);
