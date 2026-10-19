---
title: "What CLI Version Checker measures"
description: "Definitions, evidence rules, and interpretation for the CLI Version Checker operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** 1 pins; incomplete-evidence

**Measurement:** snapshot; 7-day window, 7-day cadence.

**Recent change:** unavailable: Fresh complete mature evidence is required for recent movement.

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Stale default pins (pins) | Known stale pins (pins) | Eligible opportunities | Evidence |
|---|---:|---:|---:|---|
| 2026-08-11T16:39:41Z | unknown | 0 | unknown | incomplete-evidence |
| 2026-08-18T16:39:41Z | unknown | 1 | unknown | incomplete-evidence |
| 2026-08-25T16:39:41Z | 1 | 1 | unknown | incomplete-evidence |
| 2026-09-01T16:39:41Z | 4 | 4 | unknown | incomplete-evidence |
| 2026-09-08T16:39:41Z | 6 | 6 | unknown | incomplete-evidence |
| 2026-09-15T16:39:41Z | 2 | 2 | unknown | incomplete-evidence |
| 2026-09-22T16:39:41Z | 3 | 3 | unknown | incomplete-evidence |
| 2026-09-29T16:39:41Z | 5 | 5 | unknown | incomplete-evidence |
| 2026-10-06T16:39:41Z | 6 | 6 | unknown | incomplete-evidence |
| 2026-10-11T15:00:12Z | 6 | 6 | unknown | incomplete-evidence |
| 2026-10-13T16:39:41Z | 0 | 0 | unknown | incomplete-evidence |
| 2026-10-18T15:00:12Z | 1 | 1 | unknown | incomplete-evidence |

The latest 12 periods are shown; the full native series is in the timeline.
Repository attainment includes other actors. Only a separately declared, independently verified contribution measure supports a workflow keep/change recommendation; it is not causal attribution.
Demonstrated workflow-enabled improvements count as shared contribution even when another agent or person implements them. Report measured progress, full goal completion, safeguards and attribution confidence separately. An unknown quality dimension does not cancel independently verified improvement; a merge alone does not verify that improvement.

## How to read the timeline

- Observations begin at workflow adoption on `2025-10-07`.
- No comparable pre-adoption evidence is available. Complete adjacent post-adoption periods may still show recent change, but not change relative to adoption.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Execution activity is diagnostic only. It does not prove repository value.
- Recent change compares the immediately preceding equal-duration period, not lifetime movement. Interval windows must abut without overlap; snapshot values compare cutoff states.
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- Adoption comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

**Goal:** Keep monitored default CLI/MCP versions current with independently published stable releases.

**Accepted outcome:** Compare actual immutable Go constants with surviving official release publications available at each endpoint.

### Stale pins in comparable eight-tool cohort

- **What it tells you:** Stale pins in comparable eight-tool cohort. This is a `primary` measure.
- **Native measurement formula:** `Count pins below the greatest matured surviving stable release, only when every frozen cohort pin is comparable.`
- **Unit:** `pins`
- **Goal:** Lower values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Known stale pins in partial evidence

- **What it tells you:** Known stale pins in partial evidence. This is a `diagnostic` measure.
- **Native measurement formula:** `Count demonstrated stale pins among those with comparable evidence; do not compare changing cohorts as complete delivery.`
- **Unit:** `pins`
- **Goal:** Lower values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** The frozen eight-tool default-version cohort named by the source workflow.
- **Collection:** Digest-checked immutable constants and normalized exhaustive surviving official publication metadata.
- **Observation window:** 7 days, sampled every 7 days
- **Maturation delay:** 0 days
- **Filters:** `Compare numeric stable semantic versions, not lexicographic strings or mutable latest tags.`; `The primary series requires all eight pins to have comparable surviving release evidence.`; `Partial historical evidence remains a diagnostic; missing pins or publication records are unknown.`; `Playwright releases mature for three days according to its source-defined installation cooldown.`; `Deleted releases, historical latest-tag movements, Docker digests, compatibility, research quality and causation are not established.`

The frozen definitions and formulas are applied to every post-adoption observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `cli-version-checker-timeline.json` artifact.

## Important limitation

This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow.

Value-function SHA-256: `e2dcf81731961b95bfd303973c0cc66c3c7e6fff4939e716ef3156a86bd7146f`
