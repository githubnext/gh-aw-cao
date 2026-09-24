#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  fail, nowUtc, readJson, requireArgs, run, runValueFunction, scriptDir, sha256File, writeJson,
} from "./common.mjs";

const args = process.argv.slice(2);
requireArgs(args, 3, 3, "build-timeline.mjs <value-function.mjs> <observations.json> <timeline.json>");
const [valueFunction, observationsFile, output] = args;
if (!existsSync(observationsFile)) fail(`observations not found: ${observationsFile}`);
run(path.join(scriptDir, "verify-value-function.mjs"), [valueFunction]);
const initialSha = sha256File(valueFunction);
const definition = JSON.parse(runValueFunction(valueFunction, ["--definition"]));
const observations = readJson(observationsFile);
const valid = typeof observations.repository === "string"
  && isFinite(Date.parse(observations.window?.startAt))
  && Date.parse(observations.window.startAt) < Date.parse(observations.window.endAt)
  && observations.evidenceCoverage && typeof observations.evidenceCoverage === "object"
  && Array.isArray(observations.snapshots) && observations.snapshots.length >= 2
  && observations.snapshots.every((item) => item.evidence && typeof item.evidence === "object"
    && (definition.schemaVersion !== 3 || (item.window?.startAt && item.window?.endAt
      && Array.isArray(item.provenance) && item.provenance.length > 0)))
  && JSON.stringify(observations.snapshots.map(({ observedAt }) => observedAt))
    === JSON.stringify(observations.snapshots.map(({ observedAt }) => observedAt).toSorted())
  && Array.isArray(observations.runs ?? []);
if (!valid) fail("observations do not satisfy the collection contract");

const snapshots = observations.snapshots.map((snapshot, index) => {
  const metricValues = {};
  for (const metric of definition.metrics) {
    const value = JSON.parse(runValueFunction(
      valueFunction,
      ["--metric", metric.id],
      `${JSON.stringify(snapshot.evidence)}\n`,
    ));
    if (value !== null && (typeof value !== "number" || value < 0 || value > 1)) {
      fail(`${metric.id} returned an invalid score for snapshot ${index}`);
    }
    metricValues[metric.id] = value;
  }
  return { ...snapshot, metrics: metricValues };
});
const first = snapshots[0].metrics;
const last = snapshots.at(-1).metrics;
const mode = definition.evaluation?.mode ?? "baseline-comparable";
const reviewMetrics = definition.metrics.map((metric) => {
  const before = mode === "attainment-only" ? null : (first[metric.id] ?? null);
  const after = last[metric.id] ?? null;
  return {
    ...metric,
    status: ((mode === "attainment-only" && after !== null) || (before !== null && after !== null))
      ? "evaluated" : "unevaluated",
    beforeValue: before,
    afterValue: after,
    attainmentValue: mode === "attainment-only" ? after : null,
    improvement: before === null || after === null ? null : after - before,
  };
});
const {
  schemaVersion: _schemaVersion,
  definitionSchemaVersion: _definitionSchemaVersion,
  generatedAt: existingGeneratedAt,
  workflowSlug: _workflowSlug,
  sourcePath: _sourcePath,
  valueFunction: _valueFunction,
  metricReview: _metricReview,
  summary: _summary,
  snapshots: _snapshots,
  ...base
} = observations;
const timeline = {
  ...base,
  schemaVersion: 2,
  definitionSchemaVersion: definition.schemaVersion,
  generatedAt: existingGeneratedAt ?? nowUtc(),
  workflowSlug: definition.slug,
  sourcePath: definition.sourcePath,
  valueFunction: { path: valueFunction, sha256: initialSha, definition },
  metricReview: {
    architecture: definition.model.architecture,
    recommendation: definition.model.recommendation,
    presentation: definition.model.presentation,
    metrics: reviewMetrics,
  },
  summary: definition.summary,
  snapshots,
  runs: observations.runs ?? [],
};
if (sha256File(valueFunction) !== initialSha) fail("value function changed while building the timeline");
mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
writeFileSync(output, writeJson(timeline));
run(path.join(scriptDir, "validate-report-artifacts.mjs"), [output]);
console.log(`wrote ${output}`);
