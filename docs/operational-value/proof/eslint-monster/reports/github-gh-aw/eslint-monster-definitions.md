---
title: "What ESLint Monster measures"
description: "Definitions, evidence rules, and interpretation for the ESLint Monster operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** unknown diagnostics; unavailable

**Measurement:** interval; 7-day window, 7-day cadence.

**Recent change:** unavailable: Fresh complete mature evidence is required for recent movement.

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Repository net (diagnostics) | Linked net (diagnostics) | Observed repository net (diagnostics) | Observed linked net (diagnostics) | Eligible opportunities | Evidence |
|---|---:|---:|---:|---:|---:|---|
| 2026-08-02T15:00:12Z | unknown | 0 | 0 | 0 | unknown | incomplete-evidence |
| 2026-08-09T15:00:12Z | unknown | 0 | 0 | 0 | unknown | incomplete-evidence |
| 2026-08-16T15:00:12Z | unknown | 0 | 0 | 0 | unknown | incomplete-evidence |
| 2026-08-23T15:00:12Z | unknown | unknown | 0 | 0 | unknown | incomplete-evidence |
| 2026-08-30T15:00:12Z | unknown | 0 | 0 | 0 | unknown | incomplete-evidence |
| 2026-09-06T15:00:12Z | unknown | 0 | 0 | 0 | unknown | incomplete-evidence |
| 2026-09-13T15:00:12Z | unknown | 0 | 0 | 0 | unknown | incomplete-evidence |
| 2026-09-20T15:00:12Z | 0 | 0 | 0 | 0 | unknown | incomplete-evidence |
| 2026-09-27T15:00:12Z | unknown | 0 | 0 | 0 | unknown | incomplete-evidence |
| 2026-10-04T15:00:12Z | unknown | 0 | 0 | 0 | unknown | incomplete-evidence |
| 2026-10-11T15:00:12Z | unknown | 0 | 0 | 0 | unknown | incomplete-evidence |
| 2026-10-18T15:00:12Z | unknown | 0 | 0 | 0 | unknown | incomplete-evidence |

The latest 12 periods are shown; the full native series is in the timeline.
Repository attainment includes other actors. Only a separately declared, independently verified contribution measure supports a workflow keep/change recommendation; it is not causal attribution.
Demonstrated workflow-enabled improvements count as shared contribution even when another agent or person implements them. Report measured progress, full goal completion, safeguards and attribution confidence separately. An unknown quality dimension does not cancel independently verified improvement; a merge alone does not verify that improvement.

## How to read the timeline

- Observations begin at workflow adoption on `2026-06-27`.
- No comparable pre-adoption evidence is available. Complete adjacent post-adoption periods may still show recent change, but not change relative to adoption.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Execution activity is diagnostic only. It does not prove repository value.
- Recent change compares the immediately preceding equal-duration period, not lifetime movement. Interval windows must abut without overlap; snapshot values compare cutoff states.
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- Adoption comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

**Goal:** Remediate actionable ESLint factory findings in actions/setup/js, including downstream implementation.

**Accepted outcome:** Partial native facet: signed removal of missing radix diagnostics on global parseInt and Number.parseInt in existing non-test CommonJS files, checked by isolated ESLint 9.39.5 builtin radix/always. No upstream config is loaded. Other radix equivalents, invalid radix values, other factory rules and full validation are not measured.

### Missing-radix diagnostic reductions

- **What it tells you:** Repository net diagnostic reductions. This is a `primary` measure.
- **Native measurement formula:** `Complete before-minus-after native diagnostic counts`
- **Unit:** `diagnostics`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Missing-radix diagnostic reductions

- **What it tells you:** Corroborated net diagnostic reductions. This is a `diagnostic` measure.
- **Native measurement formula:** `Complete before-minus-after native diagnostic counts restricted to independently corroborated workflow-linked merge revisions`
- **Unit:** `diagnostics`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Missing-radix diagnostic reductions

- **What it tells you:** Observed repository diagnostic subtotal. This is a `diagnostic` measure.
- **Native measurement formula:** `Known before-minus-after native diagnostic counts`
- **Unit:** `diagnostics`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Missing-radix diagnostic reductions

- **What it tells you:** Observed corroborated diagnostic subtotal. This is a `diagnostic` measure.
- **Native measurement formula:** `Known before-minus-after native diagnostic counts restricted to independently corroborated workflow-linked merge revisions`
- **Unit:** `diagnostics`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** Immutable modifications to tracked non-test actions/setup/js/*.cjs files after workflow adoption.
- **Collection:** Offline replay of digest-checked, bounded immutable Git source facts and retained shared output lineage.
- **Observation window:** 7 days, sampled every 7 days
- **Maturation delay:** 0 days
- **Filters:** `Only builtin radix missingRadix diagnostics count; this is a strict partial facet of the frozen factory's require-parseInt-radix rule.`; `ESLint 9.39.5; CommonJS, latest supported ECMAScript; no upstream modules, configs, scripts or plugins execute.`; `A separately retained initial plain-object-throw facet has zero known movement; it is not substituted for this radix facet.`; `Signed immutable first-parent changes; additions, deletions, unsupported file modes and JS parse failures remain unknown.`; `Native source diagnostics are partial progress, not full lint, regression, behavior or generator-root-cause acceptance.`; `Corroborated retained output graph joins establish shared contribution, not receipt-verified creation or exclusive causality.`; `Only known effects enter observed subtotals; complete totals remain null across unknown source assessments.`

The frozen definitions and formulas are applied to every post-adoption observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `eslint-monster-timeline.json` artifact.

## Important limitation

This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow.

Value-function SHA-256: `d23b144f47b9a50414e7985669011e3e4d1593384a961b25fd7e4d17df8e3172`
