---
title: "What Daily File Diet measures"
description: "Definitions, evidence rules, and interpretation for the Daily File Diet operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** 53 files; complete

**Measurement:** snapshot; 7-day window, 7-day cadence.

**Recent change:** +4 files

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Oversized files (files) | Accepted refactors (refactors) | Correct target issues (issues) | Eligible opportunities | Evidence |
|---|---:|---:|---:|---:|---|
| 2026-09-19T10:16:09Z | 40 | 0 | 0 | 1374 | complete |
| 2026-09-26T10:16:09Z | 42 | 0 | 2 | 1381 | complete |
| 2026-10-03T10:16:09Z | 45 | 0 | 2 | 1413 | complete |
| 2026-10-10T10:16:09Z | 49 | 0 | 2 | 1496 | complete |
| 2026-10-17T10:16:09Z | 53 | 0 | 1 | 1575 | complete |

The latest 5 periods are shown; the full native series is in the timeline.
Repository attainment includes other actors. Only a separately declared, independently verified contribution measure supports a workflow keep/change recommendation; it is not causal attribution.
Demonstrated workflow-enabled improvements count as shared contribution even when another agent or person implements them. Report measured progress, full goal completion, safeguards and attribution confidence separately. An unknown quality dimension does not cancel independently verified improvement; a merge alone does not verify that improvement.

## How to read the timeline

- The measurement contract was activated on `2026-10-18`; this is not a workflow adoption date.
- No historical reference has been established.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Execution activity is diagnostic only. It does not prove repository value.
- Recent change compares the immediately preceding equal-duration period, not lifetime movement. Interval windows must abut without overlap; snapshot values compare cutoff states.
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- Historical reference comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

**Goal:** Identify oversized production Go files and promote behavior-preserving decomposition.

**Accepted outcome:** Count the source-defined 800+ line condition independently; credit a linked refactor only after completed/merged, under-500 new files, tests, lint, build, >=80% new-file coverage and unchanged public API are established.

### Oversized production files

- **What it tells you:** Production Go files with at least 800 lines. This is a `primary` measure.
- **Native measurement formula:** `count distinct regular pkg/**/*.go paths excluding *_test.go with wc -l >= 800`
- **Unit:** `files`
- **Goal:** Lower values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Accepted linked refactors

- **What it tells you:** New accepted receipt-linked refactors in this window. This is a `diagnostic` measure.
- **Native measurement formula:** `count explicitly completed merged refactors satisfying all frozen safeguards; unknown identity, graph coverage or required checks yields null`
- **Unit:** `refactors`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Correctly targeted issues

- **What it tells you:** New receipt-linked issues correctly targeting a largest oversized file. This is a `diagnostic` measure.
- **Native measurement formula:** `count new verified create_issue receipts whose target exists, is at least 800 lines and has the maximum source-revision line count; a precursor, not accepted refactoring`
- **Unit:** `issues`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** All regular non-test .go files under pkg/ in each immutable revision; linked-refactor diagnostics cover only the declared exact-workflow issue cohort.
- **Collection:** Complete Git tree inventories and independently cross-checked blob newline counts; verified Actions issue receipts and complete explicit closing relationships.
- **Observation window:** 7 days, sampled every 7 days
- **Maturation delay:** 0 days
- **Filters:** `wc -l newline semantics`; `800 lines is already oversized`; `Generated Go files are not silently excluded`

The frozen goal, acceptance rule and formulas are applied to every observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `daily-file-diet-timeline.json` artifact.

## Important limitation

This report measures accepted repository outcomes against the stated goal. Contract activation is not an intervention or proof that an agent caused the outcomes; unavailable historical evidence supports no historical improvement claim.

Value-function SHA-256: `f5a70e8fdf40a1c893c1c360f14ccd4a957e7a3845e109b29cd7a3d937d81103`
