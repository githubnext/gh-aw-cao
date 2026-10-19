---
title: "What Daily Observability Report measures"
description: "Definitions, evidence rules, and interpretation for the Daily Observability Report operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** unknown percent; unavailable

**Measurement:** interval; 7-day window, 7-day cadence.

**Recent change:** unavailable: Fresh complete mature evidence is required for recent movement.

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Usable MCP coverage (percent) | Verified usable runs (runs) | Eligible opportunities | Evidence |
|---|---:|---:|---:|---|
| 2026-08-02T15:00:12Z | unknown | unknown | unknown | incomplete-evidence: No source-bound complete cohort inventory, immutable eligibility configuration and raw artifact bytes retained; historical source compatibility unverified. |
| 2026-08-09T15:00:12Z | unknown | unknown | unknown | incomplete-evidence: No source-bound complete cohort inventory, immutable eligibility configuration and raw artifact bytes retained; historical source compatibility unverified. |
| 2026-08-16T15:00:12Z | unknown | unknown | unknown | incomplete-evidence: No source-bound complete cohort inventory, immutable eligibility configuration and raw artifact bytes retained; historical source compatibility unverified. |
| 2026-08-23T15:00:12Z | unknown | unknown | unknown | incomplete-evidence: No source-bound complete cohort inventory, immutable eligibility configuration and raw artifact bytes retained; historical source compatibility unverified. |
| 2026-08-30T15:00:12Z | unknown | unknown | unknown | incomplete-evidence: No source-bound complete cohort inventory, immutable eligibility configuration and raw artifact bytes retained; historical source compatibility unverified. |
| 2026-09-06T15:00:12Z | unknown | unknown | unknown | incomplete-evidence: No source-bound complete cohort inventory, immutable eligibility configuration and raw artifact bytes retained; historical source compatibility unverified. |
| 2026-09-13T15:00:12Z | unknown | unknown | unknown | incomplete-evidence: No source-bound complete cohort inventory, immutable eligibility configuration and raw artifact bytes retained; historical source compatibility unverified. |
| 2026-09-20T15:00:12Z | unknown | unknown | unknown | incomplete-evidence: No source-bound complete cohort inventory, immutable eligibility configuration and raw artifact bytes retained; historical source compatibility unverified. |
| 2026-09-27T15:00:12Z | unknown | unknown | unknown | incomplete-evidence: No source-bound complete cohort inventory, immutable eligibility configuration and raw artifact bytes retained; historical source compatibility unverified. |
| 2026-10-04T15:00:12Z | unknown | unknown | unknown | incomplete-evidence: No source-bound complete cohort inventory, immutable eligibility configuration and raw artifact bytes retained; historical source compatibility unverified. |
| 2026-10-11T15:00:12Z | unknown | unknown | unknown | incomplete-evidence: No source-bound complete cohort inventory, immutable eligibility configuration and raw artifact bytes retained; historical source compatibility unverified. |
| 2026-10-18T15:00:12Z | unknown | unknown | unknown | incomplete-evidence: No source-bound complete cohort inventory, immutable eligibility configuration and raw artifact bytes retained; historical source compatibility unverified. |

The latest 12 periods are shown; the full native series is in the timeline.
Repository attainment includes other actors. Only a separately declared, independently verified contribution measure supports a workflow keep/change recommendation; it is not causal attribution.
Demonstrated workflow-enabled improvements count as shared contribution even when another agent or person implements them. Report measured progress, full goal completion, safeguards and attribution confidence separately. An unknown quality dimension does not cancel independently verified improvement; a merge alone does not verify that improvement.

## How to read the timeline

- Observations begin at workflow adoption on `2026-01-17`.
- No comparable pre-adoption evidence is available. Complete adjacent post-adoption periods may still show recent change, but not change relative to adoption.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Execution activity is diagnostic only. It does not prove repository value.
- Recent change compares the immediately preceding equal-duration period, not lifetime movement. Interval windows must abut without overlap; snapshot values compare cutoff states.
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- Adoption comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

**Goal:** Ensure MCP-enabled work has usable raw telemetry for debugging.

**Accepted outcome:** Independently inspect recursively discovered gateway.jsonl or rpc-messages.jsonl bytes, not report assertions.

### Usable MCP telemetry

- **What it tells you:** Usable MCP telemetry coverage. This is a `primary` measure.
- **Native measurement formula:** `100 * accepted / eligible, only for completely assessed selected MCP cohort; zero eligible is null`
- **Unit:** `percent`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Verified usable runs

- **What it tells you:** Independently verified usable MCP runs. This is a `diagnostic` measure.
- **Native measurement formula:** `accepted in the assessed subset; preserves established partial native evidence when other runs are missing`
- **Unit:** `runs`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** MCP-configured runs in an independently preserved source-capped seven-day cohort, not the repository fleet.
- **Collection:** Read retained, digest-checked cohort/configuration projections and raw artifact bytes once for all windows; no network. Missing producer inputs are null, not absent logging.
- **Observation window:** 7 days, sampled every 7 days
- **Maturation delay:** 0 days
- **Filters:** `At most 20 selected runs; normally at most two per workflow, third requires preserved repeated-critical-gap reason.`; `Preserve candidate inventory and selection rationale: failed/cancelled, firewall-enabled, MCP-configured, then recent successes.`; `Require immutable run configuration and exact source-profile binding; no eligibility from report text or successful status.`; `Seven-day disjoint interval windows; shorter leading period remains interim, not a complete weekly comparison.`

The frozen definitions and formulas are applied to every post-adoption observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `daily-observability-report-timeline.json` artifact.

## Important limitation

This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow.

Value-function SHA-256: `4bef54d77456292b2c30ad666bb5227b6599920cd2c0008cd6aae8ccfbc58de1`
