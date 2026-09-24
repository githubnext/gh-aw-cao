#!/usr/bin/env node

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fail, readJson, requireArgs } from "./common.mjs";

const args = process.argv.slice(2);
requireArgs(args, 2, 2, "render-definitions.mjs <timeline.json> <definitions.md>");
if (!existsSync(args[0])) fail(`timeline not found: ${args[0]}`);
const artifact = readJson(args[0]);
if (artifact.schemaVersion !== 2 || ![2, 3].includes(artifact.definitionSchemaVersion)
    || artifact.snapshots?.length < 2 || artifact.metricReview?.metrics?.length < 1) {
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
- **Normalized scoring formula:** \`${metric.formula}\`
- **Goal:** ${direction[metric.direction]}
- **Chart display:** ${metric.presentation.transform === "complement"
    ? "The chart shows `1 - normalized score` so improvement follows the workflow goal downward."
    : "The chart shows the normalized score directly."}
`).join("\n");
const chartGuidance = mode === "attainment-only"
  ? `- Observations begin at workflow adoption on \`${artifact.adoptionAt.split("T")[0]}\`.
- No comparable pre-adoption evidence is available, so the chart shows attainment rather than improvement.`
  : `- The purple dotted line marks workflow adoption on \`${artifact.adoptionAt.split("T")[0]}\`.
- The left side is pre-adoption evidence; the right side is post-adoption evidence.`;
const comparison = mode === "attainment-only"
  ? "The frozen definitions and formulas are applied to every post-adoption observation."
  : "The same definitions and formulas are applied before and after adoption.";
const limitation = mode === "attainment-only"
  ? "This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow."
  : "A before/after pattern is an association, not proof of causation. Other repository changes may explain some or all of the movement.";
writeFileSync(args[1], `---
title: What ${artifact.workflowName} measures
description: Definitions, evidence rules, and interpretation for the ${artifact.workflowName} operational-value report.
---

This page explains the chart in plain language. It defines what was measured; it does not decide whether the workflow caused the observed changes.

![${artifact.workflowName} outcome measures ${mode === "attainment-only" ? "after adoption" : "before and after adoption"}](${slug}-timeline.svg)

## How to read the chart

${chartGuidance}
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Workflow runs show execution activity only. They do not prove repository value.

## What was measured

${metricSections}
## Evidence rules

- **Repository:** \`${artifact.repository}\`
- **Evidence population:** ${definition.evidence.opportunity}
- **Collection:** ${definition.evidence.collection}
- **Observation window:** ${definition.evidence.window.durationDays} days, sampled every ${definition.evidence.window.cadenceDays} days
- **Maturation delay:** ${definition.evidence.window.maturationDays} days
- **Filters:** ${definition.evidence.filters.map((item) => `\`${item}\``).join("; ")}

${comparison} The structured evidence, exact snapshots, provenance, and normalized scores are recorded in the adjacent \`${slug}-timeline.json\` artifact.

## Important limitation

${limitation}

Value-function SHA-256: \`${artifact.valueFunction.sha256}\`
`);
console.log(`wrote ${args[1]}`);
