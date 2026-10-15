#!/usr/bin/env node

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fail, readJson, requireArgs } from "./common.mjs";

const args = process.argv.slice(2);
requireArgs(args, 2, 2, "render-definitions.mjs <timeline.json> <definitions.md>");
if (!existsSync(args[0])) fail(`timeline not found: ${args[0]}`);
const artifact = readJson(args[0]);
if (![2, 3].includes(artifact.schemaVersion) || ![2, 3].includes(artifact.definitionSchemaVersion)
    || artifact.snapshots?.length < 1 || artifact.metricReview?.metrics?.length < 1) {
  fail("timeline does not satisfy the definitions artifact contract");
}
const slug = path.basename(args[0], "-timeline.json");
const mode = artifact.evaluationMode ?? "baseline-comparable";
const definition = artifact.valueFunction.definition;
const direction = {
  increase: "Higher values are better.",
  decrease: "Lower values are better.",
  maintain: "Staying near the established level is better.",
  target: "Values closer to the declared target are better.",
};
const metricSections = artifact.metricReview.metrics.map((metric) => `### ${metric.presentation.name ?? metric.name}

- **What it tells you:** ${metric.name}. This is a \`${metric.role}\` measure.
- **Native measurement formula:** \`${metric.formula}\`
- **Unit:** \`${metric.unit}\`
- **Goal:** ${direction[metric.direction]}
- **Chart display:** The chart shows the native value directly on a metric-specific axis.
`).join("\n");
const chartGuidance = mode === "attainment-only"
  ? `- Observations begin at workflow adoption on \`${artifact.adoptionAt.split("T")[0]}\`.
- No comparable pre-adoption evidence is available. Complete adjacent post-adoption periods may still show recent change, but not change relative to adoption.`
  : `- The purple dotted line marks workflow adoption on \`${artifact.adoptionAt.split("T")[0]}\`.
- Retained observations to the left are pre-adoption evidence, when available; those to the right are post-adoption evidence. Absence on the left is not a baseline.`;
const comparison = mode === "attainment-only"
  ? "The frozen definitions and formulas are applied to every post-adoption observation."
  : "The same definitions and formulas are applied before and after adoption.";
const limitation = mode === "attainment-only"
  ? "This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow."
  : "A before/after pattern is an association, not proof of causation. Other repository changes may explain some or all of the movement.";
const periodGuidance = artifact.schemaVersion === 3
  ? "Recent change compares the immediately preceding equal-duration period, not lifetime movement since adoption. Interval windows must abut without overlap; snapshot values compare cutoff states."
  : "This legacy artifact has no explicit recent-period assessment. Its retained before/after fields must not be reinterpreted as recent movement or accepted without genuine pre-adoption evidence.";
writeFileSync(args[1], `---
title: What ${artifact.workflowName} measures
description: Definitions, evidence rules, and interpretation for the ${artifact.workflowName} operational-value report.
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether the workflow caused the observed changes.

## How to read the timeline

${chartGuidance}
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Workflow runs show execution activity only. They do not prove repository value.
- ${periodGuidance}
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- Adoption comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

${metricSections}
## Evidence rules

- **Repository:** \`${artifact.repository}\`
- **Evidence population:** ${definition.evidence.opportunity}
- **Collection:** ${definition.evidence.collection}
- **Observation window:** ${definition.evidence.window.durationDays} days, sampled every ${definition.evidence.window.cadenceDays} days
- **Maturation delay:** ${definition.evidence.window.maturationDays} days
- **Filters:** ${definition.evidence.filters.map((item) => `\`${item}\``).join("; ")}

${comparison} The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent \`${slug}-timeline.json\` artifact.

## Important limitation

${limitation}

Value-function SHA-256: \`${artifact.valueFunction.sha256}\`
`);
console.log(`wrote ${args[1]}`);
