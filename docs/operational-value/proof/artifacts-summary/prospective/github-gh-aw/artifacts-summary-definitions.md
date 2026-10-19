---
title: "What Artifacts Summary measures"
description: "Definitions, evidence rules, and interpretation for the Artifacts Summary operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** unknown reports; unavailable

**Measurement:** interval; 30-day window, 30-day cadence.

**Recent change:** unavailable: Fresh complete mature evidence is required for recent movement.

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Accurate reports (reports) | Verified workflows (workflows) | Verified storage bytes (bytes) | Eligible opportunities | Evidence |
|---|---:|---:|---:|---:|---|
| 2026-10-19T11:17:25Z | unknown | unknown | unknown | unknown | partial-window: Independent complete native API pages, original report content and delivery census are not preserved. |

The latest 1 periods are shown; the full native series is in the timeline.
Repository attainment includes other actors. Only a separately declared, independently verified contribution measure supports a workflow keep/change recommendation; it is not causal attribution.
Demonstrated workflow-enabled improvements count as shared contribution even when another agent or person implements them. Report measured progress, full goal completion, safeguards and attribution confidence separately. An unknown quality dimension does not cancel independently verified improvement; a merge alone does not verify that improvement.

## How to read the timeline

- The measurement contract was activated on `2026-10-19`; this is not a workflow adoption date.
- No historical reference has been established.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Execution activity is diagnostic only. It does not prove repository value.
- Recent change compares the immediately preceding equal-duration period, not lifetime movement. Interval windows must abut without overlap; snapshot values compare cutoff states.
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- Historical reference comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

**Goal:** For repository-wide retained Actions artifact inventories, attain an accurate storage view across all workflows, demonstrated by independent reconciliation of original report rows with complete source-native workflow, run and artifact API pages.

**Accepted outcome:** Independent exhaustive native workflow/run/artifact pages must reconcile each original published report's count, size, average, latest eligible run and status under the frozen report-date window.

### Accurate delivered inventories

- **What it tells you:** Accurate delivered inventories. This is a `primary` measure.
- **Native measurement formula:** `Distinct completed report identities with complete independently reconciled count/byte/average/time/status inventory`
- **Unit:** `reports`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Verified workflow rows

- **What it tells you:** Verified workflow rows. This is a `diagnostic` measure.
- **Native measurement formula:** `Sum of independently reconciled artifact-bearing workflow rows on distinct delivered report identities`
- **Unit:** `workflows`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Verified inventoried storage

- **What it tells you:** Verified inventoried storage. This is a `diagnostic` measure.
- **Native measurement formula:** `Exact native size_in_bytes sum on independently reconciled workflow rows, not bytes saved or fresh artifact production`
- **Unit:** `bytes`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** Every workflow in the independent workflow inventory; every non-cancelled run created in [midnight UTC after assigned report_date minus 30 days, midnight UTC after assigned report_date); every retained artifact on those runs, including expired entries returned by the API.
- **Collection:** Offline digest-checked source closure and original native API/report bytes; no APIs during evaluation.
- **Observation window:** 30 days, sampled every 30 days
- **Maturation delay:** 0 days
- **Filters:** `Thirty days anchored at assigned report_date, exclude cancelled runs`; `Complete independent native API pages; raw published report rows; no invented historical zero`; `Disjoint completion periods; deduplicate published report identity`; `Current source only; unknown historical eras remain inapplicable`

The frozen goal, acceptance rule and formulas are applied to every observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `artifacts-summary-timeline.json` artifact.

## Important limitation

This report measures accepted repository outcomes against the stated goal. Contract activation is not an intervention or proof that an agent caused the outcomes; unavailable historical evidence supports no historical improvement claim.

Value-function SHA-256: `8b96f1203a9f8a3f388650541caa64f90121e2e46af28e7d26eaaf492a30ec1b`
