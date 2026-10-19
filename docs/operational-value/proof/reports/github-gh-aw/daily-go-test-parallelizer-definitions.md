---
title: "What Daily Go Test Parallelizer measures"
description: "Definitions, evidence rules, and interpretation for the Daily Go Test Parallelizer operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** -2 tests; incomplete-evidence

**Measurement:** interval; 7-day window, 7-day cadence.

**Recent change:** unavailable: Fresh complete mature evidence is required for recent movement.

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Repository tests (tests) | Linked tests (tests) | Eligible opportunities | Evidence |
|---|---:|---:|---:|---|
| 2026-08-03T04:58:37Z | 46 | 4 | unknown | incomplete-evidence |
| 2026-08-10T04:58:37Z | 97 | 60 | unknown | incomplete-evidence |
| 2026-08-17T04:58:37Z | 78 | 29 | unknown | incomplete-evidence |
| 2026-08-24T04:58:37Z | 1310 | 949 | unknown | incomplete-evidence |
| 2026-08-31T04:58:37Z | 620 | 253 | unknown | incomplete-evidence |
| 2026-09-07T04:58:37Z | 0 | 0 | unknown | incomplete-evidence |
| 2026-09-14T04:58:37Z | 0 | 0 | unknown | incomplete-evidence |
| 2026-09-21T04:58:37Z | -2 | 0 | unknown | incomplete-evidence |
| 2026-09-28T04:58:37Z | 0 | 0 | unknown | incomplete-evidence |
| 2026-10-05T04:58:37Z | -2 | 0 | unknown | incomplete-evidence |
| 2026-10-12T04:58:37Z | 0 | 0 | unknown | incomplete-evidence |
| 2026-10-18T15:00:12Z | -2 | 0 | unknown | incomplete-evidence |

The latest 12 periods are shown; the full native series is in the timeline.
Repository attainment includes other actors. Only a separately declared, independently verified contribution measure supports a workflow keep/change recommendation; it is not causal attribution.
Demonstrated workflow-enabled improvements count as shared contribution even when another agent or person implements them. Report measured progress, full goal completion, safeguards and attribution confidence separately. An unknown quality dimension does not cancel independently verified improvement; a merge alone does not verify that improvement.

## How to read the timeline

- Observations begin at workflow adoption on `2026-07-27`.
- No comparable pre-adoption evidence is available. Complete adjacent post-adoption periods may still show recent change, but not change relative to adoption.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Execution activity is diagnostic only. It does not prove repository value.
- Recent change compares the immediately preceding equal-duration period, not lifetime movement. Interval windows must abut without overlap; snapshot values compare cutoff states.
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- Adoption comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

**Goal:** Safely enable parallel execution of existing Go tests without changing test behavior.

**Accepted outcome:** Observed partial facet: the same top-level Test name, file, package, build constraints and unchanged body gain a direct leading call on the actual testing.T parameter; exclude generated files and directly detected os/testing process-state mutations. Race safety, fixed-resource isolation, package-global behavior and full-suite acceptance are separate and not inferred.

### Repository parallel activations

- **What it tells you:** Repository net unchanged-body parallel activations. This is a `primary` measure.
- **Native measurement formula:** `qualifying leading parallel activations minus qualifying withdrawals in the non-overlapping period`
- **Unit:** `tests`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Workflow-linked parallel activations

- **What it tells you:** Corroborated workflow-linked net parallel activations. This is a `diagnostic` measure.
- **Native measurement formula:** `the same native signed effects restricted to immutable merge revisions linked to this workflow`
- **Unit:** `tests`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** Existing top-level testing.T tests in tracked, non-generated Go test files, excluding vendor, testdata and node_modules.
- **Collection:** Replay the retained immutable Go blob feature table and normalized GitHub linkage archive once per batch; no network calls during scoring.
- **Observation window:** 7 days, sampled every 7 days
- **Maturation delay:** 0 days
- **Filters:** `Added, deleted or renamed test identities are not parallelization deliveries.`; `Compare each mainline change with its immutable first parent; retain signed withdrawals.`; `Count demonstrated source changes, not full race-safe acceptance, faster execution, PR counts or exclusive workflow causation.`; `Direct-marker and independently graph-linked downstream PRs are corroborated contributions, not safe-output creation receipts.`

The frozen definitions and formulas are applied to every post-adoption observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `daily-go-test-parallelizer-timeline.json` artifact.

## Important limitation

This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow.

Value-function SHA-256: `3f09b62e5f3b0686bda3e6a0332f2a0a95f725687de50546f647b5e522db718e`
