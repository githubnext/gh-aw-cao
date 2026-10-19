---
title: "What CI Cleaner measures"
description: "Definitions, evidence rules, and interpretation for the CI Cleaner operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** 0 catalogs; complete

**Measurement:** snapshot; 7-day window, 7-day cadence.

**Recent change:** unavailable: Fresh complete mature evidence is required for recent movement.

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Unformatted catalogs (catalogs) | Eligible opportunities | Evidence |
|---|---:|---:|---|
| 2026-08-13T05:32:58Z | 0 | 2 | incomplete-evidence: Source recipe/configuration continuity is not established. |
| 2026-08-20T05:32:58Z | 0 | 2 | incomplete-evidence: Source recipe/configuration continuity is not established. |
| 2026-08-27T05:32:58Z | 0 | 2 | incomplete-evidence: Source recipe/configuration continuity is not established. |
| 2026-09-03T05:32:58Z | 0 | 2 | incomplete-evidence: Source recipe/configuration continuity is not established. |
| 2026-09-10T05:32:58Z | 0 | 2 | incomplete-evidence: Source recipe/configuration continuity is not established. |
| 2026-09-17T05:32:58Z | 0 | 2 | incomplete-evidence: Source recipe/configuration continuity is not established. |
| 2026-09-24T05:32:58Z | 0 | 2 | incomplete-evidence: Source recipe/configuration continuity is not established. |
| 2026-10-01T05:32:58Z | 0 | 2 | incomplete-evidence: Source recipe/configuration continuity is not established. |
| 2026-10-08T05:32:58Z | 0 | 2 | incomplete-evidence: Source recipe/configuration continuity is not established. |
| 2026-10-11T15:00:12Z | 0 | 2 | incomplete-evidence: Source recipe/configuration continuity is not established. |
| 2026-10-15T05:32:58Z | 0 | 2 | incomplete-evidence: Source recipe/configuration continuity is not established. |
| 2026-10-18T15:00:12Z | 0 | 2 | complete |

The latest 12 periods are shown; the full native series is in the timeline.
Repository attainment includes other actors. Only a separately declared, independently verified contribution measure supports a workflow keep/change recommendation; it is not causal attribution.
Demonstrated workflow-enabled improvements count as shared contribution even when another agent or person implements them. Report measured progress, full goal completion, safeguards and attribution confidence separately. An unknown quality dimension does not cancel independently verified improvement; a merge alone does not verify that improvement.

## How to read the timeline

- Observations begin at workflow adoption on `2025-12-11`.
- No comparable pre-adoption evidence is available. Complete adjacent post-adoption periods may still show recent change, but not change relative to adoption.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Execution activity is diagnostic only. It does not prove repository value.
- Recent change compares the immediately preceding equal-duration period, not lifetime movement. Interval windows must abut without overlap; snapshot values compare cutoff states.
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- Adoption comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

**Goal:** Keep the two model catalogs targeted by the source's fmt-json recipe natively formatted.

**Accepted outcome:** Both source-declared model catalog files are unignored, parseable JSON and byte-identical to pinned native Prettier output under the frozen JSON configuration. This is the model-formatting facet, not full CI recovery.

### Model catalogs needing formatting

- **What it tells you:** Model catalogs needing formatting. This is a `primary` measure.
- **Native measurement formula:** `Count the two source-declared catalogs whose original bytes differ from pinned native Prettier output.`
- **Unit:** `catalogs`
- **Goal:** Lower values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** The two explicit model-catalog paths in the frozen fmt-json recipe.
- **Collection:** Immutable adoption/weekly/cutoff input blobs and source policies, native formatter identity and positive/negative probes.
- **Observation window:** 7 days, sampled every 7 days
- **Maturation delay:** 0 days
- **Filters:** `Use pinned native Prettier, not JSON.stringify or a successful formatting job as a substitute.`; `Never execute repository configuration code, scripts, plugins or Makefile recipes.`; `Retain native output hashes, original immutable inputs, effective ignore results and configuration/recipe identities.`; `Missing catalogs, invalid JSON, ignored targets or unsupported configuration profiles remain unknown.`; `Historic reference-tool quantities are not proof that older formatting policies failed.`; `Only stable source-declared recipe and JSON configuration intervals are comparable; keep other intent eras visible.`; `Formatting conformance is a repository snapshot, not fresh workflow delivery or proof of CI repair.`; `Go/JavaScript formatting, lint, tests, model correctness, attribution, regressions and costs remain unmeasured.`

The frozen definitions and formulas are applied to every post-adoption observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `hourly-ci-cleaner-timeline.json` artifact.

## Important limitation

This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow.

Value-function SHA-256: `ed213c2644f0920bf66e69be936695f11415a67d6a0b4037922b6ab31e537d94`
