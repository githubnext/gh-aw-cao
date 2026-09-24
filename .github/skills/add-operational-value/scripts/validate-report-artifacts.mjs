#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { fail, isRepository, isSlug, readJson, requireArgs } from "./common.mjs";

const args = process.argv.slice(2);
requireArgs(args, 1, 3, "validate-report-artifacts.mjs <timeline.json> [timeline.svg] [definitions.md]");
if (!existsSync(args[0])) fail(`timeline not found: ${args[0]}`);
const timeline = readJson(args[0]);
const snapshots = timeline.snapshots;
const metrics = timeline.metricReview?.metrics;
const valid = timeline.schemaVersion === 2
  && [2, 3].includes(timeline.definitionSchemaVersion)
  && typeof timeline.generatedAt === "string"
  && isRepository(timeline.repository)
  && isSlug(timeline.workflowSlug)
  && typeof timeline.valueFunction?.path === "string"
  && timeline.valueFunction.path.endsWith(".mjs")
  && /^[0-9a-f]{64}$/.test(timeline.valueFunction.sha256 ?? "")
  && timeline.valueFunction.definition?.schemaVersion === timeline.definitionSchemaVersion
  && timeline.valueFunction.definition?.slug === timeline.workflowSlug
  && ["baseline-comparable", "attainment-only"].includes(timeline.evaluationMode ?? "baseline-comparable")
  && Date.parse(timeline.window?.startAt) < Date.parse(timeline.window?.endAt)
  && Array.isArray(snapshots) && snapshots.length >= 2
  && JSON.stringify(snapshots.map(({ observedAt }) => observedAt))
    === JSON.stringify(snapshots.map(({ observedAt }) => observedAt).toSorted())
  && snapshots.every((snapshot) => snapshot.evidence
    && (timeline.definitionSchemaVersion !== 3
      || (snapshot.window?.startAt && snapshot.window?.endAt
        && Array.isArray(snapshot.provenance) && snapshot.provenance.length > 0))
    && Object.values(snapshot.metrics).every((value) => value === null
      || (typeof value === "number" && value >= 0 && value <= 1)))
  && Array.isArray(metrics) && metrics.filter(({ role }) => role === "primary").length === 1
  && metrics.every(({ status }) => ["evaluated", "unevaluated"].includes(status))
  && (timeline.runs ?? []).every(({ runId, createdAt }) => runId != null && typeof createdAt === "string");
if (!valid) fail("timeline does not satisfy the artifact contract");

if (args[1]) {
  if (!existsSync(args[1])) fail(`SVG not found: ${args[1]}`);
  const svg = readFileSync(args[1], "utf8");
  if (!svg.includes('viewBox="0 0 1280 ')) fail("SVG must use a 1280px viewBox");
  if (!svg.includes("prefers-color-scheme:dark")) fail("SVG must include adaptive dark styling");
  if (!svg.includes(">Goal measure<")) fail("SVG must label the goal-oriented axis");
}
if (args[2]) {
  if (!existsSync(args[2])) fail(`definitions not found: ${args[2]}`);
  const definitions = readFileSync(args[2], "utf8");
  if ((definitions.match(/^# /gm) ?? []).length !== 1) fail("definitions must contain exactly one H1");
  for (const heading of ["How to read the chart", "What was measured", "Evidence rules", "Important limitation"]) {
    if (!definitions.includes(`## ${heading}`)) fail(`definitions are missing ${heading}`);
  }
  if (!definitions.includes("Value-function SHA-256:")) fail("definitions are missing the value-function fingerprint");
}
console.log(`validated ${args.join(", ")}`);
