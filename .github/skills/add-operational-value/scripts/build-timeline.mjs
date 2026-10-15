#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  fail, importValueModule, nowUtc, readJson, requireArgs, run, scriptDir, sha256File, writeJson,
} from "./common.mjs";

const args = process.argv.slice(2);
requireArgs(args, 3, 3, "build-timeline.mjs <value-function.mjs> <observations.json> <timeline.json>");
const [valueFunction, observationsFile, output] = args;
if (!existsSync(observationsFile)) fail(`observations not found: ${observationsFile}`);
run(path.join(scriptDir, "verify-value-function.mjs"), [valueFunction]);
const initialSha = sha256File(valueFunction);
const valueModule = await importValueModule(valueFunction);
const definition = valueModule.definition;
const observations = readJson(observationsFile);
const valid = typeof observations.repository === "string"
  && isFinite(Date.parse(observations.window?.startAt))
  && Date.parse(observations.window.startAt) < Date.parse(observations.window.endAt)
  && observations.evidenceCoverage && typeof observations.evidenceCoverage === "object"
  && Array.isArray(observations.snapshots)
  && observations.snapshots.length >= 1
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
    const value = valueModule.scoreMetric(metric.id, snapshot.evidence);
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
      fail(`${metric.id} returned an invalid native value for snapshot ${index}`);
    }
    metricValues[metric.id] = value;
  }
  return { ...snapshot, metrics: metricValues };
});
const mode = definition.evaluation?.mode ?? "baseline-comparable";
const baselineAt = Date.parse(definition.adoption.baselineAt ?? definition.adoption.adoptedAt);
const periodOrder = (left, right) =>
  Date.parse(left.window?.endAt ?? left.observedAt) - Date.parse(right.window?.endAt ?? right.observedAt)
  || Date.parse(left.observedAt) - Date.parse(right.observedAt);
const beforeSnapshot = mode === "baseline-comparable"
  ? snapshots.filter((snapshot) => Date.parse(snapshot.window?.endAt ?? snapshot.observedAt) <= baselineAt)
    .toSorted(periodOrder).at(-1)
  : null;
const afterSnapshot = snapshots.toSorted(periodOrder).at(-1);
const last = afterSnapshot.metrics;
const improvement = (metric, before, after) => {
  if (before === null || after === null) return null;
  if (metric.direction === "increase") return after - before;
  if (metric.direction === "decrease") return before - after;
  return Number.isFinite(metric.target)
    ? Math.abs(before - metric.target) - Math.abs(after - metric.target) : null;
};
const kind = definition.evidence.measurementKind;
const coverage = (snapshot) => snapshot?.evidence.coverageStatus
  ?? (kind === "snapshot" && snapshot?.evidence.valid === true ? "complete" : "unknown");
const complete = (snapshot) => snapshot
  && Date.parse(snapshot.observedAt) <= Date.parse(observations.window.endAt)
  && coverage(snapshot) === "complete"
  && snapshot.evidence.maturityStatus !== "interim"
  && snapshot.evidence.maturityStatus !== "unavailable"
  && snapshot.evidence.dubious !== true
  && duration(snapshot) === definition.evidence.window.durationDays * 86_400_000;
const duration = (snapshot) => Date.parse(snapshot?.window?.endAt) - Date.parse(snapshot?.window?.startAt);
const reference = snapshots.findLast((snapshot) => snapshot !== afterSnapshot
  && Date.parse(snapshot.window?.endAt) === Date.parse(afterSnapshot.window?.startAt)
  && duration(snapshot) === duration(afterSnapshot));
const comparison = (metric, before, after, reason) => {
  const beforeValue = before?.metrics[metric.id] ?? null;
  const afterValue = after?.metrics[metric.id] ?? null;
  const eligible = !reason && complete(before) && complete(after)
    && beforeValue !== null && afterValue !== null
    && ["interval", "snapshot"].includes(kind);
  return {
    status: eligible ? "available" : "unavailable",
    reason: reason ?? (eligible ? null : "Incomplete, provisional or unverified period evidence."),
    referenceWindow: before?.window ?? null,
    currentWindow: after?.window ?? null,
    referenceValue: beforeValue,
    currentValue: afterValue,
    nativeDelta: eligible ? afterValue - beforeValue : null,
    directionAwareGain: eligible ? improvement(metric, beforeValue, afterValue) : null,
    referenceDenominator: before?.evidence[metric.rollup?.denominatorField] ?? null,
    currentDenominator: after?.evidence[metric.rollup?.denominatorField] ?? null,
    populationChanged: before?.evidence.populationDigest && after?.evidence.populationDigest
      ? before.evidence.populationDigest !== after.evidence.populationDigest : null,
  };
};
const reviewMetrics = definition.metrics.map((metric) => {
  const after = last[metric.id] ?? null;
  const assessmentAge = Date.parse(observations.window.endAt) - Date.parse(afterSnapshot.observedAt);
  const stale = !Number.isFinite(assessmentAge) || assessmentAge < 0
    || assessmentAge >= definition.evidence.window.cadenceDays * 86_400_000;
  const postAdoption = Date.parse(kind === "snapshot"
    ? afterSnapshot.window?.endAt : afterSnapshot.window?.startAt) >= Date.parse(definition.adoption.adoptedAt);
  return {
    ...metric,
    status: after !== null ? "evaluated" : "unevaluated",
    currentValue: after,
    recentComparison: comparison(metric, reference, afterSnapshot,
      stale ? "The latest assessment is stale or future relative to the analysis endpoint."
        : reference ? null : "The immediately preceding equal-duration period is unavailable."),
    adoptionComparison: comparison(metric, beforeSnapshot, afterSnapshot,
      stale ? "The latest assessment is stale or future relative to the analysis endpoint."
        : mode === "attainment-only" || !beforeSnapshot
        ? "No accepted pre-adoption reference."
        : !postAdoption ? "The current period is not wholly post-adoption."
          : duration(beforeSnapshot) !== duration(afterSnapshot) ? "Measurement durations differ." : null),
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
  schemaVersion: 3,
  definitionSchemaVersion: definition.schemaVersion,
  generatedAt: existingGeneratedAt ?? nowUtc(),
  workflowSlug: definition.slug,
  sourcePath: definition.sourcePath,
  valueFunction: { path: valueFunction, sha256: initialSha, definition },
  metricReview: {
    comparisonPolicy: "adjacent-period-v1",
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
