---
title: "What Schema Feature Coverage measures"
description: "Definitions, evidence rules, and interpretation for the Schema Feature Coverage operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** 6 properties; complete

**Measurement:** snapshot; 7-day window, 7-day cadence.

**Recent change:** 0 properties

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Uncovered properties (properties) | Covered properties (properties) | Validated coverage (percent) | Eligible opportunities | Evidence |
|---|---:|---:|---:|---:|---|
| 2026-08-13T21:40:26Z | 8 | 56 | 87.5 | 64 | complete |
| 2026-08-20T21:40:26Z | 8 | 57 | 87.6923 | 65 | complete |
| 2026-08-27T21:40:26Z | 9 | 58 | 86.5672 | 67 | complete |
| 2026-09-03T21:40:26Z | 10 | 58 | 85.2941 | 68 | complete |
| 2026-09-10T21:40:26Z | 10 | 58 | 85.2941 | 68 | complete |
| 2026-09-17T21:40:26Z | 10 | 58 | 85.2941 | 68 | complete |
| 2026-09-24T21:40:26Z | 10 | 58 | 85.2941 | 68 | complete |
| 2026-10-01T21:40:26Z | 6 | 63 | 91.3043 | 69 | complete |
| 2026-10-08T21:40:26Z | 6 | 65 | 91.5493 | 71 | complete |
| 2026-10-11T15:00:12Z | 6 | 65 | 91.5493 | 71 | complete |
| 2026-10-15T21:40:26Z | 6 | 65 | 91.5493 | 71 | complete |
| 2026-10-18T15:00:12Z | 6 | 65 | 91.5493 | 71 | complete |

The latest 12 periods are shown; the full native series is in the timeline.
Repository attainment includes other actors. Only a separately declared, independently verified contribution measure supports a workflow keep/change recommendation; it is not causal attribution.
Demonstrated workflow-enabled improvements count as shared contribution even when another agent or person implements them. Report measured progress, full goal completion, safeguards and attribution confidence separately. An unknown quality dimension does not cancel independently verified improvement; a merge alone does not verify that improvement.

## How to read the timeline

- Observations begin at workflow adoption on `2026-03-19`.
- No comparable pre-adoption evidence is available. Complete adjacent post-adoption periods may still show recent change, but not change relative to adoption.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Execution activity is diagnostic only. It does not prove repository value.
- Recent change compares the immediately preceding equal-duration period, not lifetime movement. Interval windows must abut without overlap; snapshot values compare cutoff states.
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- Adoption comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

**Goal:** Provide usage examples for every top-level main workflow schema property.

**Accepted outcome:** Partial facet: a property occurs as a root frontmatter key in at least one structurally Draft-7-valid standalone workflow/demo, using the main schema at the same immutable revision. Format annotations, compiler semantics and imported partial fragments remain separate.

### Uncovered properties

- **What it tells you:** Properties without structurally valid standalone usage. This is a `primary` measure.
- **Native measurement formula:** `current schema properties minus the union of validated root-key usages`
- **Unit:** `properties`
- **Goal:** Lower values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Covered properties

- **What it tells you:** Properties with structurally valid standalone usage. This is a `diagnostic` measure.
- **Native measurement formula:** `distinct schema properties in validated standalone root frontmatter`
- **Unit:** `properties`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Validated coverage

- **What it tells you:** Validated standalone schema coverage. This is a `diagnostic` measure.
- **Native measurement formula:** `covered properties * 100 / current schema property population`
- **Unit:** `percent`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** All top-level schema properties and Markdown files under .github/workflows/ and schema-demos/ at each immutable state.
- **Collection:** Replay digest-checked native validations from immutable Git snapshots; acquisition uses YAML 2.9 and jsonschema 4.23.0.
- **Observation window:** 7 days, sampled every 7 days
- **Maturation delay:** 0 days
- **Filters:** `Parse actual root YAML frontmatter, not prose, nested keys or fenced examples.`; `Only main-schema-valid standalone documents supply coverage. Imported fragments lacking a trigger do not qualify for this partial facet.`; `The pinned independent Draft-7 validator never retrieves remote references or treats format annotations as assertions.`; `Invalid YAML and schema-invalid examples are recorded and cannot supply property credit.`; `Repository coverage is a state, not fresh weekly delivery, compiler acceptance or workflow causation.`

The frozen definitions and formulas are applied to every post-adoption observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `schema-feature-coverage-timeline.json` artifact.

## Important limitation

This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow.

Value-function SHA-256: `997929c82b0d84ce88ad8fc0ba0074b18c5e8f60ca676df389289973694a333c`
