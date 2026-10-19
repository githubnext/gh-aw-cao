---
title: "What Smoke Call Workflow (call-workflow orchestrator) measures"
description: "Definitions, evidence rules, and interpretation for the Smoke Call Workflow (call-workflow orchestrator) operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** unknown invocation proofs; unavailable

**Measurement:** interval; 7-day window, 7-day cadence.

**Recent change:** unavailable: Fresh complete mature evidence is required for recent movement.

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Verified invocations (invocation proofs) | Verified dispatches (dispatch-match proofs) | Eligible opportunities | Evidence |
|---|---:|---:|---:|---|
| 2026-08-02T15:00:12Z | unknown | unknown | 0 | incomplete-evidence: Actions run/job/log acquisition was blocked (blocked-acquisition); Actions run success is not independent invocation/checkout proof. |
| 2026-08-09T15:00:12Z | unknown | unknown | 0 | incomplete-evidence: Actions run/job/log acquisition was blocked (blocked-acquisition); Actions run success is not independent invocation/checkout proof. |
| 2026-08-16T15:00:12Z | unknown | unknown | 0 | incomplete-evidence: Actions run/job/log acquisition was blocked (blocked-acquisition); Actions run success is not independent invocation/checkout proof. |
| 2026-08-23T15:00:12Z | unknown | unknown | 0 | incomplete-evidence: Actions run/job/log acquisition was blocked (blocked-acquisition); Actions run success is not independent invocation/checkout proof. |
| 2026-08-30T15:00:12Z | unknown | unknown | 0 | incomplete-evidence: Actions run/job/log acquisition was blocked (blocked-acquisition); Actions run success is not independent invocation/checkout proof. |
| 2026-09-06T15:00:12Z | unknown | unknown | 0 | incomplete-evidence: Actions run/job/log acquisition was blocked (blocked-acquisition); Actions run success is not independent invocation/checkout proof. |
| 2026-09-13T15:00:12Z | unknown | unknown | 0 | incomplete-evidence: Actions run/job/log acquisition was blocked (blocked-acquisition); Actions run success is not independent invocation/checkout proof. |
| 2026-09-20T15:00:12Z | unknown | unknown | 0 | incomplete-evidence: Actions run/job/log acquisition was blocked (blocked-acquisition); Actions run success is not independent invocation/checkout proof. |
| 2026-09-27T15:00:12Z | unknown | unknown | 0 | incomplete-evidence: Actions run/job/log acquisition was blocked (blocked-acquisition); Actions run success is not independent invocation/checkout proof. |
| 2026-10-04T15:00:12Z | unknown | unknown | 0 | incomplete-evidence: Actions run/job/log acquisition was blocked (blocked-acquisition); Actions run success is not independent invocation/checkout proof. |
| 2026-10-11T15:00:12Z | unknown | unknown | 0 | incomplete-evidence: Actions run/job/log acquisition was blocked (blocked-acquisition); Actions run success is not independent invocation/checkout proof. |
| 2026-10-18T15:00:12Z | unknown | unknown | 0 | incomplete-evidence: Actions run/job/log acquisition was blocked (blocked-acquisition); Actions run success is not independent invocation/checkout proof. |

The latest 12 periods are shown; the full native series is in the timeline.
Repository attainment includes other actors. Only a separately declared, independently verified contribution measure supports a workflow keep/change recommendation; it is not causal attribution.
Demonstrated workflow-enabled improvements count as shared contribution even when another agent or person implements them. Report measured progress, full goal completion, safeguards and attribution confidence separately. An unknown quality dimension does not cancel independently verified improvement; a merge alone does not verify that improvement.

## How to read the timeline

- Observations begin at workflow adoption on `2026-03-13`.
- No comparable pre-adoption evidence is available. Complete adjacent post-adoption periods may still show recent change, but not change relative to adoption.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Execution activity is diagnostic only. It does not prove repository value.
- Recent change compares the immediately preceding equal-duration period, not lifetime movement. Interval windows must abut without overlap; snapshot values compare cutoff states.
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- Adoption comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

**Goal:** Validate reusable-worker invocation and checkout through call-workflow.

**Accepted outcome:** Independent invocation and checkout evidence confirms the requested worker and task input reached the intended context.

### Verified call-workflow invocations

- **What it tells you:** Verified call-workflow invocations. This is a `primary` measure.
- **Native measurement formula:** `Count independently verified call-workflow dispatches whose nested job used the exact declared workflow file and whose resolved task-description input matches the source-declared literal.`
- **Unit:** `invocation proofs`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Verified intended worker dispatches

- **What it tells you:** Verified intended worker dispatches. This is a `diagnostic` measure.
- **Native measurement formula:** `Count independent confirmations that the nested job used the exact declared smoke-workflow-call.lock.yml file; does not assert the task-description input matched.`
- **Unit:** `dispatch-match proofs`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** Every policy-admitted smoke-call-workflow run (schedule cycle, manual/workflow_dispatch, centralized slash dispatch, and `water`-labeled pull_request triggers).
- **Collection:** Offline replay of digest-checked orchestrator run inventory and bound call-workflow safe-output dispatch receipt (declared workflow file plus resolved task-description input); absent receipts remain null.
- **Observation window:** 7 days, sampled every 7 days
- **Maturation delay:** 0 days
- **Filters:** `Not proof: a run concluding 'success'`; `Not proof: a PASS/FAIL comment footer written by the agent itself`; `Not proof: the call_workflow safe-output count alone (dispatch without confirmed destination/input match)`; `Not proof: the worker's own schedule/workflow_dispatch run history (never reflects workflow_call context)`; `Not proof: editable issue/PR body or comment text`; `Actions run/job/log-level evidence (run lists, job steps, and logs for both workflows) could not be acquired in this measurement environment; see acquisition below.`; `Repository, commit, blob, and adoption facts above were independently verified via unauthenticated public git smart-HTTP clone plus SHA1 blob hashing, which remained reachable.`; `Complete attribution and cost accounting remain not-measured.`

The frozen definitions and formulas are applied to every post-adoption observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `smoke-call-workflow-timeline.json` artifact.

## Important limitation

This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow.

Value-function SHA-256: `328934dc3da6a2872c5028532c0c7a30b6703f12c4204aa95df288874fec07c6`
