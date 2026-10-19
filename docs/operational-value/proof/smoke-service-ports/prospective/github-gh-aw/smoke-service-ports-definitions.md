---
title: "What Smoke Service Ports measures"
description: "Definitions, evidence rules, and interpretation for the Smoke Service Ports operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** unknown cases; unavailable

**Measurement:** interval; 2-day window, 2-day cadence.

**Recent change:** unavailable: Fresh complete mature evidence is required for recent movement.

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Verified Redis cases (cases) | Host-bound sessions (sessions) | Workflow contributions (cases) | Eligible opportunities | Evidence |
|---|---:|---:|---:|---:|---|
| 2026-10-19T11:34:50Z | unknown | unknown | unknown | unknown | partial-window: No authenticated event in this cohort; incomplete population is not an observed zero. |

The latest 1 periods are shown; the full native series is in the timeline.
Repository attainment includes other actors. Only a separately declared, independently verified contribution measure supports a workflow keep/change recommendation; it is not causal attribution.
Demonstrated workflow-enabled improvements count as shared contribution even when another agent or person implements them. Report measured progress, full goal completion, safeguards and attribution confidence separately. An unknown quality dimension does not cancel independently verified improvement; a merge alone does not verify that improvement.

## How to read the timeline

- The measurement contract was activated on `2026-10-19`; this is not a workflow adoption date.
- No historical reference has been established.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Execution activity is diagnostic only. It does not prove repository value.
- Recent change compares the immediately preceding equal-duration period, not lifetime movement. Interval windows must abut without overlap; snapshot values compare cutoff states.
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- Historical reference comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

**Goal:** Verify sandbox host-service-port access to Redis end-to-end.

**Accepted outcome:** All three cases in one session, with independently observed sandbox-to-host endpoint binding.

### Verified Redis cases

- **What it tells you:** Verified Redis cases. This is a `primary` measure.
- **Native measurement formula:** `sum over distinct sessions of independently authenticated PONG, SET/GET round-trip and INFO server cases`
- **Unit:** `cases`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Full host-bound integration sessions

- **What it tells you:** Full host-bound integration sessions. This is a `diagnostic` measure.
- **Native measurement formula:** `count distinct sessions with all three cases plus independently demonstrated sandbox-to-host.docker.internal:6379 binding`
- **Unit:** `sessions`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Receipt-linked workflow contributions

- **What it tells you:** Receipt-linked workflow contributions. This is a `diagnostic` measure.
- **Native measurement formula:** `count accepted Redis cases with an independent matching workflow run/head/attempt/client/service receipt`
- **Unit:** `cases`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** Independent service/client observations of a Redis test session, regardless of actor.
- **Collection:** Offline original run/attempt jobs and protected execution logs corroborate exact provider-digest-verified artifact tool calls. Recompute byte-framed PONG, SET/GET and projected INFO from those original payloads; caller flags cannot admit operations.
- **Observation window:** 2 days, sampled every 2 days
- **Maturation delay:** 0 days
- **Filters:** `Count each source-defined case at most once per service lifetime/session.`; `Use actual completed-operation timestamps in inclusive-start/exclusive-end disjoint event cohorts.`; `An independently proven partial protocol case does not require all broader safeguards.`; `Do not accept workflow success, editable issue lineage, agent summaries, digest-shaped flags or declared service health as end-to-end Redis proof.`; `No restart durability requirement; a GET without an observed preceding successful SET is not a round-trip.`

The frozen goal, acceptance rule and formulas are applied to every observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `smoke-service-ports-timeline.json` artifact.

## Important limitation

This report measures accepted repository outcomes against the stated goal. Contract activation is not an intervention or proof that an agent caused the outcomes; unavailable historical evidence supports no historical improvement claim.

Value-function SHA-256: `ddb0db3bc0dc9b571394f5c5bc59646948e085160e82f04cbfb7e361c6c8d62a`
