---
title: "What Daily Spec Coverage Review measures"
description: "Definitions, evidence rules, and interpretation for the Daily Spec Coverage Review operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** 0 links; complete

**Measurement:** snapshot; 7-day window, 7-day cadence.

**Recent change:** 0 links

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Broken local links (links) | Observed broken links (links) | Missing descriptions (files) | Eligible opportunities | Evidence |
|---|---:|---:|---:|---:|---|
| 2026-08-14T19:10:33Z | 0 | 0 | 8 | 186 | complete |
| 2026-08-21T19:10:33Z | 0 | 0 | 9 | 201 | complete |
| 2026-08-28T19:10:33Z | 0 | 0 | 1 | 232 | complete |
| 2026-09-04T19:10:33Z | 0 | 0 | 2 | 237 | complete |
| 2026-09-11T19:10:33Z | 0 | 0 | 2 | 237 | complete |
| 2026-09-18T19:10:33Z | 0 | 0 | 2 | 238 | complete |
| 2026-09-25T19:10:33Z | 0 | 0 | 2 | 238 | complete |
| 2026-10-02T19:10:33Z | 0 | 0 | 2 | 239 | complete |
| 2026-10-09T19:10:33Z | 0 | 0 | 0 | 254 | complete |
| 2026-10-11T15:00:12Z | 0 | 0 | 0 | 259 | complete |
| 2026-10-16T19:10:33Z | 0 | 0 | 0 | 275 | complete |
| 2026-10-18T15:00:12Z | 0 | 0 | 0 | 288 | complete |

The latest 12 periods are shown; the full native series is in the timeline.
Repository attainment includes other actors. Only a separately declared, independently verified contribution measure supports a workflow keep/change recommendation; it is not causal attribution.
Demonstrated workflow-enabled improvements count as shared contribution even when another agent or person implements them. Report measured progress, full goal completion, safeguards and attribution confidence separately. An unknown quality dimension does not cancel independently verified improvement; a merge alone does not verify that improvement.

## How to read the timeline

- Observations begin at workflow adoption on `2026-08-07`.
- No comparable pre-adoption evidence is available. Complete adjacent post-adoption periods may still show recent change, but not change relative to adoption.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Execution activity is diagnostic only. It does not prove repository value.
- Recent change compares the immediately preceding equal-duration period, not lifetime movement. Interval windows must abut without overlap; snapshot values compare cutoff states.
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- Adoption comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

**Goal:** Keep repository specifications free of broken local references and missing description frontmatter.

**Accepted outcome:** Partial facet: the complete top-level .github/aw Markdown scan under the frozen read-only scanner rules finds actual missing repository-contained Markdown targets. Ignore examples and external URLs; preserve unavailable symlink evidence.

### Broken local links

- **What it tells you:** Broken local specification references. This is a `primary` measure.
- **Native measurement formula:** `qualifying inline local Markdown references whose contained regular-file target is absent`
- **Unit:** `links`
- **Goal:** Lower values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Observed broken links

- **What it tells you:** Observed broken-reference subtotal. This is a `diagnostic` measure.
- **Native measurement formula:** `known broken references without treating unresolved symlinks as clean`
- **Unit:** `links`
- **Goal:** Lower values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Missing descriptions

- **What it tells you:** Specifications missing description frontmatter. This is a `diagnostic` measure.
- **Native measurement formula:** `scanned specifications without the scanner-required description frontmatter key`
- **Unit:** `files`
- **Goal:** Lower values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** All top-level .github/aw/*.md files and their qualifying local Markdown references.
- **Collection:** Replay preserved blob-derived reference facts and complete target lookups for immutable weekly states.
- **Observation window:** 7 days, sampled every 7 days
- **Maturation delay:** 0 days
- **Filters:** `Complete source trees at immutable first-parent revisions, not a truncated grep sample.`; `Frozen current scanner rules are a comparable partial facet, not proof every historical agent used that scanner.`; `Unresolved symlink paths are unknown, not broken or clean.`; `Repository state is not fresh delivered contribution and does not establish workflow causation.`; `Related-issue discovery, broader semantic documentation quality and costs remain unmeasured.`

The frozen definitions and formulas are applied to every post-adoption observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `daily-spec-coverage-kiro-timeline.json` artifact.

## Important limitation

This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow.

Value-function SHA-256: `18a7d884d7582221027be102b1c445fff585f48b82668df56ce2cb5e20374901`
