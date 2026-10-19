---
title: "What Schema Consistency Checker measures"
description: "Definitions, evidence rules, and interpretation for the Schema Consistency Checker operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** 0 references; complete

**Measurement:** snapshot; 7-day window, 7-day cadence.

**Recent change:** 0 references

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Unused definitions (definitions) | Unresolved references (references) | Eligible opportunities | Evidence |
|---|---:|---:|---:|---|
| 2026-08-13T02:57:38Z | 2 | 0 | 236 | complete |
| 2026-08-20T02:57:38Z | 2 | 0 | 241 | complete |
| 2026-08-27T02:57:38Z | 0 | 0 | 252 | complete |
| 2026-09-03T02:57:38Z | 0 | 0 | 302 | complete |
| 2026-09-10T02:57:38Z | 0 | 0 | 303 | complete |
| 2026-09-17T02:57:38Z | 0 | 0 | 303 | complete |
| 2026-09-24T02:57:38Z | 0 | 0 | 303 | complete |
| 2026-10-01T02:57:38Z | 0 | 0 | 305 | complete |
| 2026-10-08T02:57:38Z | 0 | 0 | 311 | complete |
| 2026-10-11T15:00:12Z | 0 | 0 | 313 | complete |
| 2026-10-15T02:57:38Z | 0 | 0 | 314 | complete |
| 2026-10-18T15:00:12Z | 0 | 0 | 314 | complete |

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

**Goal:** Keep declared local references in the main workflow schema resolvable to schema values.

**Accepted outcome:** Independent pinned Draft-7/JSON Pointer replay checks immutable main schemas. Definition reachability follows applicable schema children and local references, not literal name occurrence. These are static schema facets, not proof of correctly required fields, implementation/docs agreement or workflow causation.

### Unreachable root schema definitions

- **What it tells you:** Unreachable root schema definitions. This is a `diagnostic` measure.
- **Native measurement formula:** `Count root $defs entries not reachable from the evaluation root through applicable schema children and resolved local references.`
- **Unit:** `definitions`
- **Goal:** Lower values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Unresolved local schema references

- **What it tells you:** Unresolved local schema references. This is a `primary` measure.
- **Native measurement formula:** `Count declared local $ref occurrences whose native JSON Pointer resolution is absent or does not target a valid Draft-7 schema object/boolean.`
- **Unit:** `references`
- **Goal:** Lower values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** Every declared local $ref occurrence at schema locations in the immutable main workflow schema.
- **Collection:** Bounded immutable source archives and native offline schema-reference receipts with pinned dependency closure.
- **Observation window:** 7 days, sampled every 7 days
- **Maturation delay:** 0 days
- **Filters:** `Use the native referencing resolver and Draft-7 metaschema validation; never retrieve remote schemas.`; `Resolve escaped/percent-encoded JSON Pointer tokens through the native resolver.`; `Traverse schema keywords, not annotation examples, defaults or arbitrary JSON strings.`; `A definition cycle without a path from the evaluation root is unused; do not count its internal self-references as usage.`; `Draft-7 $ref siblings do not create evaluation reachability. Definition containers store schemas but do not execute them.`; `External/anchor references and nested resource/dialect changes stay unknown under this closed local-pointer profile.`; `Keep unresolved references separate from unreachable definitions; unresolved links make definition reachability partial.`; `An absent required array is not a proven defect: optional properties can be intentional.`; `Changing definition/reference populations are explicit; snapshots are not new weekly delivery.`

The frozen definitions and formulas are applied to every post-adoption observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `schema-consistency-checker-timeline.json` artifact.

## Important limitation

This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow.

Value-function SHA-256: `2600c83a845328ec196e29ef740e62f2acc4367626f85a10618cb4b2e1d2a4ad`
