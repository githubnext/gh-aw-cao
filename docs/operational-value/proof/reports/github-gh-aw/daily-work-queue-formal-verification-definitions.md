---
title: "What Daily Work Queue Formal Verification measures"
description: "Definitions, evidence rules, and interpretation for the Daily Work Queue Formal Verification operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** 196955486 configuration-states; incomplete-evidence

**Measurement:** snapshot; 7-day window, 7-day cadence.

**Recent change:** unavailable: Fresh complete mature evidence is required for recent movement.

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Bounded search states (configuration-states) | Exhausted configurations (configurations) | Eligible opportunities | Evidence |
|---|---:|---:|---:|---|
| 2026-10-11T15:00:12Z | unknown | unknown | unknown | partial-window |
| 2026-10-15T14:35:14Z | unknown | unknown | unknown | incomplete-evidence |
| 2026-10-18T15:00:12Z | 196955486 | 1 | unknown | incomplete-evidence |

The latest 3 periods are shown; the full native series is in the timeline.
Repository attainment includes other actors. Only a separately declared, independently verified contribution measure supports a workflow keep/change recommendation; it is not causal attribution.
Demonstrated workflow-enabled improvements count as shared contribution even when another agent or person implements them. Report measured progress, full goal completion, safeguards and attribution confidence separately. An unknown quality dimension does not cancel independently verified improvement; a merge alone does not verify that improvement.

## How to read the timeline

- Observations begin at workflow adoption on `2026-10-08`.
- No comparable pre-adoption evidence is available. Complete adjacent post-adoption periods may still show recent change, but not change relative to adoption.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Execution activity is diagnostic only. It does not prove repository value.
- Recent change compares the immediately preceding equal-duration period, not lifetime movement. Interval windows must abut without overlap; snapshot values compare cutoff states.
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- Adoption comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

**Goal:** Deliver reproducible bounded exploration evidence for the two unresolved work-queue configurations.

**Accepted outcome:** Source-bound, checksum-pinned native TLC output independently establishes distinct-state counts for each fixed model/configuration. Unfinished searches are partial exploration, never proofs.

### Largest bounded search per configuration

- **What it tells you:** Largest bounded search per configuration. This is a `primary` measure.
- **Native measurement formula:** `Sum the largest observed distinct-state counts for the two fixed configurations; count shared states separately by configuration.`
- **Unit:** `configuration-states`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Exhausted fixed configurations

- **What it tells you:** Exhausted fixed configurations. This is a `diagnostic` measure.
- **Native measurement formula:** `Count configurations with an independently confirmed zero-queue, no-error native exhaustion, separately from partial exploration.`
- **Unit:** `configurations`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** The two fixed model/configuration state spaces at the frozen source revision.
- **Collection:** Protected native matrix-job artifacts, source/tool hashes and allowlisted raw TLC counter lines.
- **Observation window:** 7 days, sampled every 7 days
- **Maturation delay:** 0 days
- **Filters:** `Use the largest independently observed distinct-state count per unchanged configuration.`; `Repeated searches do not sum into new lifetime value; different model/configuration hashes are not comparable.`; `The primary cohort requires both configurations; missing evidence is not zero.`; `Bounded exploration is not invariant exhaustion, validated checkpoint recovery, unbounded proof, exclusive causation or measured cost.`

The frozen definitions and formulas are applied to every post-adoption observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `daily-work-queue-formal-verification-timeline.json` artifact.

## Important limitation

This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow.

Value-function SHA-256: `7e80db18e5ecbf52acd8cce52591ca27ab777f09281bc8c319720a4a02ee8cde`
