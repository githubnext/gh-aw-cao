---
title: "What unbloat-docs measures"
description: "Definitions, evidence rules, and interpretation for the unbloat-docs operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** unknown content-preserving duplicate occurrences removed; unavailable

**Measurement:** interval; 7-day window, 7-day cadence.

**Recent change:** unavailable: Fresh complete mature evidence is required for recent movement.

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Native partial outcomes (content-preserving duplicate occurrences removed) | Full goal completion (fully verified documentation outcomes) | Verified contribution (receipt-verified contributed outcomes) | Eligible opportunities | Evidence |
|---|---:|---:|---:|---:|---|
| 2026-08-02T15:00:12Z | unknown | unknown | unknown | 0 | incomplete-evidence: No acquired eligible native case in this period; bounded candidate selection is not an exhaustive native opportunity population. |
| 2026-08-09T15:00:12Z | unknown | unknown | unknown | 0 | incomplete-evidence: No acquired eligible native case in this period; bounded candidate selection is not an exhaustive native opportunity population. |
| 2026-08-16T15:00:12Z | unknown | unknown | unknown | 0 | incomplete-evidence: No acquired eligible native case in this period; bounded candidate selection is not an exhaustive native opportunity population. |
| 2026-08-23T15:00:12Z | unknown | unknown | unknown | 0 | incomplete-evidence: No acquired eligible native case in this period; bounded candidate selection is not an exhaustive native opportunity population. |
| 2026-08-30T15:00:12Z | unknown | unknown | unknown | 0 | incomplete-evidence: No acquired eligible native case in this period; bounded candidate selection is not an exhaustive native opportunity population. |
| 2026-09-06T15:00:12Z | unknown | unknown | unknown | 0 | incomplete-evidence: No acquired eligible native case in this period; bounded candidate selection is not an exhaustive native opportunity population. |
| 2026-09-13T15:00:12Z | unknown | unknown | unknown | 0 | incomplete-evidence: No acquired eligible native case in this period; bounded candidate selection is not an exhaustive native opportunity population. |
| 2026-09-20T15:00:12Z | unknown | unknown | unknown | 0 | incomplete-evidence: No acquired eligible native case in this period; bounded candidate selection is not an exhaustive native opportunity population. |
| 2026-09-27T15:00:12Z | unknown | unknown | unknown | 0 | incomplete-evidence: No acquired eligible native case in this period; bounded candidate selection is not an exhaustive native opportunity population. |
| 2026-10-04T15:00:12Z | unknown | unknown | unknown | 0 | incomplete-evidence: No acquired eligible native case in this period; bounded candidate selection is not an exhaustive native opportunity population. |
| 2026-10-11T15:00:12Z | unknown | unknown | unknown | 0 | incomplete-evidence: No acquired eligible native case in this period; bounded candidate selection is not an exhaustive native opportunity population. |
| 2026-10-18T15:00:12Z | unknown | unknown | unknown | 0 | incomplete-evidence: No acquired eligible native case in this period; bounded candidate selection is not an exhaustive native opportunity population. |

The latest 12 periods are shown; the full native series is in the timeline.
Repository attainment includes other actors. Only a separately declared, independently verified contribution measure supports a workflow keep/change recommendation; it is not causal attribution.
Demonstrated workflow-enabled improvements count as shared contribution even when another agent or person implements them. Report measured progress, full goal completion, safeguards and attribution confidence separately. An unknown quality dimension does not cancel independently verified improvement; a merge alone does not verify that improvement.

## How to read the timeline

- Observations begin at workflow adoption on `2025-10-10`.
- No comparable pre-adoption evidence is available. Complete adjacent post-adoption periods may still show recent change, but not change relative to adoption.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Execution activity is diagnostic only. It does not prove repository value.
- Recent change compares the immediately preceding equal-duration period, not lifetime movement. Interval windows must abut without overlap; snapshot values compare cutoff states.
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- Adoption comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

**Goal:** Reduce documentation verbosity while preserving clarity and completeness.

**Accepted outcome:** Deletion-only removal of one or more exact repeated prose paragraphs within the same heading context, retaining at least one byte-identical occurrence and all distinct paragraphs in order. Do not treat code, links, headings, frontmatter, warnings or Mermaid as disposable paragraphs.

### Native partial outcomes

- **What it tells you:** Native partial outcomes. This is a `primary` measure.
- **Native measurement formula:** `Sum accepted content-preserving duplicate occurrences removed across original native cases in [windowStart,windowEnd); null when unassessed.`
- **Unit:** `content-preserving duplicate occurrences removed`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Full goal completion

- **What it tells you:** Full goal completion. This is a `diagnostic` measure.
- **Native measurement formula:** `Sum accepted fully verified documentation outcomes across original native cases in [windowStart,windowEnd); null when unassessed.`
- **Unit:** `fully verified documentation outcomes`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Verified contribution

- **What it tells you:** Verified contribution. This is a `diagnostic` measure.
- **Native measurement formula:** `Sum accepted receipt-verified contributed outcomes across original native cases in [windowStart,windowEnd); null when unassessed.`
- **Unit:** `receipt-verified contributed outcomes`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** One changed eligible markdown document under docs/src/content/docs, excluding blog, generated frontmatter-full.md and protected files.
- **Collection:** Offline original Git custody and complete production issue/PR discovery. Bounded candidate cohort; missing originals and Discussions remain gaps, not zero delivery.
- **Observation window:** 7 days, sampled every 7 days
- **Maturation delay:** 0 days
- **Filters:** `Deletion-only removal of one or more exact repeated prose paragraphs within the same heading context, retaining at least one byte-identical occurrence and all distinct paragraphs in order. Do not treat code, links, headings, frontmatter, warnings or Mermaid as disposable paragraphs.`; `Frozen-source fixed-reference predicates can assess historical native facts but cannot establish that later intent was applicable at their time.`

The frozen definitions and formulas are applied to every post-adoption observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `unbloat-docs-timeline.json` artifact.

## Important limitation

This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow.

Value-function SHA-256: `6570d5cc017ebc3f722718fdf7e3b687c82aeaebb83c96b6dc0e2c22768b6e29`
