---
title: "What Daily AW Cross-Repo Compile Check measures"
description: "Definitions, evidence rules, and interpretation for the Daily AW Cross-Repo Compile Check operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** unknown percent; unavailable

**Measurement:** snapshot; 1-day window, 1-day cadence.

**Recent change:** unavailable: Fresh complete mature evidence is required for recent movement.

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Compiling repositories (percent) | Compiling workflows (workflows) | Eligible opportunities | Evidence |
|---|---:|---:|---:|---|
| 2026-10-19T09:57:11Z | unknown | unknown | unknown | partial-window: The source requires original independent strict compile/fix/recompile results, fixed compiler identity, full target inventories and a frozen public discovery cohort. None are present in the authorized offline inputs. Complete current workflow, imports, compiled source and native command/specification are reviewed; the compiled workflow has no independent protected native compile checker. Agent cache summaries, output markers, LLM evals and successful job conclusions cannot substitute. No outcome acquisition or execution is authorized; historical evidence availability is not exhausted. |

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

**Goal:** Maintain compiler compatibility with real public repositories using gh-aw, including the declared automatic migration pass.

**Accepted outcome:** Every native-selected workflow in each fixed selected repository independently compiles under the exact fixed assessed compiler after its one declared fix --write pass.

### Repository compatibility

- **What it tells you:** Selected repository compilation compatibility. This is a `primary` measure.
- **Native measurement formula:** `100 * compatibleRepositories / eligibleCount; only when all 20 selected repositories have complete independent native assessments.`
- **Unit:** `percent`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Known compiling workflows

- **What it tells you:** Independently compiling workflows. This is a `diagnostic` measure.
- **Native measurement formula:** `knownCompatibleWorkflows from verified original native per-workflow results; null when no workflows were independently assessed.`
- **Unit:** `workflows`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** A frozen cohort of the source-defined top 20 public, non-archived repositories discovered through gh-aw lock-file markers; each repository has its entire native compiler-selected workflow inventory assessed.
- **Collection:** Offline batch replay of digest-bound original protected compiler reports and exhaustive native workflow inventories. No GitHub API, execution, installation, discovery, compilation or network access occurs during collection/scoring.
- **Observation window:** 1 days, sampled every 1 days
- **Maturation delay:** 0 days
- **Filters:** `Discovery must preserve candidate identities, public/archive status, stars, ranking and selected revisions at or after contract activation, before reading outcomes.`; `Freeze the initial cohort and exact compiler build/binary/environment; subsequent star rankings or compiler fallback belong to separate comparison eras.`; `One unmodified compile --strict, one fix --write with the same compiler and no manual edits, then compile --strict. Preserve original inventories, generated outputs and complete transformation diff.`; `Only original protected independent compiler results at the assessed source revision count. Agent-writable cache summaries, issues, PRs, run conclusions and tracking markers are discovery, not acceptance.`; `Compiler validation failures are incompatibilities only when setup/access/import resolution are independently complete. Missing or infrastructure-failed evidence remains unknown.`

The frozen goal, acceptance rule and formulas are applied to every observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `daily-aw-cross-repo-compile-check-timeline.json` artifact.

## Important limitation

This report measures accepted repository outcomes against the stated goal. Contract activation is not an intervention or proof that an agent caused the outcomes; unavailable historical evidence supports no historical improvement claim.

Value-function SHA-256: `d9f656339478d5affaf0fae0822961a571716ccf2544b900d60ae9698991058a`
