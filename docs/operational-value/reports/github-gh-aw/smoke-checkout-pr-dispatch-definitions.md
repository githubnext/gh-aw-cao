---
title: "What Smoke Checkout PR Dispatch measures"
description: "Definitions, evidence rules, and interpretation for the Smoke Checkout PR Dispatch operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** unknown checkout proofs; unavailable

**Measurement:** interval; 7-day window, 7-day cadence.

**Recent change:** unavailable: Fresh complete mature evidence is required for recent movement.

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Verified PR checkouts (checkout proofs) | Verified intended heads (head-match proofs) | Eligible opportunities | Evidence |
|---|---:|---:|---:|---|
| 2026-08-15T19:43:53Z | unknown | unknown | unknown | incomplete-evidence: Original event/head and protected clean-checkout receipts were not preserved; Actions activity is not checkout proof. |
| 2026-08-22T19:43:53Z | unknown | unknown | unknown | incomplete-evidence: Original event/head and protected clean-checkout receipts were not preserved; Actions activity is not checkout proof. |
| 2026-08-29T19:43:53Z | unknown | unknown | unknown | incomplete-evidence: Original event/head and protected clean-checkout receipts were not preserved; Actions activity is not checkout proof. |
| 2026-09-05T19:43:53Z | unknown | unknown | unknown | incomplete-evidence: Original event/head and protected clean-checkout receipts were not preserved; Actions activity is not checkout proof. |
| 2026-09-12T19:43:53Z | unknown | unknown | unknown | incomplete-evidence: Original event/head and protected clean-checkout receipts were not preserved; Actions activity is not checkout proof. |
| 2026-09-19T19:43:53Z | unknown | unknown | unknown | incomplete-evidence: Original event/head and protected clean-checkout receipts were not preserved; Actions activity is not checkout proof. |
| 2026-09-26T19:43:53Z | unknown | unknown | unknown | incomplete-evidence: Original event/head and protected clean-checkout receipts were not preserved; Actions activity is not checkout proof. |
| 2026-10-03T19:43:53Z | unknown | unknown | unknown | incomplete-evidence: Original event/head and protected clean-checkout receipts were not preserved; Actions activity is not checkout proof. |
| 2026-10-10T19:43:53Z | unknown | unknown | unknown | incomplete-evidence: Original event/head and protected clean-checkout receipts were not preserved; Actions activity is not checkout proof. |
| 2026-10-11T15:00:12Z | unknown | unknown | unknown | incomplete-evidence: Original event/head and protected clean-checkout receipts were not preserved; Actions activity is not checkout proof. |
| 2026-10-17T19:43:53Z | unknown | unknown | unknown | incomplete-evidence: Original event/head and protected clean-checkout receipts were not preserved; Actions activity is not checkout proof. |
| 2026-10-18T15:00:12Z | unknown | unknown | unknown | incomplete-evidence: Original event/head and protected clean-checkout receipts were not preserved; Actions activity is not checkout proof. |

The latest 12 periods are shown; the full native series is in the timeline.
Repository attainment includes other actors. Only a separately declared, independently verified contribution measure supports a workflow keep/change recommendation; it is not causal attribution.
Demonstrated workflow-enabled improvements count as shared contribution even when another agent or person implements them. Report measured progress, full goal completion, safeguards and attribution confidence separately. An unknown quality dimension does not cancel independently verified improvement; a merge alone does not verify that improvement.

## How to read the timeline

- Observations begin at workflow adoption on `2026-08-01`.
- No comparable pre-adoption evidence is available. Complete adjacent post-adoption periods may still show recent change, but not change relative to adoption.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Execution activity is diagnostic only. It does not prove repository value.
- Recent change compares the immediately preceding equal-duration period, not lifetime movement. Interval windows must abut without overlap; snapshot values compare cutoff states.
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- Adoption comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

**Goal:** For every admitted PR-context invocation, check out the intended PR head in a clean initialized Git workspace with origin and visible history.

**Accepted outcome:** Join the original GitHub event and source policy to a contemporaneous expected PR head/ref and protected pre-agent Git readback; require matching head/ref, clean status, origin, visible commit and a non-main branch.

### Verified PR checkouts

- **What it tells you:** Verified PR checkouts. This is a `primary` measure.
- **Native measurement formula:** `Count distinct initial invocation opportunities with independently established complete checkout conjunction; unknown outcomes are not zero.`
- **Unit:** `checkout proofs`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Verified intended PR heads

- **What it tells you:** Verified intended PR heads. This is a `diagnostic` measure.
- **Native measurement formula:** `Count independent intended PR head/ref matches; does not assert a clean workspace.`
- **Unit:** `head-match proofs`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** Every policy-admitted initial PR-context invocation, including dispatch, centralized slash dispatch and direct PR/comment triggers; no-PR controls are separate.
- **Collection:** Offline replay of digest-checked all-run inventory, original event, immutable source policy, expected PR-head and protected pre-agent Git state; absent receipts remain null.
- **Observation window:** 7 days, sampled every 7 days
- **Maturation delay:** 0 days
- **Filters:** `Not proof: overall run/job/agent success`; `Not proof: checkout_pr_success (also true for skipped and closed-PR paths)`; `Not proof: non-main branch alone`; `Not proof: checkout configuration`; `Not proof: agent-authored PASS comment`; `Not proof: current PR head backdated`; `The function is valid prospectively; measurement remains blocked without independent event/head/workspace receipts.`; `No successful step or exported baseline alone proves a clean initialized workspace.`; `Protected post-agent logs and agent reports cannot establish the required pre-agent state.`; `No costs, sole causation, adoption-relative improvement or keep/retire bar is measured.`

The frozen definitions and formulas are applied to every post-adoption observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `smoke-checkout-pr-dispatch-timeline.json` artifact.

## Important limitation

This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow.

Value-function SHA-256: `339d24b03024224491c8414ffc2ada482094d545aecc9d8c13ad1782e735d14b`
