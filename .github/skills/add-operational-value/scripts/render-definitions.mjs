#!/usr/bin/env node

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fail, readJson, requireArgs } from "./common.mjs";
import { validateValueReview } from "./review-value.mjs";

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
const activation = definition.intent?.temporalAnchor === "contract-activation";
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
const chartGuidance = activation
  ? `- The measurement contract was activated on \`${artifact.adoptionAt.split("T")[0]}\`; this is not a workflow adoption date.
- ${mode === "attainment-only" ? "No historical reference has been established." : "Historical references use the same frozen outcome rule, not a claim about workflow installation."}`
  : mode === "attainment-only"
  ? `- Observations begin at workflow adoption on \`${artifact.adoptionAt.split("T")[0]}\`.
- No comparable pre-adoption evidence is available. Complete adjacent post-adoption periods may still show recent change, but not change relative to adoption.`
  : `- The purple dotted line marks workflow adoption on \`${artifact.adoptionAt.split("T")[0]}\`.
- Retained observations to the left are pre-adoption evidence, when available; those to the right are post-adoption evidence. Absence on the left is not a baseline.`;
const comparison = activation
  ? "The frozen goal, acceptance rule and formulas are applied to every observation."
  : mode === "attainment-only"
  ? "The frozen definitions and formulas are applied to every post-adoption observation."
  : "The same definitions and formulas are applied before and after adoption.";
const limitation = activation
  ? "This report measures accepted repository outcomes against the stated goal. Contract activation is not an intervention or proof that an agent caused the outcomes; unavailable historical evidence supports no historical improvement claim."
  : mode === "attainment-only"
  ? "This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow."
  : "A before/after pattern is an association, not proof of causation. Other repository changes may explain some or all of the movement.";
const periodGuidance = artifact.schemaVersion === 3
  ? "Recent change compares the immediately preceding equal-duration period, not lifetime movement. Interval windows must abut without overlap; snapshot values compare cutoff states."
  : "This legacy artifact has no explicit recent-period assessment. Its retained before/after fields must not be reinterpreted as recent movement or accepted without genuine pre-adoption evidence.";
let valueReview = "";
if (artifact.valueReview !== undefined || definition.review !== undefined) {
  validateValueReview(artifact);
  const review = artifact.valueReview;
  const cell = value => String(value ?? "unknown").replaceAll("|", "\\|").replaceAll("\n", " ");
  const number = value => value === null ? "unknown" : Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)));
  const metrics = definition.metrics;
  const latest = `${number(review.current.value)} ${review.current.unit}; ${review.current.status}${review.current.stale ? ", stale" : ""}`;
  const deltaUnit = /^(percent|percentage|%)$/i.test(review.current.unit) ? "percentage points" : review.current.unit;
  const delta = review.recentComparison.status === "available"
    ? `${review.recentComparison.nativeDelta > 0 ? "+" : ""}${number(review.recentComparison.nativeDelta)} ${deltaUnit}`
    : `unavailable: ${review.recentComparison.reason}`;
  const policy = review.decision.policy;
  const basis = policy ? `${policy.basis}; ${policy.periods} complete periods; ${
    [policy.minimum !== undefined ? `minimum ${policy.minimum}` : null,
      policy.maximum !== undefined ? `maximum ${policy.maximum}` : null].filter(Boolean).join(", ")
  } ${metrics.find(metric => metric.id === policy.metricId).unit} of \`${policy.metricId}\`. ${policy.rationale}`
    : "No keep bar has been agreed; native evidence is still reported.";
  const rows = review.periods.slice(-12).map(period => `| ${cell(period.window?.endAt)} | ${
    metrics.map(metric => number(period.metrics[metric.id])).join(" | ")
  } | ${cell(period.eligibleCount)} | ${cell(period.status)}${period.missingReason ? `: ${cell(period.missingReason)}` : ""} |`);
  valueReview = `## Value review

**Assessment:** ${review.decision.status}. ${review.decision.reason}

**Latest repository outcome:** ${latest}

**Measurement:** ${definition.evidence.measurementKind}; ${definition.evidence.window.durationDays}-day window, ${definition.evidence.window.cadenceDays}-day cadence.

**Recent change:** ${delta}

**Review basis:** ${basis}

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | ${metrics.map(metric => `${cell(metric.presentation.legendLabel)} (${cell(metric.unit)})`).join(" | ")} | Eligible opportunities | Evidence |
|---|${metrics.map(() => "---:|").join("")}---:|---|
${rows.join("\n")}

The latest ${Math.min(12, review.periods.length)} periods are shown; the full native series is in the timeline.
Repository attainment includes other actors. Only a separately declared, independently verified contribution measure supports a workflow keep/change recommendation; it is not causal attribution.
Demonstrated workflow-enabled improvements count as shared contribution even when another agent or person implements them. Report measured progress, full goal completion, safeguards and attribution confidence separately. An unknown quality dimension does not cancel independently verified improvement; a merge alone does not verify that improvement.

`;
}
writeFileSync(args[1], `---
title: ${JSON.stringify(`What ${artifact.workflowName} measures`)}
description: ${JSON.stringify(`Definitions, evidence rules, and interpretation for the ${artifact.workflowName} operational-value report.`)}
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

${valueReview}## How to read the timeline

${chartGuidance}
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Execution activity is diagnostic only. It does not prove repository value.
- ${periodGuidance}
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- ${activation ? "Historical reference" : "Adoption"} comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

${definition.intent ? `**Goal:** ${definition.intent.goal}

**Accepted outcome:** ${definition.intent.acceptance}

` : ""}${metricSections}
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
