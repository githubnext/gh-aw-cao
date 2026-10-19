---
title: "What CI Optimization Coach measures"
description: "Definitions, evidence rules, and interpretation for the CI Optimization Coach operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** unknown existing fuzz targets newly selected unambiguously in the main-branch fuzz job; unavailable

**Measurement:** interval; 7-day window, 7-day cadence.

**Recent change:** unavailable: Fresh complete mature evidence is required for recent movement.

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Fuzz targets restored (existing fuzz targets newly selected unambiguously in the main-branch fuzz job) | Eligible opportunities | Evidence |
|---|---:|---:|---|
| 2026-08-02T15:00:12Z | unknown | unknown | incomplete-evidence |
| 2026-08-09T15:00:12Z | unknown | unknown | incomplete-evidence |
| 2026-08-16T15:00:12Z | unknown | unknown | incomplete-evidence |
| 2026-08-23T15:00:12Z | unknown | unknown | incomplete-evidence |
| 2026-08-30T15:00:12Z | unknown | unknown | incomplete-evidence |
| 2026-09-06T15:00:12Z | unknown | unknown | incomplete-evidence |
| 2026-09-13T15:00:12Z | unknown | unknown | incomplete-evidence |
| 2026-09-20T15:00:12Z | unknown | unknown | incomplete-evidence |
| 2026-09-27T15:00:12Z | unknown | unknown | incomplete-evidence |
| 2026-10-04T15:00:12Z | unknown | unknown | incomplete-evidence |
| 2026-10-11T15:00:12Z | unknown | unknown | incomplete-evidence |
| 2026-10-18T15:00:12Z | unknown | unknown | incomplete-evidence |

The latest 12 periods are shown; the full native series is in the timeline.
Repository attainment includes other actors. Only a separately declared, independently verified contribution measure supports a workflow keep/change recommendation; it is not causal attribution.
Demonstrated workflow-enabled improvements count as shared contribution even when another agent or person implements them. Report measured progress, full goal completion, safeguards and attribution confidence separately. An unknown quality dimension does not cancel independently verified improvement; a merge alone does not verify that improvement.

## How to read the timeline

- Observations begin at workflow adoption on `2025-12-10`.
- No comparable pre-adoption evidence is available. Complete adjacent post-adoption periods may still show recent change, but not change relative to adoption.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Execution activity is diagnostic only. It does not prove repository value.
- Recent change compares the immediately preceding equal-duration period, not lifetime movement. Interval windows must abut without overlap; snapshot values compare cutoff states.
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- Adoption comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

**Goal:** Improve CI efficiency while preserving required test execution, correct failure propagation and correctness; repair independently demonstrated pre-flight failures when that priority exists in the contemporaneous workflow.

**Accepted outcome:** Demonstrate more than five percent CI time improvement on comparable independently recorded workloads/environments while retaining complete eligible test coverage, correct failure propagation and required correctness/security dependencies. A pre-flight repair instead needs the original failing condition and independent acceptance of the repaired condition. Neither proposed savings nor successful/merged activity establishes acceptance.

### Unambiguous fuzz targets restored

- **What it tells you:** Unambiguous fuzz targets restored. This is a `primary` measure.
- **Native measurement formula:** `Within the actual-parent CI-only transition, count distinct previously unmatched native Go fuzz targets introduced by additive production run_fuzz_test calls. Match the exact unanchored selectors with Go's regexp implementation against the complete Linux/amd64-eligible package test inventory. Require a unique testing.F entry point with a Fuzz body. Exclude ambiguous selectors and every added invocation after the first selector that deterministically fails under the production fail-fast shell. Preserve all previous invocations, helper, Go version and job gating.`
- **Unit:** `existing fuzz targets newly selected unambiguously in the main-branch fuzz job`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** Existing native Go fuzz targets omitted from the main-branch fuzz-mode selector
- **Collection:** Bounded original API packets and Git objects; native source oracle and independently authored Go witness; no target execution
- **Observation window:** 7 days, sampled every 7 days
- **Maturation delay:** 0 days
- **Filters:** `Actual-parent additive CI-only transition`; `Complete Git-bound native test inventory`; `Go AST, build eligibility and native regexp matching`; `Exclude ambiguous and later blocked invocations`

The frozen definitions and formulas are applied to every post-adoption observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `ci-coach-timeline.json` artifact.

## Important limitation

This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow.

Value-function SHA-256: `979bff8f8c476daac1e82d342582f22d65aef122d8270253fc892cdd35ea287b`
