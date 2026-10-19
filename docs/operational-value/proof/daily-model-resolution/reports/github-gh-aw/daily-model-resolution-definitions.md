---
title: "What Daily Sub-Agent Model Resolution Audit measures"
description: "Definitions, evidence rules, and interpretation for the Daily Sub-Agent Model Resolution Audit operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** unknown percent; unavailable

**Measurement:** interval; 2-day window, 2-day cadence.

**Recent change:** unavailable: Fresh complete mature evidence is required for recent movement.

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Correct resolution share (percent) | Verified children (child invocations) | Eligible opportunities | Evidence |
|---|---:|---:|---:|---|
| 2026-09-26T15:00:12Z | unknown | unknown | unknown | incomplete-evidence: Historical source era is unverified; current-source predicates are not backdated. No accepted native dispatch/proxy cohort is retained. |
| 2026-09-28T15:00:12Z | unknown | unknown | unknown | incomplete-evidence: Historical source era is unverified; current-source predicates are not backdated. No accepted native dispatch/proxy cohort is retained. |
| 2026-09-30T15:00:12Z | unknown | unknown | unknown | incomplete-evidence: Historical source era is unverified; current-source predicates are not backdated. No accepted native dispatch/proxy cohort is retained. |
| 2026-10-02T15:00:12Z | unknown | unknown | unknown | incomplete-evidence: Historical source era is unverified; current-source predicates are not backdated. No accepted native dispatch/proxy cohort is retained. |
| 2026-10-04T15:00:12Z | unknown | unknown | unknown | incomplete-evidence: Historical source era is unverified; current-source predicates are not backdated. No accepted native dispatch/proxy cohort is retained. |
| 2026-10-06T15:00:12Z | unknown | unknown | unknown | incomplete-evidence: Historical source era is unverified; current-source predicates are not backdated. No accepted native dispatch/proxy cohort is retained. |
| 2026-10-08T15:00:12Z | unknown | unknown | unknown | incomplete-evidence: Historical source era is unverified; current-source predicates are not backdated. No accepted native dispatch/proxy cohort is retained. |
| 2026-10-10T15:00:12Z | unknown | unknown | unknown | incomplete-evidence: Historical source era is unverified; current-source predicates are not backdated. No accepted native dispatch/proxy cohort is retained. |
| 2026-10-12T15:00:12Z | unknown | unknown | unknown | incomplete-evidence: Historical source era is unverified; current-source predicates are not backdated. No accepted native dispatch/proxy cohort is retained. |
| 2026-10-14T15:00:12Z | unknown | unknown | unknown | incomplete-evidence: Historical source era is unverified; current-source predicates are not backdated. No accepted native dispatch/proxy cohort is retained. |
| 2026-10-16T15:00:12Z | unknown | unknown | unknown | incomplete-evidence: Historical source era is unverified; current-source predicates are not backdated. No accepted native dispatch/proxy cohort is retained. |
| 2026-10-18T15:00:12Z | unknown | unknown | unknown | incomplete-evidence: Historical source era is unverified; current-source predicates are not backdated. No accepted native dispatch/proxy cohort is retained. |

The latest 12 periods are shown; the full native series is in the timeline.
Repository attainment includes other actors. Only a separately declared, independently verified contribution measure supports a workflow keep/change recommendation; it is not causal attribution.
Demonstrated workflow-enabled improvements count as shared contribution even when another agent or person implements them. Report measured progress, full goal completion, safeguards and attribution confidence separately. An unknown quality dimension does not cancel independently verified improvement; a merge alone does not verify that improvement.

## How to read the timeline

- Observations begin at workflow adoption on `2026-06-24`.
- No comparable pre-adoption evidence is available. Complete adjacent post-adoption periods may still show recent change, but not change relative to adoption.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Execution activity is diagnostic only. It does not prove repository value.
- Recent change compares the immediately preceding equal-duration period, not lifetime movement. Interval windows must abut without overlap; snapshot values compare cutoff states.
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- Adoption comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

**Goal:** Verify that dispatched sub-agents receive models of the size declared by their immutable workflow source.

**Accepted outcome:** Source-bound declarations and independent native child-dispatch identities join uniquely to api-proxy model records; every request of a completed child trace matches the explicit declared size.

### Correct resolution share

- **What it tells you:** Correct resolution share. This is a `primary` measure.
- **Native measurement formula:** `100 * correctCount / eligibleCount, only for complete nonempty explicit-size cohorts with no unknown invocations`
- **Unit:** `percent`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Verified correct children

- **What it tells you:** Verified correct children. This is a `diagnostic` measure.
- **Native measurement formula:** `correctCount; validated observed subtotal even when broader acceptance is unavailable`
- **Unit:** `child invocations`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** Actual independently evidenced child invocations in the source-declared bounded analyzed log cohort, not regex-like text or all repository traffic.
- **Collection:** One offline read of retained-native.json per batch. A separately approved producer must preserve protected source/dispatch/proxy receipts and complete cohort coverage. No APIs or checkout execution.
- **Observation window:** 2 days, sampled every 2 days
- **Maturation delay:** 0 days
- **Filters:** `Run/attempt/session/agent/tool-call identities must agree across protected dispatch and proxy receipts.`; `Declaration is bound by a protected source-metadata receipt to the subject workflow at the run's immutable source blob.`; `small/mini/haiku expect small; large/sonnet/opus expect large; explicit model IDs use /(mini|haiku|flash|nano)/i.`; `Inherited/unknown declarations remain unknown: the top-level and embedded-analyzer instructions disagree.`; `A correct child needs a closed independently reconciled request set. Any bound wrong request establishes a mismatch.`; `No parent traffic substitution, run-success proxy, agent claim, report count or synthetic history.`

The frozen definitions and formulas are applied to every post-adoption observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `daily-model-resolution-timeline.json` artifact.

## Important limitation

This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow.

Value-function SHA-256: `cfd556cc3367577d09b9318ec2c0f56fa98e3e0523c7cd9bb98f049f04ccd306`
