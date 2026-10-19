---
title: "What Smoke Create Cross-Repo PR measures"
description: "Definitions, evidence rules, and interpretation for the Smoke Create Cross-Repo PR operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** unknown fixture deliveries; unavailable

**Measurement:** interval; 7-day window, 7-day cadence.

**Recent change:** unavailable: Fresh complete mature evidence is required for recent movement.

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Verified deliveries (fixture deliveries) | Complete deliveries (fixture deliveries) | Eligible opportunities | Evidence |
|---|---:|---:|---:|---|
| 2026-08-10T01:25:35Z | unknown | unknown | unknown | incomplete-evidence: Authorized independent numeric target identity, original execution-source binding, PR/base/head branch identities, complete base/head Git tree path proofs and exact fixture blob content at delivery. |
| 2026-08-17T01:25:35Z | unknown | unknown | unknown | incomplete-evidence: Authorized independent numeric target identity, original execution-source binding, PR/base/head branch identities, complete base/head Git tree path proofs and exact fixture blob content at delivery. |
| 2026-08-24T01:25:35Z | unknown | unknown | unknown | incomplete-evidence: Authorized independent numeric target identity, original execution-source binding, PR/base/head branch identities, complete base/head Git tree path proofs and exact fixture blob content at delivery. |
| 2026-08-31T01:25:35Z | unknown | unknown | unknown | incomplete-evidence: Authorized independent numeric target identity, original execution-source binding, PR/base/head branch identities, complete base/head Git tree path proofs and exact fixture blob content at delivery. |
| 2026-09-07T01:25:35Z | unknown | unknown | unknown | incomplete-evidence: Authorized independent numeric target identity, original execution-source binding, PR/base/head branch identities, complete base/head Git tree path proofs and exact fixture blob content at delivery. |
| 2026-09-14T01:25:35Z | unknown | unknown | unknown | incomplete-evidence: Authorized independent numeric target identity, original execution-source binding, PR/base/head branch identities, complete base/head Git tree path proofs and exact fixture blob content at delivery. |
| 2026-09-21T01:25:35Z | unknown | unknown | unknown | incomplete-evidence: Authorized independent numeric target identity, original execution-source binding, PR/base/head branch identities, complete base/head Git tree path proofs and exact fixture blob content at delivery. |
| 2026-09-28T01:25:35Z | unknown | unknown | unknown | incomplete-evidence: Authorized independent numeric target identity, original execution-source binding, PR/base/head branch identities, complete base/head Git tree path proofs and exact fixture blob content at delivery. |
| 2026-10-05T01:25:35Z | unknown | unknown | unknown | incomplete-evidence: Authorized independent numeric target identity, original execution-source binding, PR/base/head branch identities, complete base/head Git tree path proofs and exact fixture blob content at delivery. |
| 2026-10-11T15:00:12Z | unknown | unknown | unknown | incomplete-evidence: Authorized independent numeric target identity, original execution-source binding, PR/base/head branch identities, complete base/head Git tree path proofs and exact fixture blob content at delivery. |
| 2026-10-12T01:25:35Z | unknown | unknown | unknown | incomplete-evidence: Authorized independent numeric target identity, original execution-source binding, PR/base/head branch identities, complete base/head Git tree path proofs and exact fixture blob content at delivery. |
| 2026-10-18T15:00:12Z | unknown | unknown | unknown | incomplete-evidence: Authorized independent numeric target identity, original execution-source binding, PR/base/head branch identities, complete base/head Git tree path proofs and exact fixture blob content at delivery. |

The latest 12 periods are shown; the full native series is in the timeline.
Repository attainment includes other actors. Only a separately declared, independently verified contribution measure supports a workflow keep/change recommendation; it is not causal attribution.
Demonstrated workflow-enabled improvements count as shared contribution even when another agent or person implements them. Report measured progress, full goal completion, safeguards and attribution confidence separately. An unknown quality dimension does not cancel independently verified improvement; a merge alone does not verify that improvement.

## How to read the timeline

- Observations begin at workflow adoption on `2026-03-02`.
- No comparable pre-adoption evidence is available. Complete adjacent post-adoption periods may still show recent change, but not change relative to adoption.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Execution activity is diagnostic only. It does not prove repository value.
- Recent change compares the immediately preceding equal-duration period, not lifetime movement. Interval windows must abut without overlap; snapshot values compare cutoff states.
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- Adoption comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

**Goal:** Deliver the exact run-specific smoke fixture on a new pull-request branch in the source-configured side repository.

**Accepted outcome:** Independent source-bound PR/base/head identities and immutable complete Git tree/blob proofs establish a newly added regular smoke-tests/smoke-RUN_ID.txt with exact prescribed content and a native UTC timestamp inside the original run.

### Verified deliveries

- **What it tells you:** Independently verified fixture deliveries. This is a `primary` measure.
- **Native measurement formula:** `Distinct original-run fixtures passing independent target, branch, base absence, Git blob and exact content checks; partial positive count is a lower bound.`
- **Unit:** `fixture deliveries`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Complete deliveries

- **What it tells you:** Complete verified delivery count. This is a `diagnostic` measure.
- **Native measurement formula:** `Verified fixture deliveries only when the entire eligible period and every delivery assessment are independently complete.`
- **Unit:** `fixture deliveries`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** One run-specific cross-repository fixture delivery per original workflow run, not each rerun or report.
- **Collection:** Replay the sealed public source/discovery archive and any independently acquired target Git receipts offline. Target reads were blocked by public-only authority; no target content was acquired.
- **Observation window:** 7 days, sampled every 7 days
- **Maturation delay:** 0 days
- **Filters:** `Retain source-era target ownership; never equate github and githubnext without immutable repository-identity proof.`; `Only independently acquired PR target/base/head binding and exact immutable file content establish attainment.`; `Source-repository issues, successful jobs, editable footers and unconsumed patches are discovery or mechanism evidence only.`; `Unknown retained or deleted history is null, not zero. Known native deliveries may be shown as lower bounds through gaps.`; `Draft, smoke-test labels, expiry, reporting, costs and contribution attribution are separate safeguards or unmeasured dimensions.`

The frozen definitions and formulas are applied to every post-adoption observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `smoke-create-cross-repo-pr-timeline.json` artifact.

## Important limitation

This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow.

Value-function SHA-256: `d29dfbc240135a5e75b2d670e7c48222aaf555f30f7680c60fa8be098da9ac6d`
