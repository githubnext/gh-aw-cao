---
title: "What Daily credit activation guardrail measures"
description: "Definitions, evidence rules, and interpretation for the Daily credit activation guardrail operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** unknown percent; unavailable

**Measurement:** interval; 1-day window, 1-day cadence.

**Recent change:** unavailable: Fresh complete mature evidence is required for recent movement.

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Protected activations (percent) | Verified protection (activations) | Daily denials (activations) | No agent inference (activations) | Limit messages (activations) | Workflow contribution (activations) | Eligible opportunities | Evidence |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| 2026-10-19T09:46:04Z | unknown | unknown | unknown | unknown | unknown | unknown | unknown | partial-window: No complete authenticated native activation inventory, usage ledger, inference audit and publication receipts retained. |

The latest 1 periods are shown; the full native series is in the timeline.
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

**Goal:** Protect the daily workflow budget by denying eligible activations before agent inference and publishing the required limit-exceeded message.

**Accepted outcome:** Independent complete preceding-24-hour recorded AIC establishes eligibility; a source-bound daily guardrail denial, complete no-inference audit and immutable conclusion-job message jointly establish protection.

### Eligible activations fully protected

- **What it tells you:** Eligible activations fully protected. This is a `primary` measure.
- **Native measurement formula:** `100 * acceptedCount / eligibleCount; only complete eligibility and acceptance cohorts`
- **Unit:** `percent`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Independently verified protected activations

- **What it tells you:** Independently verified protected activations. This is a `diagnostic` measure.
- **Native measurement formula:** `acceptedCount; positive lower bound survives incomplete inventory or other unresolved opportunities`
- **Unit:** `activations`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Verified daily guardrail denials

- **What it tells you:** Verified daily guardrail denials. This is a `diagnostic` measure.
- **Native measurement formula:** `denialCount for independently eligible activations; not full acceptance`
- **Unit:** `activations`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Verified inference-free eligible activations

- **What it tells you:** Verified inference-free eligible activations. This is a `diagnostic` measure.
- **Native measurement formula:** `inferenceFreeCount for independently eligible activations with complete audit`
- **Unit:** `activations`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Verified required limit messages

- **What it tells you:** Verified required limit messages. This is a `diagnostic` measure.
- **Native measurement formula:** `notificationCount for independently eligible activations; publication alone is not full acceptance`
- **Unit:** `activations`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Verified workflow-linked protected activations

- **What it tells you:** Verified workflow-linked protected activations. This is a `diagnostic` measure.
- **Native measurement formula:** `contributionCount; subset of acceptedCount with authenticated producer linkage, not exclusive causation`
- **Unit:** `activations`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** One source-profile-matching guardrail activation identified by repository ID, workflow blob, run ID and run attempt, timestamped at its guardrail scan start. Non-bypassed activations whose complete independent recorded 24-hour AIC total is at least 1 are eligible.
- **Collection:** Read one bounded digest-checked local native archive once per batch. Validate source, producer receipts, complete inventory, latest-attempt usage and outcome facets. Retained issue/PR lineage is discovery only. No network, checkout execution, dashboard query or campaign is required.
- **Observation window:** 1 days, sampled every 1 days
- **Maturation delay:** 0 days
- **Filters:** `Public repository ID 1036865607; selected workflow only; exact frozen source, compiled and checker blob identities.`; `Schedule activations and non-command routed workflow_dispatch only; direct/manual, malformed-context and command-driven dispatch bypasses are excluded under specification section 9.8.`; `Artifact-backend membership: complete same-workflow latest-completed-run inventory; createdAt >= scanStartAt minus 24 hours; exclude current run; count each run once, not each rerun.`; `Equality is exceeded under normative specification section 9.14, despite source prose saying more than 1.`; `Only independent recorded AIC establishes the recorded-usage threshold; it does not certify external billing. Estimated fallback, incomplete coverage, guardrail self-reported totals and missing pricing remain unassessed.`; `A failed job, intentional nonexistent-tool failure, per-run budget exhaustion or absent log is not a daily guardrail denial.`; `No acceptance before terminal opportunity disposition; inference audit covers all agent requests from activation through terminal disposition, including accepted requests lacking a response.`

The frozen goal, acceptance rule and formulas are applied to every observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `daily-credit-limit-test-timeline.json` artifact.

## Important limitation

This report measures accepted repository outcomes against the stated goal. Contract activation is not an intervention or proof that an agent caused the outcomes; unavailable historical evidence supports no historical improvement claim.

Value-function SHA-256: `0fb6eb98b12ca81fe712098e7eadeb869a17352ef4b3fcbabd780ba985d32a43`
