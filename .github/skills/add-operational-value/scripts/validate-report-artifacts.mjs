#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { fail, isRepository, isSlug, readJson, requireArgs } from "./common.mjs";

const args = process.argv.slice(2);
requireArgs(args, 1, 2, "validate-report-artifacts.mjs <timeline.json> [definitions.md]");
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
      || (typeof value === "number" && Number.isFinite(value))))
  && Array.isArray(metrics) && metrics.filter(({ role }) => role === "primary").length === 1
  && metrics.every(({ status }) => ["evaluated", "unevaluated"].includes(status))
  && (timeline.runs ?? []).every(({ runId, createdAt }) => runId != null && typeof createdAt === "string");
if (!valid) fail("timeline does not satisfy the artifact contract");

if (args[1]) {
  if (!existsSync(args[1])) fail(`definitions not found: ${args[1]}`);
  const definitions = readFileSync(args[1], "utf8");
  const h1Count = (definitions.match(/^# /gm) ?? []).length;
  const hasFrontmatterTitle = definitions.startsWith("---\n")
    && /^title:\s*.+$/m.test(definitions)
    && definitions.indexOf("\n---\n", 4) > 0;
  if (!(h1Count === 1 || (h1Count === 0 && hasFrontmatterTitle))) {
    fail("definitions must contain one H1 or one frontmatter title");
  }
  for (const heading of ["How to read the timeline", "What was measured", "Evidence rules", "Important limitation"]) {
    if (!definitions.includes(`## ${heading}`)) fail(`definitions are missing ${heading}`);
  }
  if (!definitions.includes("Value-function SHA-256:")) fail("definitions are missing the value-function fingerprint");
}
console.log(`validated ${args.join(", ")}`);
