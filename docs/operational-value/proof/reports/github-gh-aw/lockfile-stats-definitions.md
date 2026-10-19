---
title: "What Lockfile Statistics Analysis Agent measures"
description: "Definitions, evidence rules, and interpretation for the Lockfile Statistics Analysis Agent operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** 726 statistical facts; incomplete-evidence

**Measurement:** interval; 7-day window, 7-day cadence.

**Recent change:** unavailable: Fresh complete mature evidence is required for recent movement.

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Reconciled census facts (statistical facts) | Incorrect census facts (statistical facts) | Eligible opportunities | Evidence |
|---|---:|---:|---:|---|
| 2026-08-02T15:00:12Z | unknown | unknown | 7 | incomplete-evidence: No original, source-compatible, protected-upload census with exact checkout binding establishes statistics in this interval. |
| 2026-08-09T15:00:12Z | unknown | unknown | 7 | incomplete-evidence: No original, source-compatible, protected-upload census with exact checkout binding establishes statistics in this interval. |
| 2026-08-16T15:00:12Z | unknown | unknown | 7 | incomplete-evidence: No original, source-compatible, protected-upload census with exact checkout binding establishes statistics in this interval. |
| 2026-08-23T15:00:12Z | unknown | unknown | 7 | incomplete-evidence: No original, source-compatible, protected-upload census with exact checkout binding establishes statistics in this interval. |
| 2026-08-30T15:00:12Z | 1543 | 0 | 7 | incomplete-evidence |
| 2026-09-06T15:00:12Z | 1841 | 0 | 7 | complete |
| 2026-09-13T15:00:12Z | 2108 | 0 | 7 | complete |
| 2026-09-20T15:00:12Z | 604 | 0 | 7 | incomplete-evidence |
| 2026-09-27T15:00:12Z | 1517 | 0 | 7 | incomplete-evidence |
| 2026-10-04T15:00:12Z | 1466 | 1 | 7 | incomplete-evidence |
| 2026-10-11T15:00:12Z | 857 | 129 | 7 | incomplete-evidence |
| 2026-10-18T15:00:12Z | 726 | 156 | 7 | incomplete-evidence |

The latest 12 periods are shown; the full native series is in the timeline.
Repository attainment includes other actors. Only a separately declared, independently verified contribution measure supports a workflow keep/change recommendation; it is not causal attribution.
Demonstrated workflow-enabled improvements count as shared contribution even when another agent or person implements them. Report measured progress, full goal completion, safeguards and attribution confidence separately. An unknown quality dimension does not cancel independently verified improvement; a merge alone does not verify that improvement.

## How to read the timeline

- Observations begin at workflow adoption on `2025-10-11`.
- No comparable pre-adoption evidence is available. Complete adjacent post-adoption periods may still show recent change, but not change relative to adoption.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Execution activity is diagnostic only. It does not prove repository value.
- Recent change compares the immediately preceding equal-duration period, not lifetime movement. Interval windows must abut without overlap; snapshot values compare cutoff states.
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- Adoption comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

**Goal:** For each repository-wide lockfile census, deliver statistically accurate facts about all .github/workflows/*.lock.yml files, independently reconciled to the immutable input population.

**Accepted outcome:** A retained numeric statistical assertion matches an independent native YAML/JSON census of the full, source-bound checkout. The entire report, recommendations, resource limits and publication require separate evidence.

### Reconciled census facts

- **What it tells you:** Reconciled census facts. This is a `primary` measure.
- **Native measurement formula:** `Count distinct numeric report assertions independently reconciled to native facts over the complete eligible lockfile population; deduplicate by original run, assertion meaning and input population.`
- **Unit:** `statistical facts`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Incorrect census facts

- **What it tells you:** Incorrect census facts. This is a `diagnostic` measure.
- **Native measurement formula:** `Count distinct mapped numeric assertions whose value disagrees with the independent full-population native census; unbound reports stay unknown.`
- **Unit:** `statistical facts`
- **Goal:** Lower values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** Initial scheduled or manually dispatched lockfile-stats executions and independently source-bound equivalent censuses; reruns do not create new deliveries.
- **Collection:** Replay original protected-upload cache summaries against the complete immutable checkout using the pinned native YAML/JSON census; retain all assertions and mismatches.
- **Observation window:** 7 days, sampled every 7 days
- **Maturation delay:** 0 days
- **Filters:** `All immediate regular .github/workflows/*.lock.yml files in the proven checkout commit, without sampling.`; `V4 semantics beginning at the category self-check repair, with runtime/frontmatter-only differences reviewed separately. Older executions remain inventoried but cannot be silently relabeled as V4.`; `Parse with pinned PyYAML safe_load; preserve raw input byte lengths; account for its YAML 1.1 on-key boolean normalization.`; `Resolve engine from first-line gh-aw-metadata agent_id, then sole engine_versions key, then an unambiguous GH_AW_ENGINE_ID environment value; unresolved is explicit.`; `Read permissions from jobs.agent and separately union all job grants; scalar read-all/write-all remain explicit, not invented finite scope maps.`; `Read GH_AW_SAFE_OUTPUTS_CONFIG as JSON from agent steps; deduplicate the handler copy and fail on conflicting configurations; never scrape discussion_category.`; `Prefer gh-aw-manifest mcp_servers, use allowed-tool comments only for absent legacy manifests, retain fallback counts.`; `A run-script is a step with a string run value; structural counts are YAML nodes, not shell command estimates.`; `Compare integer counts exactly and fractional native statistics only within the explicitly displayed rounding precision; retain exact unrounded expected quantities.`; `Cache history is evidence discovery; an older cached date alone is not original run/source/input binding.`; `Protected upload proves which bytes were retained, not whether those bytes or the report's recommendations were correct.`; `Interestingness, recommendation usefulness and downstream decisions are not established by numeric reconciliation.`; `Five-bash-turn and one-million-token limits need complete original tool/usage receipts.`; `Publication in audits requires a protected persisted-effect receipt or immutable independently bound original Discussion.`; `Retention of daily history does not establish the originality or input identity of older cached entries.`; `No keep threshold, cost, sole attribution or causal improvement is assumed.`

The frozen definitions and formulas are applied to every post-adoption observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `lockfile-stats-timeline.json` artifact.

## Important limitation

This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow.

Value-function SHA-256: `d2620a211063d934f45097cf5cb14d601dc851ea20efe0f3b40902fb6340d28c`
