---
title: "What Auto-Triage Issues measures"
description: "Definitions, evidence rules, and interpretation for the Auto-Triage Issues operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** unknown issues; unavailable

**Measurement:** interval; 7-day window, 7-day cadence.

**Recent change:** unavailable: Fresh complete mature evidence is required for recent movement.

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Complete cohort coverage (issues) | Observed label coverage (issues) | Eligible opportunities | Evidence |
|---|---:|---:|---:|---|
| 2026-08-02T15:00:12Z | unknown | 885 | 901 | incomplete-evidence |
| 2026-08-09T15:00:12Z | unknown | 895 | 904 | incomplete-evidence |
| 2026-08-16T15:00:12Z | unknown | 868 | 877 | incomplete-evidence |
| 2026-08-23T15:00:12Z | unknown | 1049 | 1052 | incomplete-evidence |
| 2026-08-30T15:00:12Z | unknown | 1105 | 1289 | incomplete-evidence |
| 2026-09-06T15:00:12Z | unknown | 1117 | 1275 | incomplete-evidence |
| 2026-09-13T15:00:12Z | unknown | 1020 | 1234 | incomplete-evidence |
| 2026-09-20T15:00:12Z | unknown | 1063 | 1310 | incomplete-evidence |
| 2026-09-27T15:00:12Z | unknown | 1044 | 1300 | incomplete-evidence |
| 2026-10-04T15:00:12Z | unknown | 1087 | 1321 | incomplete-evidence |
| 2026-10-11T15:00:12Z | unknown | 1375 | 1599 | incomplete-evidence |
| 2026-10-18T15:00:12Z | unknown | 1123 | 1598 | incomplete-evidence |

The latest 12 periods are shown; the full native series is in the timeline.
Repository attainment includes other actors. Only a separately declared, independently verified contribution measure supports a workflow keep/change recommendation; it is not causal attribution.
Demonstrated workflow-enabled improvements count as shared contribution even when another agent or person implements them. Report measured progress, full goal completion, safeguards and attribution confidence separately. An unknown quality dimension does not cancel independently verified improvement; a merge alone does not verify that improvement.

## How to read the timeline

- Observations begin at workflow adoption on `2026-01-18`.
- No comparable pre-adoption evidence is available. Complete adjacent post-adoption periods may still show recent change, but not change relative to adoption.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Execution activity is diagnostic only. It does not prove repository value.
- Recent change compares the immediately preceding equal-duration period, not lifetime movement. Interval windows must abut without overlap; snapshot values compare cutoff states.
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- Adoption comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

**Goal:** Improve issue discoverability and reduce the repository's unlabeled-issue percentage below 5% through appropriate classification.

**Accepted outcome:** Partial facet: count native first-label coverage gains minus last-label withdrawals on open issues. Replay historical eligibility, not current labels backdated. Classification correctness, component completeness, explanatory comments, workflow attribution and the whole-repository percentage target remain unmeasured.

### Cohort net label coverage

- **What it tells you:** Complete surviving-cohort net label-coverage deliveries. This is a `primary` measure.
- **Native measurement formula:** `eligible open issues gaining their first label minus losing their last label`
- **Unit:** `issues`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Observed native label coverage

- **What it tells you:** Observed net label-coverage deliveries. This is a `diagnostic` measure.
- **Native measurement formula:** `the same signed effects within completely reconstructed issue histories; unknown histories are not zero`
- **Unit:** `issues`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** Open unlabeled issues in the frozen surviving-identity cohort.
- **Collection:** Replay one shared, digest-checked, resumable issue condition archive offline. Retain period counts and native-event ledger digests instead of duplicating the event archive in every plot.
- **Observation window:** 7 days, sampled every 7 days
- **Maturation delay:** 0 days
- **Filters:** `Replay all retained label, assignment, closure and reopening events from creation; reconcile terminal state.`; `Exclude no unknown issue as if clean: complete totals become null; retain explicitly observed native subtotals.`; `Transfers, deleted identities and unreconciled histories remain unknown.`; `Any-label coverage is a partial discoverability facet, not proof of correct classification or full triage.`; `Repository condition changes are not attributed to either workflow; comments, run success and label counts do not establish classification correctness.`; `The surviving cohort omits deleted/transferred-away issues; do not apply the whole-repository 5% goal to its observed subset.`

The frozen definitions and formulas are applied to every post-adoption observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `auto-triage-issues-timeline.json` artifact.

## Important limitation

This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow.

Value-function SHA-256: `e47b86721d289accf541b7c27f41e42a0f4086e76bb36fe7dbf0418aa48007cc`
