---
title: "What Tidy measures"
description: "Definitions, evidence rules, and interpretation for the Tidy operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** 1 files; complete

**Measurement:** interval; 7-day window, 7-day cadence.

**Recent change:** +1 files

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Repository net repairs (files) | Linked net repairs (files) | Observed source repairs (files) | Observed linked repairs (files) | Eligible opportunities | Evidence |
|---|---:|---:|---:|---:|---:|---|
| 2026-08-02T15:00:12Z | 0 | 0 | 0 | 0 | unknown | complete |
| 2026-08-09T15:00:12Z | 0 | 0 | 0 | 0 | unknown | complete |
| 2026-08-16T15:00:12Z | 0 | 0 | 0 | 0 | unknown | complete |
| 2026-08-23T15:00:12Z | 0 | 0 | 0 | 0 | unknown | complete |
| 2026-08-30T15:00:12Z | 0 | 0 | 0 | 0 | unknown | complete |
| 2026-09-06T15:00:12Z | 0 | 0 | 0 | 0 | unknown | complete |
| 2026-09-13T15:00:12Z | 0 | 0 | 0 | 0 | unknown | complete |
| 2026-09-20T15:00:12Z | 0 | 0 | 0 | 0 | unknown | complete |
| 2026-09-27T15:00:12Z | 0 | 0 | 0 | 0 | unknown | complete |
| 2026-10-04T15:00:12Z | 0 | 0 | 0 | 0 | unknown | complete |
| 2026-10-11T15:00:12Z | 0 | 0 | 0 | 0 | unknown | complete |
| 2026-10-18T15:00:12Z | 1 | 0 | 1 | 0 | unknown | complete |

The latest 12 periods are shown; the full native series is in the timeline.
Repository attainment includes other actors. Only a separately declared, independently verified contribution measure supports a workflow keep/change recommendation; it is not causal attribution.
Demonstrated workflow-enabled improvements count as shared contribution even when another agent or person implements them. Report measured progress, full goal completion, safeguards and attribution confidence separately. An unknown quality dimension does not cancel independently verified improvement; a merge alone does not verify that improvement.

## How to read the timeline

- Observations begin at workflow adoption on `2025-09-26`.
- No comparable pre-adoption evidence is available. Complete adjacent post-adoption periods may still show recent change, but not change relative to adoption.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Execution activity is diagnostic only. It does not prove repository value.
- Recent change compares the immediately preceding equal-duration period, not lifetime movement. Interval windows must abut without overlap; snapshot values compare cutoff states.
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- Adoption comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

**Goal:** Keep code formatted and clean through conservative formatting and lint repairs.

**Accepted outcome:** Partial facet: existing non-generated Go files become the exact canonical gofmt output without other source edits. Count signed repairs and exact reversals; JavaScript formatting, other lint rules, behavior and full tests remain separate.

### Exact Go formatting repairs

- **What it tells you:** Repository exact go formatting repairs. This is a `primary` measure.
- **Native measurement formula:** `exact canonical formatting repairs minus exact reversals`
- **Unit:** `files`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Workflow-linked native repairs

- **What it tells you:** Corroborated workflow-linked exact go formatting repairs. This is a `diagnostic` measure.
- **Native measurement formula:** `the same signed native effects restricted to corroborated merge revisions`
- **Unit:** `files`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Observed repository repairs

- **What it tells you:** Observed repository native subtotal. This is a `diagnostic` measure.
- **Native measurement formula:** `known signed native repository effects, retaining partial progress through unknown source assessments`
- **Unit:** `files`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Observed linked native repairs

- **What it tells you:** Observed workflow-linked native subtotal. This is a `diagnostic` measure.
- **Native measurement formula:** `known corroborated native effects, retaining partial progress through unknown source assessments`
- **Unit:** `files`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** Existing non-generated tracked Go files with exact canonical gofmt transformations.
- **Collection:** Replay shared immutable Go source features and one retained workflow linkage archive per batch.
- **Observation window:** 7 days, sampled every 7 days
- **Maturation delay:** 0 days
- **Filters:** `Immutable first-parent source changes, excluding vendor, testdata, node_modules and .git.`; `Generated files are excluded; syntactically unavailable formatting stays unknown, not clean.`; `Native source progress does not establish behavior preservation, full lint acceptance or sole workflow causation.`; `Workflow contributions require corroborated retained output-to-merge graph links.`; `Credit exact gofmt output only; reverse exact transformations withdraw credit.`

The frozen definitions and formulas are applied to every post-adoption observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `tidy-timeline.json` artifact.

## Important limitation

This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow.

Value-function SHA-256: `21b8acf189315bf4943a9ac48299424a7c2a0e6070b704fa74ececf9d2b2392e`
