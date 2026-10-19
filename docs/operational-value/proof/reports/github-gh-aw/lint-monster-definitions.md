---
title: "What LintMonster measures"
description: "Definitions, evidence rules, and interpretation for the LintMonster operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** 539 functions; complete

**Measurement:** snapshot; 7-day window, 7-day cadence.

**Recent change:** -11 functions

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Overlength bodies (functions) | Unsuppressed bodies (functions) | Suppressed bodies (functions) | Eligible opportunities | Evidence |
|---|---:|---:|---:|---:|---|
| 2026-08-15T19:21:56Z | 681 | 681 | 0 | 8625 | complete |
| 2026-08-22T19:21:56Z | 675 | 675 | 0 | 9086 | complete |
| 2026-08-29T19:21:56Z | 646 | 633 | 13 | 9618 | complete |
| 2026-09-05T19:21:56Z | 632 | 546 | 86 | 10022 | complete |
| 2026-09-12T19:21:56Z | 620 | 514 | 106 | 10303 | complete |
| 2026-09-19T19:21:56Z | 602 | 493 | 109 | 10329 | complete |
| 2026-09-26T19:21:56Z | 596 | 475 | 121 | 10484 | complete |
| 2026-10-03T19:21:56Z | 586 | 460 | 126 | 10839 | complete |
| 2026-10-10T19:21:56Z | 563 | 434 | 129 | 11922 | complete |
| 2026-10-11T15:00:12Z | 550 | 421 | 129 | 11978 | complete |
| 2026-10-17T19:21:56Z | 539 | 404 | 135 | 12591 | complete |
| 2026-10-18T15:00:12Z | 539 | 404 | 135 | 12608 | complete |

The latest 12 periods are shown; the full native series is in the timeline.
Repository attainment includes other actors. Only a separately declared, independently verified contribution measure supports a workflow keep/change recommendation; it is not causal attribution.
Demonstrated workflow-enabled improvements count as shared contribution even when another agent or person implements them. Report measured progress, full goal completion, safeguards and attribution confidence separately. An unknown quality dimension does not cancel independently verified improvement; a merge alone does not verify that improvement.

## How to read the timeline

- Observations begin at workflow adoption on `2026-05-16`.
- No comparable pre-adoption evidence is available. Complete adjacent post-adoption periods may still show recent change, but not change relative to adoption.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Execution activity is diagnostic only. It does not prove repository value.
- Recent change compares the immediately preceding equal-duration period, not lifetime movement. Interval windows must abut without overlap; snapshot values compare cutoff states.
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- Adoption comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

**Goal:** Reduce large Go function bodies without treating suppression as a refactoring.

**Accepted outcome:** Independent Go AST replay counts function declarations and literals exceeding the native frozen 60-body-line boundary. This is the all-platform structural facet, not a full golint-custom result or behavior-preservation proof.

### Overlength Go function bodies

- **What it tells you:** Overlength Go function bodies. This is a `primary` measure.
- **Native measurement formula:** `Count non-generated Go declaration/literal bodies with closing-brace line minus opening-brace line minus one greater than 60, regardless of suppression.`
- **Unit:** `functions`
- **Goal:** Lower values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Unsuppressed overlength bodies

- **What it tells you:** Unsuppressed overlength bodies. This is a `diagnostic` measure.
- **Native measurement formula:** `The same native bodies without a same-line or previous-line largefunc/all suppression.`
- **Unit:** `functions`
- **Goal:** Lower values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Suppressed overlength bodies

- **What it tells you:** Suppressed overlength bodies. This is a `diagnostic` measure.
- **Native measurement formula:** `Raw overlength bodies minus unsuppressed overlength bodies; suppression is not a repair.`
- **Unit:** `functions`
- **Goal:** Lower values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** All tracked non-test Go sources under cmd/ and pkg/ at each endpoint, excluding generated sources and Go-ignored directories.
- **Collection:** Retained immutable source-tree identities, hash-verified Go blobs, pinned AST features and native rule sources.
- **Observation window:** 7 days, sampled every 7 days
- **Maturation delay:** 0 days
- **Filters:** `Use parsed function bodies and the native brace-line difference minus one, not whole-file length or a printed diagnostic count.`; `Keep declarations and nested literals as distinct native analyzer opportunities.`; `Count raw overlength bodies as primary; suppression changes alone cannot improve that primary.`; `Report native same-line/previous-line largefunc/all suppressions separately.`; `Syntax failures and line-directive source remain unknown, not clean. Generated and test sources are excluded.`; `All-platform source replay does not claim historical build-tag selection, typechecking, other lint rules, behavior preservation or workflow causation.`; `Freeze the current native 60-line default for comparison; historical configurable policies may differ.`

The frozen definitions and formulas are applied to every post-adoption observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `lint-monster-timeline.json` artifact.

## Important limitation

This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow.

Value-function SHA-256: `6cd9f9fe67189cbd0d6bcfcc28116e9ba4a0e5ae5ae6e65990d1abaf5573fca7`
