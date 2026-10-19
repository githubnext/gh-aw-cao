---
title: "What Instructions Janitor measures"
description: "Definitions, evidence rules, and interpretation for the Instructions Janitor operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** 0 lines; complete

**Measurement:** snapshot; 7-day window, 7-day cadence.

**Recent change:** -32 lines

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Excess instruction lines (lines) | Oversized files (files) | Eligible opportunities | Evidence |
|---|---:|---:|---:|---|
| 2026-08-13T14:54:52Z | 0 | 0 | 68 | complete |
| 2026-08-20T14:54:52Z | 6 | 1 | 70 | complete |
| 2026-08-27T14:54:52Z | 0 | 0 | 72 | complete |
| 2026-09-03T14:54:52Z | 0 | 0 | 75 | complete |
| 2026-09-10T14:54:52Z | 0 | 0 | 75 | complete |
| 2026-09-17T14:54:52Z | 0 | 0 | 75 | complete |
| 2026-09-24T14:54:52Z | 0 | 0 | 75 | complete |
| 2026-10-01T14:54:52Z | 0 | 0 | 75 | complete |
| 2026-10-08T14:54:52Z | 0 | 0 | 76 | complete |
| 2026-10-11T15:00:12Z | 32 | 1 | 78 | complete |
| 2026-10-15T14:54:52Z | 0 | 0 | 80 | complete |
| 2026-10-18T15:00:12Z | 0 | 0 | 82 | complete |

The latest 12 periods are shown; the full native series is in the timeline.
Repository attainment includes other actors. Only a separately declared, independently verified contribution measure supports a workflow keep/change recommendation; it is not causal attribution.
Demonstrated workflow-enabled improvements count as shared contribution even when another agent or person implements them. Report measured progress, full goal completion, safeguards and attribution confidence separately. An unknown quality dimension does not cancel independently verified improvement; a merge alone does not verify that improvement.

## How to read the timeline

- Observations begin at workflow adoption on `2025-10-23`.
- No comparable pre-adoption evidence is available. Complete adjacent post-adoption periods may still show recent change, but not change relative to adoption.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Execution activity is diagnostic only. It does not prove repository value.
- Recent change compares the immediately preceding equal-duration period, not lifetime movement. Interval windows must abut without overlap; snapshot values compare cutoff states.
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- Adoption comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

**Goal:** Keep direct Markdown instruction files within the source's explicit 400-line size-audit ceiling.

**Accepted outcome:** At each immutable mainline endpoint, native wc -l finds no direct .github/aw/*.md file over 400 newline characters. This is the hard size-audit facet, not the stricter per-file layout targets or full instruction quality.

### Instruction lines over the audit ceiling

- **What it tells you:** Instruction lines over the audit ceiling. This is a `primary` measure.
- **Native measurement formula:** `Sum max(0, native wc -l count minus 400) across direct regular .github/aw/*.md files.`
- **Unit:** `lines`
- **Goal:** Lower values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Instruction files over the audit ceiling

- **What it tells you:** Instruction files over the audit ceiling. This is a `diagnostic` measure.
- **Native measurement formula:** `Count direct regular .github/aw/*.md files whose native wc -l count exceeds 400.`
- **Unit:** `files`
- **Goal:** Lower values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** All direct regular .github/aw/*.md files at each retained immutable mainline endpoint.
- **Collection:** Retained immutable Git trees and blobs, native wc binary identity and probes, weekly/adoption/cutoff states and source-policy history.
- **Observation window:** 7 days, sampled every 7 days
- **Maturation delay:** 0 days
- **Filters:** `Use native wc -l newline counts, including CRLF and unterminated-file semantics, not rendered lines or words.`; `The explicit audit says over 400, so exactly 400 is not over this ceiling; stricter layout targets remain separate.`; `Do not count nested files, non-Markdown files or symlink text as direct instruction-file contents.`; `A missing directory, unsupported entry or unsupported source policy is not established compliance.`; `Retain current-reference quantities through older intent eras but require the same explicit policy throughout compared windows.`; `Show the changing file population; deleting files or moving content does not establish preserved information.`; `Snapshots are repository conditions, not fresh workflow deliveries. Accuracy, duplication, content preservation, attribution and costs remain unmeasured.`

The frozen definitions and formulas are applied to every post-adoption observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `instructions-janitor-timeline.json` artifact.

## Important limitation

This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow.

Value-function SHA-256: `a13d0df33b14408a7f15070a8c07f3812d18725757b2c57d4408cb50b8deb402`
