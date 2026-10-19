---
title: "What eslint-miner measures"
description: "Definitions, evidence rules, and interpretation for the eslint-miner operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** unknown newly guarded retained mkdirSync calls; unavailable

**Measurement:** interval; 7-day window, 7-day cadence.

**Recent change:** unavailable: Fresh complete mature evidence is required for recent movement.

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Native partial (newly guarded retained mkdirSync calls) | Eligible opportunities | Evidence |
|---|---:|---:|---|
| 2026-08-02T15:00:12Z | unknown | unknown | incomplete-evidence: No selected independently assessed native transition in this period; not a zero or exhausted workflow-output cohort |
| 2026-08-09T15:00:12Z | unknown | unknown | incomplete-evidence: No selected independently assessed native transition in this period; not a zero or exhausted workflow-output cohort |
| 2026-08-16T15:00:12Z | unknown | unknown | incomplete-evidence: No selected independently assessed native transition in this period; not a zero or exhausted workflow-output cohort |
| 2026-08-23T15:00:12Z | unknown | unknown | incomplete-evidence: No selected independently assessed native transition in this period; not a zero or exhausted workflow-output cohort |
| 2026-08-30T15:00:12Z | unknown | unknown | incomplete-evidence: No selected independently assessed native transition in this period; not a zero or exhausted workflow-output cohort |
| 2026-09-06T15:00:12Z | unknown | unknown | incomplete-evidence: No selected independently assessed native transition in this period; not a zero or exhausted workflow-output cohort |
| 2026-09-13T15:00:12Z | unknown | unknown | incomplete-evidence: No selected independently assessed native transition in this period; not a zero or exhausted workflow-output cohort |
| 2026-09-20T15:00:12Z | unknown | unknown | incomplete-evidence: No selected independently assessed native transition in this period; not a zero or exhausted workflow-output cohort |
| 2026-09-27T15:00:12Z | unknown | unknown | incomplete-evidence: No selected independently assessed native transition in this period; not a zero or exhausted workflow-output cohort |
| 2026-10-04T15:00:12Z | unknown | unknown | incomplete-evidence: No selected independently assessed native transition in this period; not a zero or exhausted workflow-output cohort |
| 2026-10-11T15:00:12Z | unknown | unknown | incomplete-evidence: No selected independently assessed native transition in this period; not a zero or exhausted workflow-output cohort |
| 2026-10-18T15:00:12Z | unknown | unknown | incomplete-evidence: No selected independently assessed native transition in this period; not a zero or exhausted workflow-output cohort |

The latest 12 periods are shown; the full native series is in the timeline.
Repository attainment includes other actors. Only a separately declared, independently verified contribution measure supports a workflow keep/change recommendation; it is not causal attribution.
Demonstrated workflow-enabled improvements count as shared contribution even when another agent or person implements them. Report measured progress, full goal completion, safeguards and attribution confidence separately. An unknown quality dimension does not cancel independently verified improvement; a merge alone does not verify that improvement.

## How to read the timeline

- Observations begin at workflow adoption on `2026-06-27`.
- No comparable pre-adoption evidence is available. Complete adjacent post-adoption periods may still show recent change, but not change relative to adoption.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Execution activity is diagnostic only. It does not prove repository value.
- Recent change compares the immediately preceding equal-duration period, not lifetime movement. Interval windows must abut without overlap; snapshot values compare cutoff states.
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- Adoption comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

**Goal:** Deliver new high-signal, actionable behavioral ESLint rules addressing observed JavaScript/TypeScript failure patterns in actions/setup/js.

**Accepted outcome:** Distinct new enabled rules whose diagnostics independently agree with a source-defined behavioral defect on at least one real eligible target, reject matched nondefective controls, and supply an actionable repair; false-positive and false-negative acceptance beyond observed controls remains separate. Retrospective separately named partial facet: On two explicitly selected existing non-test CommonJS files in repair 246fccc2e62edb9b0cef682f03be55234217ee99, match exact direct fs.mkdirSync expressions and opportunity counts before/after. Count before-minus-after raw unguarded calls only when these populations agree. Ignore waiver changes. This proves local structural exception containment, not correct error handling or factory execution.

### Retained mkdirSync calls newly enclosed in local try/catch

- **What it tells you:** Retained mkdirSync calls newly enclosed in local try/catch. This is a `primary` measure.
- **Native measurement formula:** `Sum independently established selected native before/after transitions in this disjoint interval; null without an assessed eligible cohort.`
- **Unit:** `newly guarded retained mkdirSync calls`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** Selected two-file native cohort, not all actions/setup/js or all miner outputs. Intervals without a selected known assessment are null.
- **Collection:** Offline raw Git originals with commit-parent-tree-blob proofs; full production issue/PR inventory; independent own-code native oracle. No target code executes.
- **Observation window:** 7 days, sampled every 7 days
- **Maturation delay:** 0 days
- **Filters:** `Existing JavaScript/TypeScript source files beneath actions/setup/js; implementations beneath eslint-factory.`; `Retrospective source- and outcome-informed partial instruments. These do not replace or backdate the frozen source-first full acceptance predicates.`; `Full source-first acceptance remains null; no zero is inferred from an empty selected interval.`

The frozen definitions and formulas are applied to every post-adoption observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `eslint-miner-timeline.json` artifact.

## Important limitation

This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow.

Value-function SHA-256: `7eb49b35a2f448d9c36fa051dc78c01f51baeeba9bd85717435e5395169ff762`
