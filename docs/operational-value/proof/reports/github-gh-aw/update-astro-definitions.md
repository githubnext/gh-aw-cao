---
title: "What Update Astro measures"
description: "Definitions, evidence rules, and interpretation for the Update Astro operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** 9 packages; complete

**Measurement:** snapshot; 7-day window, 7-day cadence.

**Recent change:** +1 packages

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Stale direct packages (packages) | Known stale packages (packages) | Eligible opportunities | Evidence |
|---|---:|---:|---:|---|
| 2026-08-11T13:10:10Z | unknown | 0 | 18 | incomplete-evidence |
| 2026-08-18T13:10:10Z | unknown | 1 | 18 | incomplete-evidence |
| 2026-08-25T13:10:10Z | unknown | 6 | 18 | incomplete-evidence |
| 2026-09-01T13:10:10Z | unknown | 6 | 18 | incomplete-evidence |
| 2026-09-08T13:10:10Z | unknown | 9 | 18 | incomplete-evidence |
| 2026-09-15T13:10:10Z | unknown | 7 | 18 | incomplete-evidence |
| 2026-09-22T13:10:10Z | unknown | 0 | 18 | incomplete-evidence |
| 2026-09-29T13:10:10Z | unknown | 0 | 18 | incomplete-evidence |
| 2026-10-06T13:10:10Z | 3 | 3 | 18 | complete |
| 2026-10-11T15:00:12Z | 8 | 8 | 18 | complete |
| 2026-10-13T13:10:10Z | 8 | 8 | 18 | complete |
| 2026-10-18T15:00:12Z | 9 | 9 | 18 | complete |

The latest 12 periods are shown; the full native series is in the timeline.
Repository attainment includes other actors. Only a separately declared, independently verified contribution measure supports a workflow keep/change recommendation; it is not causal attribution.
Demonstrated workflow-enabled improvements count as shared contribution even when another agent or person implements them. Report measured progress, full goal completion, safeguards and attribution confidence separately. An unknown quality dimension does not cancel independently verified improvement; a merge alone does not verify that improvement.

## How to read the timeline

- Observations begin at workflow adoption on `2026-03-17`.
- No comparable pre-adoption evidence is available. Complete adjacent post-adoption periods may still show recent change, but not change relative to adoption.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Execution activity is diagnostic only. It does not prove repository value.
- Recent change compares the immediately preceding equal-duration period, not lifetime movement. Interval windows must abut without overlap; snapshot values compare cutoff states.
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- Adoption comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

**Goal:** Keep the documentation site's direct npm dependencies current with official stable publications.

**Accepted outcome:** Immutable manifest and lockfile agree; native locked versions are compared with independently dated surviving official releases. Migration correctness and successful builds remain separate.

### Stale direct packages in the complete cohort

- **What it tells you:** Stale direct packages in the complete cohort. This is a `primary` measure.
- **Native measurement formula:** `Count aligned, locked direct dependencies below the greatest surviving official stable release published by the endpoint.`
- **Unit:** `packages`
- **Goal:** Lower values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Known stale direct packages in partial history

- **What it tells you:** Known stale direct packages in partial history. This is a `diagnostic` measure.
- **Native measurement formula:** `Count aligned, locked direct dependencies below the greatest surviving official stable release published by the endpoint.`
- **Unit:** `packages`
- **Goal:** Lower values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** The fixed direct production/development dependency cohort from the frozen source manifest.
- **Collection:** Digest-checked immutable manifest/lock blobs and normalized official npm publication histories.
- **Observation window:** 7 days, sampled every 7 days
- **Maturation delay:** 0 days
- **Filters:** `Compare actual locked versions, not lower bounds of caret/tilde declarations or agent update claims.`; `Both the root lock declarations and each native lock pin must satisfy the source manifest.`; `Require the full frozen cohort for the primary comparison; partial history is a separate diagnostic.`; `Use dated surviving numeric stable releases; mutable latest-channel history and deleted releases are not reconstructed.`; `Package currency is not migration correctness, build compatibility, transitives, overrides or exclusive workflow contribution.`

The frozen definitions and formulas are applied to every post-adoption observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `update-astro-timeline.json` artifact.

## Important limitation

This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow.

Value-function SHA-256: `eb3e31e47df76e9897c19fbba40d6881349a3507c18fca7862f519fcca84e0c5`
