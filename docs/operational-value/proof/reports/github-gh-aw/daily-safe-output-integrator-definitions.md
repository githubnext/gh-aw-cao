---
title: "What Daily Safe Output Integrator measures"
description: "Definitions, evidence rules, and interpretation for the Daily Safe Output Integrator operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** 1 types; complete

**Measurement:** snapshot; 7-day window, 7-day cadence.

**Recent change:** 0 types

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Types without fixtures (types) | Types with fixtures (types) | Validated coverage (percent) | Eligible opportunities | Evidence |
|---|---:|---:|---:|---:|---|
| 2026-08-11T16:43:26Z | 0 | 43 | 100 | 43 | complete |
| 2026-08-18T16:43:26Z | 1 | 43 | 97.7273 | 44 | complete |
| 2026-08-25T16:43:26Z | 1 | 45 | 97.8261 | 46 | complete |
| 2026-09-01T16:43:26Z | 1 | 45 | 97.8261 | 46 | complete |
| 2026-09-08T16:43:26Z | 1 | 58 | 98.3051 | 59 | complete |
| 2026-09-15T16:43:26Z | 1 | 58 | 98.3051 | 59 | complete |
| 2026-09-22T16:43:26Z | 1 | 58 | 98.3051 | 59 | complete |
| 2026-09-29T16:43:26Z | 1 | 58 | 98.3051 | 59 | complete |
| 2026-10-06T16:43:26Z | 1 | 58 | 98.3051 | 59 | complete |
| 2026-10-11T15:00:12Z | 1 | 58 | 98.3051 | 59 | complete |
| 2026-10-13T16:43:26Z | 1 | 58 | 98.3051 | 59 | complete |
| 2026-10-18T15:00:12Z | 1 | 58 | 98.3051 | 59 | complete |

The latest 12 periods are shown; the full native series is in the timeline.
Repository attainment includes other actors. Only a separately declared, independently verified contribution measure supports a workflow keep/change recommendation; it is not causal attribution.
Demonstrated workflow-enabled improvements count as shared contribution even when another agent or person implements them. Report measured progress, full goal completion, safeguards and attribution confidence separately. An unknown quality dimension does not cancel independently verified improvement; a merge alone does not verify that improvement.

## How to read the timeline

- Observations begin at workflow adoption on `2026-03-17`.
- No comparable pre-adoption evidence is available. Complete adjacent post-adoption periods may still show recent change, but not change relative to adoption.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Execution activity is diagnostic only. It does not prove repository value.
- Recent change compares the immediately preceding equal-duration period, not lifetime movement. Interval windows must abut without overlap; snapshot values compare cutoff states.
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- Adoption comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

**Goal:** Provide meaningful fixture and compiler assertion coverage for every supported safe-output type.

**Accepted outcome:** Partial facet: statically registered safe-output tools with a canonical safe-outputs schema key have a structurally valid standalone pkg/cli/workflows/test-*.md declaration at the same immutable revision. Runtime exercise, imported-only fixtures, dynamic tools and Go compiler assertions remain separate.

### Types without fixtures

- **What it tells you:** Registered safe-output types without valid fixtures. This is a `primary` measure.
- **Native measurement formula:** `eligible registered types minus distinct validated fixture declarations`
- **Unit:** `types`
- **Goal:** Lower values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Types with fixtures

- **What it tells you:** Registered safe-output types with valid fixtures. This is a `diagnostic` measure.
- **Native measurement formula:** `eligible registered types declared in at least one validated standalone fixture`
- **Unit:** `types`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Validated coverage

- **What it tells you:** Validated static safe-output fixture coverage. This is a `diagnostic` measure.
- **Native measurement formula:** `covered registered types * 100 / eligible registered types`
- **Unit:** `percent`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** Static safe_outputs_tools.json tool names mapped from underscores to schema hyphens and intersected with canonical safe-outputs properties.
- **Collection:** Replay digest-checked immutable fixture/schema/registry facts; independent validation denies remote schema retrieval.
- **Observation window:** 7 days, sampled every 7 days
- **Maturation delay:** 0 days
- **Filters:** `Validate actual standalone fixture frontmatter against the same-revision Draft-7 main schema.`; `Only direct safe-outputs keys in valid test-*.md fixtures supply declaration coverage.`; `Configuration-only keys and tools outside the canonical schema intersection do not create false fixture gaps.`; `Fixture availability is repository state, not fresh delivery, compiler acceptance or workflow causation.`

The frozen definitions and formulas are applied to every post-adoption observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `daily-safe-output-integrator-timeline.json` artifact.

## Important limitation

This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow.

Value-function SHA-256: `2ed4f4c97d602a684145b85d1eadfbafe7c2ec928d2dbec743bd4359090e93d9`
