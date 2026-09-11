---
title: Dashboard Overview
description: Understand how the dashboard presents the control plane as a running, evidence-backed factory.
---

# Dashboard Overview

Overview is a quiet operational summary of the control plane. It answers three
questions without requiring an operator to inspect raw workflow activity:

1. Is governed work moving?
2. What accepted outcomes reached repositories?
3. Does an operator need to intervene?

The page uses a factory mental model because the control plane governs scope,
runs bounded work, checks safe outputs, and retains evidence of outcomes. The
visual sequence is not a conversion funnel: a successful run can correctly
produce no safe output, and an output can remain pending while evidence matures.

| Surface | Population rule |
| --- | --- |
| **Repositories in scope** | Counts retained canonical `repositories` rows. Review and live counts appear only when `rollout-mode` is explicitly observed. |
| **Workflows observed** | Counts retained canonical `workflows` rows. This is observed inventory, not a claim that every workflow is active. |
| **In motion** | Counts `work-items` rows in `active` or `waiting`; when none are available, uses `runs` rows whose normalized status is `queued` or `in-progress`. |
| **Safety gate** | Uses retained `safe-output-performance.safe-output-count` observations, bounded below by the retained outcome count so asynchronous sources do not understate observed outputs. Pending outcomes remain identified as awaiting evidence. |
| **Landed** | Counts the latest observation for each safe output when `outcome-state` is `accepted`, `completed`, or `lifecycle-close`. |
| **Repository output** | Separately counts accepted pull-request outcomes, issue outcomes, and distinct repositories reached. |
| **Factory rhythm** | Shows accepted outcomes over the last seven observed UTC days. |

The selected dashboard horizon filters source rows before Overview calculates
these values. Its start timestamp is inclusive and its end timestamp is
exclusive.

## How the sources are populated

The dashboard report builds Overview sources from the shared snapshot published
by [CAO Activity](activity.md). The
[Activity Specification](https://github.com/githubnext/gh-aw-cao/blob/main/specs/activity.md)
defines the snapshot and consumer obligations; this page defines how Overview
derives and presents the factory summary.

### Runs

The `runs` source is built from `runHealth.runRecords` for workflows discovered
in the control repository. Each row preserves repository, workflow, run ID,
status, normalized conclusion, timestamps, rollout mode, engine and model
metadata, available failure details, and a link to the Actions run.

Run availability requires either an available deployed run-health snapshot or
at least one retained run. Completeness follows the run-health collection state.
Overview does not infer failed runs from outcome records or aggregate counters
when canonical run rows are absent.

### Work and inventory

The report creates one work item per discovered workflow, joined to its latest
canonical run and latest matching durable outcome. Identity is stable across
executions and is based on organization, repository, and workflow.

Lifecycle state is assigned deterministically:

| Condition | Lifecycle state |
| --- | --- |
| Admission denied or blocked, or run concluded with a failure, timeout, startup failure, or action required | `blocked` |
| Latest run is queued | `waiting` |
| Latest run is in progress | `active` |
| Latest outcome is pending | `review` |
| Latest run succeeded, was cancelled, skipped, neutral, or stale | `completed` |
| No usable run state exists | `unknown` |

Repository and workflow inventory provide factory capacity context. Work items
provide the preferred in-motion count because they represent delegated work
rather than raw runtime activity. Overview falls back to queued and in-progress
runs only when no active or waiting work item is retained.

### Safe outputs and outcomes

Safe outputs and outcomes are different observations. Safe-output performance
describes emitted output activity. An outcome is a later repository-state
evaluation and may remain pending until evidence matures. Overview deduplicates
outcomes by safe-output identity and uses the latest observation.

Overview does not display a synthetic factory score or estimate human time
saved. A numeric effort claim requires an operation-specific operational-value
contract with accepted evidence, a stable opportunity, maturation rules, and a
defensible baseline. Until such a source exists, accepted outcomes communicate
work returned to the team without inventing minutes per output.

## Maintenance and evidence states

Failed run observations take intervention priority. Conclusions of `failure`,
`startup-failure`, `stale`, and `timed-out` produce one maintenance affordance
that opens Runs with the `run-conclusion=failure` facet preselected. If evidence
is degraded or unknown, the maintenance text qualifies the count as a retained
observation rather than hiding the failure path.

When no failure needs intervention, Overview derives one evidence state from
the required outcome, run, repository, and workflow source metadata:

- **Trusted** means every required source is available, complete, and fresh.
- **Degraded** means at least one required source is partial or stale.
- **Unknown** means a required source state cannot be determined.
- **Insufficient** means a required source is unavailable.

Only trusted evidence with no observed failures can show **No maintenance
needed**. Empty, partial, stale, unknown, and unavailable evidence are never
coerced into a healthy-system verdict.

See [Dashboard data health](dashboard-data-health.md) for the availability,
completeness, freshness, coverage, and confidence contracts.