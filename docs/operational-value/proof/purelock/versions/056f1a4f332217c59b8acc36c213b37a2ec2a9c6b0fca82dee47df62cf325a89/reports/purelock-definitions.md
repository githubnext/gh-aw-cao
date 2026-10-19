---
title: "What PureLock measures"
description: "Definitions, evidence rules, and interpretation for the PureLock operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** 1696 functions; incomplete-evidence

**Measurement:** snapshot; 1-day window, 1-day cadence.

**Recent change:** unavailable: Fresh complete mature evidence is required for recent movement.

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Observed fully covered (functions) | Complete fully covered (functions) | Observed executed (functions) | Eligible opportunities | Evidence |
|---|---:|---:|---:|---:|---|
| 2026-10-08T15:01:29Z | unknown | unknown | unknown | unknown | incomplete-evidence: No independently source-bound retained executed-coverage observation within one day of this endpoint. |
| 2026-10-09T15:01:29Z | unknown | unknown | unknown | unknown | incomplete-evidence: No independently source-bound retained executed-coverage observation within one day of this endpoint. |
| 2026-10-10T15:01:29Z | unknown | unknown | unknown | unknown | incomplete-evidence: No independently source-bound retained executed-coverage observation within one day of this endpoint. |
| 2026-10-11T15:01:29Z | unknown | unknown | unknown | unknown | incomplete-evidence: No independently source-bound retained executed-coverage observation within one day of this endpoint. |
| 2026-10-12T15:01:29Z | unknown | unknown | unknown | unknown | incomplete-evidence: No independently source-bound retained executed-coverage observation within one day of this endpoint. |
| 2026-10-13T15:01:29Z | unknown | unknown | unknown | unknown | incomplete-evidence: No independently source-bound retained executed-coverage observation within one day of this endpoint. |
| 2026-10-14T15:01:29Z | unknown | unknown | unknown | unknown | incomplete-evidence: No independently source-bound retained executed-coverage observation within one day of this endpoint. |
| 2026-10-15T15:01:29Z | unknown | unknown | unknown | unknown | incomplete-evidence: No independently source-bound retained executed-coverage observation within one day of this endpoint. |
| 2026-10-16T15:01:29Z | unknown | unknown | unknown | unknown | incomplete-evidence: No independently source-bound retained executed-coverage observation within one day of this endpoint. |
| 2026-10-17T15:00:12Z | 1679 | 1679 | 2378 | 2441 | incomplete-evidence: Observed native coverage is retained; incomplete coverage or changing pure-function population prevents comparable progress. |
| 2026-10-17T15:01:29Z | 1679 | 1679 | 2378 | 2441 | incomplete-evidence: Observed native coverage is retained; incomplete coverage or changing pure-function population prevents comparable progress. |
| 2026-10-18T15:00:12Z | 1696 | 1696 | 2397 | 2461 | incomplete-evidence: Observed native coverage is retained; incomplete coverage or changing pure-function population prevents comparable progress. |

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

**Goal:** Increase executed test coverage of pure Go functions, with independently verified native coverage rather than source enumeration.

**Accepted outcome:** Replay the reviewed fixed-point native analyzer over all ./pkg/... packages at the protected precompute checkout, join every classified-pure function to actual go tool cover -func output, and count observed 100% statement-covered functions. This is the executed-coverage facet, not proof of semantic purity, assertion quality, race safety or attributed test delivery.

### Executed pure-function coverage

- **What it tells you:** Observed fully-covered pure functions. This is a `primary` measure.
- **Native measurement formula:** `Observed lower-bound count of classified-pure functions with explicit native 100.0% statement coverage.`
- **Unit:** `functions`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Executed pure-function coverage

- **What it tells you:** Complete fully-covered pure functions. This is a `diagnostic` measure.
- **Native measurement formula:** `Complete count of classified-pure functions with explicit native 100.0% statement coverage.`
- **Unit:** `functions`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Executed pure-function coverage

- **What it tells you:** Observed executed pure functions. This is a `diagnostic` measure.
- **Native measurement formula:** `Count classified-pure functions with an explicit executed native coverage record above 0%.`
- **Unit:** `functions`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** Every function classified pure by the frozen native analyzer in the complete Linux/amd64, non-CGO ./pkg/... production build population at an independently bound retained precompute checkout.
- **Collection:** Exhaustive bounded pre-cutoff Actions run inventory; preserved protected job projections and artifact hashes; native static replay only, never fetched repository test execution.
- **Observation window:** 1 days, sampled every 1 days
- **Maturation delay:** 0 days
- **Filters:** `Require the exact protected checkout, successful native precompute steps and provider-digest-verified artifacts. Accept actual local coverage fallback or a complete same-checkout protected CI integration profile set reproducing every native function coverage record.`; `Replay the reviewed analyzer with -limit 0 and -max-coverage 101 so neither ranking nor the 40-candidate worklist truncates the population.`; `Join file, line and function name to executed native coverage; upstream assumed-zero values without coverage records are null, never zero.`; `Reject package/type-loading errors and replay populations that differ from protected precompute function and pure-function counts.`; `Retain observed fully-covered lower bounds through unknown functions; a complete total requires every pure function's coverage.`; `Take the latest eligible protected observation no more than one day before each daily endpoint; do not backdate newer evidence.`; `Require unchanged complete pure-function identity population, no missing function coverage and unchanged tool/source/test-suite profile for comparison. Local-unit and CI-integration coverage are different profiles.`; `100.0% is the native tool's rounded statement coverage, not proof of branch coverage or behavioral correctness.`; `Snapshots are repository conditions, not fresh deliveries. Workflow contribution, test correctness, race/vet safeguards and costs are not measured.`

The frozen definitions and formulas are applied to every post-adoption observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `purelock-timeline.json` artifact.

## Important limitation

This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow.

Value-function SHA-256: `056f1a4f332217c59b8acc36c213b37a2ec2a9c6b0fca82dee47df62cf325a89`
