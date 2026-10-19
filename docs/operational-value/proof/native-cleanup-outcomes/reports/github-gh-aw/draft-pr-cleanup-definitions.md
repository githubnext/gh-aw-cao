---
title: "What Draft Pr Cleanup measures"
description: "Definitions, evidence rules, and interpretation for the Draft Pr Cleanup operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** unknown verified inactive drafts retired; unavailable

**Measurement:** interval; 7-day window, 7-day cadence.

**Recent change:** unavailable: Fresh complete mature evidence is required for recent movement.

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Verified closures (verified inactive drafts retired) | Receipt-linked (verified inactive drafts retired) | Full goal (complete accepted goals) | Eligible opportunities | Evidence |
|---|---:|---:|---:|---:|---|
| 2026-08-02T15:00:12Z | unknown | unknown | unknown | unknown | incomplete-evidence: No independently accepted native closure retained in this period; zero cannot be inferred. |
| 2026-08-09T15:00:12Z | unknown | unknown | unknown | unknown | incomplete-evidence: No independently accepted native closure retained in this period; zero cannot be inferred. |
| 2026-08-16T15:00:12Z | unknown | unknown | unknown | unknown | incomplete-evidence: No independently accepted native closure retained in this period; zero cannot be inferred. |
| 2026-08-23T15:00:12Z | unknown | unknown | unknown | unknown | incomplete-evidence: No independently accepted native closure retained in this period; zero cannot be inferred. |
| 2026-08-30T15:00:12Z | unknown | unknown | unknown | unknown | incomplete-evidence: No independently accepted native closure retained in this period; zero cannot be inferred. |
| 2026-09-06T15:00:12Z | unknown | unknown | unknown | unknown | incomplete-evidence: No independently accepted native closure retained in this period; zero cannot be inferred. |
| 2026-09-13T15:00:12Z | unknown | unknown | unknown | unknown | incomplete-evidence: No independently accepted native closure retained in this period; zero cannot be inferred. |
| 2026-09-20T15:00:12Z | unknown | unknown | unknown | unknown | incomplete-evidence: No independently accepted native closure retained in this period; zero cannot be inferred. |
| 2026-09-27T15:00:12Z | unknown | unknown | unknown | unknown | incomplete-evidence: No independently accepted native closure retained in this period; zero cannot be inferred. |
| 2026-10-04T15:00:12Z | unknown | unknown | unknown | unknown | incomplete-evidence: No independently accepted native closure retained in this period; zero cannot be inferred. |
| 2026-10-11T15:00:12Z | unknown | unknown | unknown | unknown | incomplete-evidence: No independently accepted native closure retained in this period; zero cannot be inferred. |
| 2026-10-18T15:00:12Z | unknown | unknown | unknown | unknown | incomplete-evidence: No independently accepted native closure retained in this period; zero cannot be inferred. |

The latest 12 periods are shown; the full native series is in the timeline.
Repository attainment includes other actors. Only a separately declared, independently verified contribution measure supports a workflow keep/change recommendation; it is not causal attribution.
Demonstrated workflow-enabled improvements count as shared contribution even when another agent or person implements them. Report measured progress, full goal completion, safeguards and attribution confidence separately. An unknown quality dimension does not cancel independently verified improvement; a merge alone does not verify that improvement.

## How to read the timeline

- Observations begin at workflow adoption on `2026-01-28`.
- No comparable pre-adoption evidence is available. Complete adjacent post-adoption periods may still show recent change, but not change relative to adoption.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Execution activity is diagnostic only. It does not prove repository value.
- Recent change compares the immediately preceding equal-duration period, not lifetime movement. Interval windows must abut without overlap; snapshot values compare cutoff states.
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- Adoption comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

**Goal:** Retire inactive draft PRs to reduce clutter and triage burden.

**Accepted outcome:** Independently verified source-eligible inactive draft PR closures. Historical draft state, actual inactivity and exemption state, and open-to-closed-unmerged transition are required independently of the cleanup comment.

### verified inactive drafts retired

- **What it tells you:** verified inactive drafts retired. This is a `primary` measure.
- **Native measurement formula:** `Count unique independently verified source-eligible closures delivered in [start,end); null without native evidence.`
- **Unit:** `verified inactive drafts retired`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Receipt-linked closures

- **What it tells you:** Receipt-linked closures. This is a `diagnostic` measure.
- **Native measurement formula:** `Subset of native closures joined to actual source/runtime/application receipts; null without those receipts.`
- **Unit:** `verified inactive drafts retired`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Full goal completion

- **What it tells you:** Full goal completion. This is a `diagnostic` measure.
- **Native measurement formula:** `Null until all original acceptance and safeguards, complete eligible population and historical state are established.`
- **Unit:** `complete accepted goals`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** Bounded discovery-selected public output entities, not an eligible-opportunity census.
- **Collection:** Digest-checked retained provider originals; independent event replay and historical graph reconciliation; no network, Git, target execution or model calls.
- **Observation window:** 7 days, sampled every 7 days
- **Maturation delay:** 0 days
- **Filters:** `Frozen cutoff 2026-10-18T15:00:12Z`; `No activity/prose-only acceptance`; `Unknown periods stay null`

The frozen definitions and formulas are applied to every post-adoption observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `draft-pr-cleanup-timeline.json` artifact.

## Important limitation

This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow.

Value-function SHA-256: `e5561851ddcee394f028fa5a2966692d933a310af8479e259e59e780a5d3b0ef`
