---
title: "What Smoke Built-in Ledgers measures"
description: "Definitions, evidence rules, and interpretation for the Smoke Built-in Ledgers operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** 4 rows; incomplete-evidence

**Measurement:** snapshot; 7-day window, 7-day cadence.

**Recent change:** unavailable: Fresh complete mature evidence is required for recent movement.

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Verified durable rows (rows) | Unmatched rows (rows) | Eligible opportunities | Evidence |
|---|---:|---:|---:|---|
| 2026-10-08T13:53:25Z | unknown | unknown | unknown | incomplete-evidence: No retained immutable ledger state exists at this endpoint. |
| 2026-10-11T15:00:12Z | 2 | 0 | unknown | incomplete-evidence |
| 2026-10-15T13:53:25Z | 3 | 0 | unknown | incomplete-evidence |
| 2026-10-18T15:00:12Z | 4 | 0 | unknown | incomplete-evidence |

The latest 4 periods are shown; the full native series is in the timeline.
Repository attainment includes other actors. Only a separately declared, independently verified contribution measure supports a workflow keep/change recommendation; it is not causal attribution.
Demonstrated workflow-enabled improvements count as shared contribution even when another agent or person implements them. Report measured progress, full goal completion, safeguards and attribution confidence separately. An unknown quality dimension does not cancel independently verified improvement; a merge alone does not verify that improvement.

## How to read the timeline

- Observations begin at workflow adoption on `2026-10-01`.
- No comparable pre-adoption evidence is available. Complete adjacent post-adoption periods may still show recent change, but not change relative to adoption.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Execution activity is diagnostic only. It does not prove repository value.
- Recent change compares the immediately preceding equal-duration period, not lifetime movement. Interval windows must abut without overlap; snapshot values compare cutoff states.
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- Adoption comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

**Goal:** Preserve source-defined run fixtures as correctly replayable durable ledger state.

**Accepted outcome:** The pinned production canonical reconstruction, built-in reducer and SQLite materializer restore the independent expected fixture rows exactly in a read-only database.

### Replay-verified durable rows

- **What it tells you:** Replay-verified durable rows. This is a `primary` measure.
- **Native measurement formula:** `Count distinct eligible persisted fixtures restored exactly by production replay into read-only SQLite.`
- **Unit:** `rows`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Unmatched durable fixture rows

- **What it tells you:** Unmatched durable fixture rows. This is a `diagnostic` measure.
- **Native measurement formula:** `Eligible persisted fixtures minus exactly restored native rows.`
- **Unit:** `rows`
- **Goal:** Lower values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** Persisted source-defined run fixtures in the retained canonical ledger branch lineage.
- **Collection:** Bounded immutable ledger commits and safe fixture blobs, reconstructed once outside offline scoring.
- **Observation window:** 7 days, sampled every 7 days
- **Maturation delay:** 0 days
- **Filters:** `The pinned production ledger reconstruction, reducer and SQLite materializer must restore the actual immutable records.`; `An independent expected-fixture oracle compares actual read-only SQLite rows, not an agent's passed flag.`; `Snapshots are maintained repository condition, not fresh delivery each week or proof an agent inspected its projection.`; `Branch recreation, unsupported historical formats, other ledger types, note truth, workflow causation and costs remain separate.`; `Partial append-only log facet; set/map/table/counter/notes operations and actual historical agent inspection are not established.`

The frozen definitions and formulas are applied to every post-adoption observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `smoke-builtin-ledgers-timeline.json` artifact.

## Important limitation

This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow.

Value-function SHA-256: `5309e8bf42729cdc5bad1d4a899197559829782dd60a587fdae49defdfefd3a5`
