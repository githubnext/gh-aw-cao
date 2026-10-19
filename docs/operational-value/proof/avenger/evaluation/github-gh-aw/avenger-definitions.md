---
title: "What Avenger measures"
description: "Definitions, evidence rules, and interpretation for the Avenger operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** unknown defects; unavailable

**Measurement:** interval; 7-day window, 7-day cadence.

**Recent change:** unavailable: Fresh complete mature evidence is required for recent movement.

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | repairs (defects) | complete (defects) | linked (defects) | introduced (defects) | incomplete (defects) | Eligible opportunities | Evidence |
|---|---:|---:|---:|---:|---:|---:|---|
| 2026-10-18T15:00:12Z | unknown | unknown | unknown | unknown | unknown | unknown | partial-window: Offline discovery history supplies issue/PR identities and editable run references, not original native failure, required-check policy, immutable landing, unchanged exercised pass, introduced-defect assessment or independent contribution receipts. No native observation is accepted, no zero is inferred, and acquisition is not exhausted. |

The latest 1 periods are shown; the full native series is in the timeline.
Repository attainment includes other actors. Only a separately declared, independently verified contribution measure supports a workflow keep/change recommendation; it is not causal attribution.
Demonstrated workflow-enabled improvements count as shared contribution even when another agent or person implements them. Report measured progress, full goal completion, safeguards and attribution confidence separately. An unknown quality dimension does not cancel independently verified improvement; a merge alone does not verify that improvement.

## How to read the timeline

- The measurement contract was activated on `2026-10-18`; this is not a workflow adoption date.
- No historical reference has been established.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Execution activity is diagnostic only. It does not prove repository value.
- Recent change compares the immediately preceding equal-duration period, not lifetime movement. Interval windows must abut without overlap; snapshot values compare cutoff states.
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- Historical reference comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

**Goal:** For original mechanical CI defects on main, restore the same required failing condition by a landed minimal fix, independently verified without bypass, measured as distinct defects repaired per non-overlapping period.

**Accepted outcome:** An original protected native failure and an exercised pass under the same predicate, required check, toolchain, scope and suppression policy; immutable main landing and ordered receipts. A PR, merge, green job, self-healing run or agent evaluation alone is insufficient.

### Independently demonstrated original repairs

- **What it tells you:** Independently demonstrated original repairs. This is a `primary` measure.
- **Native measurement formula:** `Distinct original-condition identities in repairs; delivered at max(landing time, first matching protected native pass completion, evidence availability). Null without corresponding coverage, with accepted partial subtotals retained.`
- **Unit:** `defects`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Repairs with full buildability acceptance

- **What it tells you:** Repairs with full buildability acceptance. This is a `diagnostic` measure.
- **Native measurement formula:** `Distinct original-condition identities in complete; delivered at max(landing time, first matching protected native pass completion, evidence availability). Null without corresponding coverage, with accepted partial subtotals retained.`
- **Unit:** `defects`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Demonstrated Avenger contributions

- **What it tells you:** Demonstrated Avenger contributions. This is a `diagnostic` measure.
- **Native measurement formula:** `Distinct original-condition identities in linked; delivered at max(landing time, first matching protected native pass completion, evidence availability). Null without corresponding coverage, with accepted partial subtotals retained.`
- **Unit:** `defects`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Independently demonstrated introduced defects

- **What it tells you:** Independently demonstrated introduced defects. This is a `diagnostic` measure.
- **Native measurement formula:** `Distinct newly introduced conditions with an independently passing predecessor and failing landed successor, delivered once at max(failure completion, evidence availability); null without exhaustive coverage.`
- **Unit:** `defects`
- **Goal:** Lower values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Conditions with incomplete check evidence

- **What it tells you:** Conditions with incomplete check evidence. This is a `diagnostic` measure.
- **Native measurement formula:** `Original conditions established in this interval whose native check/landing proof remains incomplete at observedAt; null without catalogue coverage. Not a count of failed runs.`
- **Unit:** `defects`
- **Goal:** Lower values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** Distinct original mechanical failing conditions on main, independently established by a required ci.yml check; infrastructure/transient failures and later introduced defects are separate.
- **Collection:** Offline digest-checked retained source, condition catalogue, Git ancestry/landing and protected native check receipts. No commands from the target repository, remote APIs, lazy fetch or workflow execution.
- **Observation window:** 7 days, sampled every 7 days
- **Maturation delay:** 0 days
- **Filters:** `Frozen current-source profile only; never reinterpret an unknown historical intent era.`; `Original condition identity is frozen before repair: rule, logical locus, predicate and failing input class; never PR, run, test count or an editable tracking marker.`; `The first landed and independently verified repair of a condition is delivered once. Repeats, reruns, later receipts and duplicate PRs do not redeliver it.`; `Count all actors. Avenger contribution additionally needs an independent producer/implementation linkage; body markers alone remain discovery.`; `Skipped, masked, waived, deleted, weakened, setup-failed or differently configured checks do not establish a repair.`

The frozen goal, acceptance rule and formulas are applied to every observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `avenger-timeline.json` artifact.

## Important limitation

This report measures accepted repository outcomes against the stated goal. Contract activation is not an intervention or proof that an agent caused the outcomes; unavailable historical evidence supports no historical improvement claim.

Value-function SHA-256: `eb7cf00726a29cf1109990683241e70c2a5450eef566649929c5ca77371b389d`
