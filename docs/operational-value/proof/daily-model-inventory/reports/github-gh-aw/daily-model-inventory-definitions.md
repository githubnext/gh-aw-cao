---
title: "What Daily Model Inventory Checker measures"
description: "Definitions, evidence rules, and interpretation for the Daily Model Inventory Checker operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** unknown aliases; unavailable

**Measurement:** snapshot; 1-day window, 1-day cadence.

**Recent change:** unavailable: Fresh complete mature evidence is required for recent movement.

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Stale aliases (aliases) | Known stale subtotal (aliases) | Supported aliases (aliases) | Eligible opportunities | Evidence |
|---|---:|---:|---:|---:|---|
| 2026-10-18T15:00:12Z | unknown | unknown | unknown | 62 | partial-window: Complete applicable independent provider inventories were not retained. |

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

**Goal:** Keep the built-in model alias mapping usable against live applicable provider inventories.

**Accepted outcome:** An alias has at least one source-defined recursive pattern or exact fallback matching an independently complete applicable live provider inventory.

### Stale alias definitions

- **What it tells you:** Stale alias definitions. This is a `primary` measure.
- **Native measurement formula:** `Count aliases with no live resolution; null unless the entire alias population is independently assessed.`
- **Unit:** `aliases`
- **Goal:** Lower values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Established stale subtotal

- **What it tells you:** Established stale subtotal. This is a `diagnostic` measure.
- **Native measurement formula:** `Count positively established stale aliases among assessed opportunities; a lower bound during partial coverage, not an all-clear.`
- **Unit:** `aliases`
- **Goal:** Lower values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Independently supported aliases

- **What it tells you:** Independently supported aliases. This is a `diagnostic` measure.
- **Native measurement formula:** `Count alias keys with a live matching candidate from at least one complete applicable inventory; preserve partial support independently of full acceptance.`
- **Unit:** `aliases`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** Each built-in alias key at the pinned current-source cutoff, including meta-aliases and per-engine aliases; each key counted once.
- **Collection:** Batch offline replay of retained whole immutable sources and protected provider capture pages. Canonical activity discovery lacks live provider facts. No network or fetched-code execution.
- **Observation window:** 1 days, sampled every 1 days
- **Maturation delay:** 0 days
- **Filters:** `Built-in alias map only; no workflow overrides or task-family usefulness inference.`; `Case-insensitive literal provider matching; star cannot cross slash; strip parameters before presence checks.`; `Use complete independent account-scoped inventory; errors, skipped/empty/paginated-incomplete providers are unknown.`; `Current source predicates never applied to an unknown historical source era.`; `models.json pricing/history is not live inventory; retain historical entries without automatic removal.`

The frozen goal, acceptance rule and formulas are applied to every observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `daily-model-inventory-timeline.json` artifact.

## Important limitation

This report measures accepted repository outcomes against the stated goal. Contract activation is not an intervention or proof that an agent caused the outcomes; unavailable historical evidence supports no historical improvement claim.

Value-function SHA-256: `14eff5cf9c9793610fc6e3e87fb658e86522603fda07a3fe2dd9d32e6fb2e230`
