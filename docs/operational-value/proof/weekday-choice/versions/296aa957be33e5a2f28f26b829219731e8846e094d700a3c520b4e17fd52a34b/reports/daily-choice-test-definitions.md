---
title: "What Daily Choice Type Test measures"
description: "Definitions, evidence rules, and interpretation for the Daily Choice Type Test operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** 4 configurations; incomplete-evidence

**Measurement:** interval; 7-day window, 7-day cadence.

**Recent change:** unavailable: Fresh complete mature evidence is required for recent movement.

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Correct configurations (configurations) | Unassessed opportunities (configurations) | Eligible opportunities | Evidence |
|---|---:|---:|---:|---|
| 2026-08-10T16:51:56Z | unknown | 5 | 5 | incomplete-evidence |
| 2026-08-17T16:51:56Z | unknown | 5 | 5 | incomplete-evidence |
| 2026-08-24T16:51:56Z | unknown | 5 | 5 | incomplete-evidence |
| 2026-08-31T16:51:56Z | unknown | 5 | 5 | incomplete-evidence |
| 2026-09-07T16:51:56Z | unknown | 5 | 5 | incomplete-evidence |
| 2026-09-14T16:51:56Z | unknown | 5 | 5 | incomplete-evidence |
| 2026-09-21T16:51:56Z | unknown | 5 | 5 | incomplete-evidence |
| 2026-09-28T16:51:56Z | unknown | 5 | 5 | incomplete-evidence |
| 2026-10-05T16:51:56Z | unknown | 5 | 5 | incomplete-evidence |
| 2026-10-11T15:00:12Z | unknown | 5 | 5 | incomplete-evidence |
| 2026-10-12T16:51:56Z | unknown | 5 | 5 | incomplete-evidence |
| 2026-10-18T15:00:12Z | 4 | 1 | 5 | incomplete-evidence |

The latest 12 periods are shown; the full native series is in the timeline.
Repository attainment includes other actors. Only a separately declared, independently verified contribution measure supports a workflow keep/change recommendation; it is not causal attribution.
Demonstrated workflow-enabled improvements count as shared contribution even when another agent or person implements them. Report measured progress, full goal completion, safeguards and attribution confidence separately. An unknown quality dimension does not cancel independently verified improvement; a merge alone does not verify that improvement.

## How to read the timeline

- Observations begin at workflow adoption on `2025-12-22`.
- No comparable pre-adoption evidence is available. Complete adjacent post-adoption periods may still show recent change, but not change relative to adoption.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Execution activity is diagnostic only. It does not prove repository value.
- Recent change compares the immediately preceding equal-duration period, not lifetime movement. Interval windows must abut without overlap; snapshot values compare cutoff states.
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- Adoption comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

**Goal:** Deliver the source's weekday-specific safe-output test configuration.

**Accepted outcome:** Two immutable initial-attempt artifact payloads agree on one allowed configuration, and the exact protected custom job reads it back. Monday/Wednesday/Friday requires staging/smoke; Tuesday/Thursday requires production/integration. UTC and source project day must agree.

### Verified correct weekday configurations

- **What it tells you:** Verified correct weekday configurations. This is a `primary` measure.
- **Native measurement formula:** `Count source-bound initial execution receipts whose delivered configuration matches the deterministic weekday rule.`
- **Unit:** `configurations`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Unassessed weekday opportunities

- **What it tells you:** Unassessed weekday opportunities. This is a `diagnostic` measure.
- **Native measurement formula:** `Eligible initial weekday executions without a complete independent configuration receipt.`
- **Unit:** `configurations`
- **Goal:** Lower values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** Initial same-repository scheduled/manual weekday runs before the frozen cutoff.
- **Collection:** Exhaustive bounded date-sliced run inventory plus normalized immutable artifact and protected host receipts.
- **Observation window:** 7 days, sampled every 7 days
- **Maturation delay:** 0 days
- **Filters:** `A successful run or custom job alone is not a correct configuration.`; `Retain single-item allowed argument projections, whole payload/archive hashes and source-bound upload/readback receipts; no agent prose.`; `Both merged artifact names must survive with agreeing selections and provider-matching archive digests.`; `Reruns, unreviewed sources, ambiguous dates, missing/expired receipts and payload disagreements remain unassessed.`; `Count one verified configuration per initial execution, at protected readback completion; unassessed opportunities retain creation-time coverage.`; `Weekend dispatches have no declared rule and are ineligible, not failures.`; `This proves delivered configuration, not deployment/test execution, invalid-choice rejection, exclusive model authorship or costs.`

The frozen definitions and formulas are applied to every post-adoption observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `daily-choice-test-timeline.json` artifact.

## Important limitation

This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow.

Value-function SHA-256: `296aa957be33e5a2f28f26b829219731e8846e094d700a3c520b4e17fd52a34b`
