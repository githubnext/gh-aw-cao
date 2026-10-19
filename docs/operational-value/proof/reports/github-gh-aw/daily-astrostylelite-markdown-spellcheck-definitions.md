---
title: "What Daily AstroStyleLite Markdown Spellcheck measures"
description: "Definitions, evidence rules, and interpretation for the Daily AstroStyleLite Markdown Spellcheck operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** 2499 diagnostics; complete

**Measurement:** snapshot; 7-day window, 7-day cadence.

**Recent change:** +64 diagnostics

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Native diagnostics (diagnostics) | Forbidden words (diagnostics) | Ordinary unknown words (diagnostics) | Eligible opportunities | Evidence |
|---|---:|---:|---:|---:|---|
| 2026-08-10T05:42:44Z | 1821 | 0 | 1821 | 203 | complete |
| 2026-08-17T05:42:44Z | 1863 | 0 | 1863 | 207 | complete |
| 2026-08-24T05:42:44Z | 1932 | 0 | 1932 | 216 | complete |
| 2026-08-31T05:42:44Z | 1965 | 0 | 1965 | 220 | complete |
| 2026-09-07T05:42:44Z | 2022 | 0 | 2022 | 228 | complete |
| 2026-09-14T05:42:44Z | 2068 | 0 | 2068 | 234 | complete |
| 2026-09-21T05:42:44Z | 2066 | 0 | 2066 | 235 | complete |
| 2026-09-28T05:42:44Z | 2036 | 0 | 2036 | 241 | complete |
| 2026-10-05T05:42:44Z | 2127 | 0 | 2127 | 248 | complete |
| 2026-10-11T15:00:12Z | 2435 | 0 | 2435 | 255 | complete |
| 2026-10-12T05:42:44Z | 2446 | 0 | 2446 | 256 | complete |
| 2026-10-18T15:00:12Z | 2499 | 0 | 2499 | 259 | complete |

The latest 12 periods are shown; the full native series is in the timeline.
Repository attainment includes other actors. Only a separately declared, independently verified contribution measure supports a workflow keep/change recommendation; it is not causal attribution.
Demonstrated workflow-enabled improvements count as shared contribution even when another agent or person implements them. Report measured progress, full goal completion, safeguards and attribution confidence separately. An unknown quality dimension does not cancel independently verified improvement; a merge alone does not verify that improvement.

## How to read the timeline

- Observations begin at workflow adoption on `2026-04-20`.
- No comparable pre-adoption evidence is available. Complete adjacent post-adoption periods may still show recent change, but not change relative to adoption.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Execution activity is diagnostic only. It does not prove repository value.
- Recent change compares the immediately preceding equal-duration period, not lifetime movement. Interval windows must abut without overlap; snapshot values compare cutoff states.
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- Adoption comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

**Goal:** Reduce independently reported American English spelling diagnostics in the documentation.

**Accepted outcome:** Pinned CSpell 8.19.4 checks immutable Markdown/MDX with one frozen source-native configuration and technical dictionary. Ordinary unknown words count even when isFlagged is false; language correctness and workflow causation remain separate.

### Native spelling diagnostics

- **What it tells you:** Native spelling diagnostics. This is a `primary` measure.
- **Native measurement formula:** `Count every independently reported native spelling issue, including ordinary unknown words.`
- **Unit:** `diagnostics`
- **Goal:** Lower values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Native forbidden-word diagnostics

- **What it tells you:** Native forbidden-word diagnostics. This is a `diagnostic` measure.
- **Native measurement formula:** `Count native issues explicitly marked isFlagged true by the checker.`
- **Unit:** `diagnostics`
- **Goal:** Lower values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Native ordinary unknown-word diagnostics

- **What it tells you:** Native ordinary unknown-word diagnostics. This is a `diagnostic` measure.
- **Native measurement formula:** `Count native issues with isFlagged false; these are still included by the workflow's native jq filter.`
- **Unit:** `diagnostics`
- **Goal:** Lower values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** Every tracked regular Markdown/MDX file under docs/src/content/ at the weekly endpoint.
- **Collection:** Hash-verified immutable Git/LFS inputs, pinned dependency lock/tool files and normalized native JSON checker reports.
- **Observation window:** 7 days, sampled every 7 days
- **Maturation delay:** 0 days
- **Filters:** `Replay the same frozen current native dictionary/configuration across history, not historical npm installations or changing allowlists.`; `Count all native spelling issues. isFlagged means forbidden-word status, not whether an ordinary unknown word is a diagnostic.`; `Verify the source filter with native jq: its // operator defaults false as well as null, so ordinary unknown words remain counted.`; `Internal document waivers remain native policy. Changed waiver policy makes that interval non-comparable, not a proven spelling repair.`; `Native diagnostics are checker output under its native limits, not a count of linguistically proven misspellings.`; `An absent configuration, source, runtime error or incomplete cohort is unknown, never a clean spellcheck.`; `Pinned local Node/platform replay is not a reconstruction of historical hosted runs or attribution to this workflow.`

The frozen definitions and formulas are applied to every post-adoption observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `daily-astrostylelite-markdown-spellcheck-timeline.json` artifact.

## Important limitation

This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow.

Value-function SHA-256: `08759e0a2ede8b2947cba2f22b2bddf2b225e747c88c95690fa6d658a73f4da0`
