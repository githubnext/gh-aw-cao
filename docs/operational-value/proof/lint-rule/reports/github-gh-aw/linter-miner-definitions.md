---
title: "What linter-miner measures"
description: "Definitions, evidence rules, and interpretation for the linter-miner operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** unknown library process-exit sites relocated to caller control; unavailable

**Measurement:** interval; 7-day window, 7-day cadence.

**Recent change:** unavailable: Fresh complete mature evidence is required for recent movement.

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Native partial (library process-exit sites relocated to caller control) | Eligible opportunities | Evidence |
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

- Observations begin at workflow adoption on `2026-05-15`.
- No comparable pre-adoption evidence is available. Complete adjacent post-adoption periods may still show recent change, but not change relative to adoption.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Execution activity is diagnostic only. It does not prove repository value.
- Recent change compares the immediately preceding equal-duration period, not lifetime movement. Interval windows must abut without overlap; snapshot values compare cutoff states.
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- Adoption comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

**Goal:** Deliver specific, actionable, high-signal new Go analysis linters for recurring error-prone patterns not already covered by the existing linter set.

**Accepted outcome:** Distinct new registered Go analyzers whose diagnostics independently agree with a behavioral defect on a real eligible Go target, reject matched nondefective controls, and identify an actionable repair. Retrospective separately named partial facet: Parse the immutable existing pkg/cli/upgrade_command.go before/after afbc96f5a367761183eb0bfd7eaa4e29fcfbef8f with the native Go parser. Match removal of os-package Exit calls to added returns of ExitCodeError. Independently retain the error type and cmd entry-point propagation source. Raw exits are counted separately from suppression; context.Background replaced by context.TODO is not improvement.

### Library process exits replaced by propagated exit-code returns

- **What it tells you:** Library process exits replaced by propagated exit-code returns. This is a `primary` measure.
- **Native measurement formula:** `Sum independently established selected native before/after transitions in this disjoint interval; null without an assessed eligible cohort.`
- **Unit:** `library process-exit sites relocated to caller control`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** One explicitly selected immutable library file; no full Go-codebase, analyzer-correctness or behavioral-preservation claim.
- **Collection:** Offline raw Git originals with commit-parent-tree-blob proofs; full production issue/PR inventory; independent own-code native oracle. No target code executes.
- **Observation window:** 7 days, sampled every 7 days
- **Maturation delay:** 0 days
- **Filters:** `Non-test Go source beneath pkg and cmd; analyzer implementations beneath pkg/linters and registration in cmd/linters/main.go.`; `Retrospective source- and outcome-informed partial instruments. These do not replace or backdate the frozen source-first full acceptance predicates.`; `Full source-first acceptance remains null; no zero is inferred from an empty selected interval.`

The frozen definitions and formulas are applied to every post-adoption observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `linter-miner-timeline.json` artifact.

## Important limitation

This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow.

Value-function SHA-256: `3e503465e09a323d815bfcd277a7655dadfba36fe02fad3160c29227309ac8ff`
