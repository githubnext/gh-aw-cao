---
title: "What Example: Properly Provisioned Permissions measures"
description: "Definitions, evidence rules, and interpretation for the Example: Properly Provisioned Permissions operational-value report."
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether an agent or workflow caused the observed changes.

## Value review

**Assessment:** not-rated. No agreed native keep bar and review duration.

**Latest repository outcome:** 0 permission grants; complete

**Measurement:** snapshot; 7-day window, 7-day cadence.

**Recent change:** 0 permission grants

**Review basis:** No keep bar has been agreed; native evidence is still reported.

**Outcome-matched costs:** Not measured. No cost-per-outcome or monetary return is inferred.

| Period ending, UTC | Read-scope mismatches (permission grants) | Agent write grants (permission grants) | Eligible opportunities | Evidence |
|---|---:|---:|---:|---|
| 2026-08-14T04:13:41Z | 0 | 0 | 3 | complete |
| 2026-08-21T04:13:41Z | 0 | 0 | 3 | complete |
| 2026-08-28T04:13:41Z | 0 | 0 | 3 | complete |
| 2026-09-04T04:13:41Z | 0 | 0 | 3 | complete |
| 2026-09-11T04:13:41Z | 0 | 0 | 3 | complete |
| 2026-09-18T04:13:41Z | 0 | 0 | 3 | complete |
| 2026-09-25T04:13:41Z | 0 | 0 | 3 | complete |
| 2026-10-02T04:13:41Z | 0 | 0 | 3 | complete |
| 2026-10-09T04:13:41Z | 0 | 0 | 3 | complete |
| 2026-10-11T15:00:12Z | 0 | 0 | 3 | complete |
| 2026-10-16T04:13:41Z | 0 | 0 | 3 | complete |
| 2026-10-18T15:00:12Z | 0 | 0 | 3 | complete |

The latest 12 periods are shown; the full native series is in the timeline.
Repository attainment includes other actors. Only a separately declared, independently verified contribution measure supports a workflow keep/change recommendation; it is not causal attribution.
Demonstrated workflow-enabled improvements count as shared contribution even when another agent or person implements them. Report measured progress, full goal completion, safeguards and attribution confidence separately. An unknown quality dimension does not cancel independently verified improvement; a merge alone does not verify that improvement.

## How to read the timeline

- Observations begin at workflow adoption on `2025-10-31`.
- No comparable pre-adoption evidence is available. Complete adjacent post-adoption periods may still show recent change, but not change relative to adoption.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Execution activity is diagnostic only. It does not prove repository value.
- Recent change compares the immediately preceding equal-duration period, not lifetime movement. Interval windows must abut without overlap; snapshot values compare cutoff states.
- Two observations show observed change, not a sustained trend, statistical anomaly or target attainment. Unknown coverage, gaps and provisional evidence make comparison unavailable.
- Adoption comparison is separate. Stable-but-bad outcomes are not healthy merely because their latest delta is zero; workload-mix changes can explain aggregate movement.

## What was measured

**Goal:** Provision the example agent's contents, issues and pull-requests scopes at read level.

**Accepted outcome:** Inspect the actual immutable compiled agent-job permission map. Each of the three declared toolset read requirements must be exactly read; write grants are a separate safeguard. This is a configuration facet, not compiler-warning or live access verification.

### Required read-scope mismatches

- **What it tells you:** Required read-scope mismatches. This is a `primary` measure.
- **Native measurement formula:** `Count contents, issues and pull-requests grants whose effective compiled agent-job level is not exactly read.`
- **Unit:** `permission grants`
- **Goal:** Lower values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Compiled agent write grants

- **What it tells you:** Compiled agent write grants. This is a `diagnostic` measure.
- **Native measurement formula:** `Count write-valued entries in the agent's effective explicit permission map, not other jobs.`
- **Unit:** `permission grants`
- **Goal:** Lower values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** The frozen example's three read-scope obligations in each immutable compiled agent job.
- **Collection:** Digest-checked public immutable source and compiled workflow blobs at adoption and weekly/cutoff endpoints.
- **Observation window:** 7 days, sampled every 7 days
- **Maturation delay:** 0 days
- **Filters:** `Read compiled YAML, not a source-frontmatter promise or successful workflow run.`; `An explicit agent-job map replaces the workflow-level map; only an absent job map inherits the workflow map.`; `Missing entries in an explicit map are none. Missing maps, aliases, macros and unsupported job shapes remain unknown.`; `Retain warning-demo-era values as retrospective current-policy diagnostics, never as failures of that intentional warning example.`; `Only the known read-only-demo intent era without agent write grants is comparable for this configuration facet.`; `Do not flag safe-output or conclusion-job write grants as agent permissions.`; `MCP read-only enforcement, token credentials, compiler warnings, live authorization, costs and workflow causation are not measured.`

The frozen definitions and formulas are applied to every post-adoption observation. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `example-permissions-warning-timeline.json` artifact.

## Important limitation

This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow.

Value-function SHA-256: `e471c8fc5873d18be66b8e970253d03b63bea9ca0c7540da8f118668ba6cf00d`
