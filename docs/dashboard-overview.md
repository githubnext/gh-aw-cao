---
title: Dashboard Overview
description: See what your control plane is doing, what reached repositories, and where you may need to act.
---

Overview gives you a quick picture of your control plane. You can answer three
questions without digging through raw workflow activity:

1. Is work moving?
2. What reached my repositories?
3. Does anything need my attention?

The page presents the control plane as a factory: it controls scope, runs
approved work, checks safe outputs, and keeps evidence of the results. The
stages do not represent a conversion funnel. A successful run may correctly
produce no safe output, and an output may stay pending while CAO collects enough
evidence to confirm the result.

## What Overview shows

<div class="docs-theme-diagram">
	<img class="docs-theme-diagram-light" alt="Overview page composition with Header, Rhythm, Floor, and four Station components" src="/gh-aw-cao/assets/dashboard-overview-desktop-light.svg">
	<img class="docs-theme-diagram-dark" alt="Overview page composition with Header, Rhythm, Floor, and four Station components" src="/gh-aw-cao/assets/dashboard-overview-desktop-dark.svg">
</div>

| Dashboard area | What it tells you |
| --- | --- |
| **Repositories in scope** | How many repositories appear in the retained `repositories` data. Review and live totals appear only when CAO has observed a `rollout-mode`. |
| **Workflows observed** | How many workflows CAO has seen. This is inventory, not a claim that every workflow is active. |
| **In motion** | Work that is active or waiting. If work-item data is unavailable, Overview uses queued and in-progress runs instead. |
| **Safety gate** | Safe outputs observed so far. Pending outcomes remain marked as waiting for evidence. |
| **Landed** | Safe outputs whose latest `outcome-state` is `accepted`, `completed`, or `lifecycle-close`. |
| **Repository output** | Accepted pull requests, accepted issues, and the number of repositories reached. |
| **Factory rhythm** | Accepted outcomes during the latest seven observed UTC days. |

The dashboard time range applies before Overview calculates these values. Data
at the start time is included; data exactly at the end time is not.

## Where the data comes from

Overview uses the shared snapshot published by [CAO Activity](activity.md). The
[Activity Specification](https://github.com/githubnext/gh-aw-cao/blob/main/specs/activity.md)
defines that snapshot and its requirements. This page explains how Overview
turns the snapshot into the summary you see.

### Runs

The `runs` source comes from `runHealth.runRecords` for workflows found in the
control repository. Each run keeps its repository, workflow, run ID, status,
conclusion, timestamps, rollout mode, engine and model details, available
failure information, and a link to the Actions run.

Overview shows run data when a deployed run-health snapshot is available or at
least one run has been retained. It reports the same completeness state as the
run-health collection. If run records are missing, Overview does not guess at
failures from outcome records or totals.

### Work and inventory

The report creates one work item for each discovered workflow and connects it to
the latest run and durable outcome. The work item keeps the same identity across
executions based on its organization, repository, and workflow.

Overview assigns each work item a state using these rules:

| What happened | State shown |
| --- | --- |
| Admission was denied or blocked, or the run failed, timed out, failed to start, or requires action | `blocked` |
| The latest run is queued | `waiting` |
| The latest run is in progress | `active` |
| The latest outcome is pending | `review` |
| The latest run succeeded, was cancelled, skipped, neutral, or stale | `completed` |
| No usable run state is available | `unknown` |

Repository and workflow inventory show the size of the factory. Overview uses
work items for the **In motion** count because they represent delegated work,
not just runtime activity. It uses queued and in-progress runs only when no
active or waiting work items are available.

### Safe outputs and outcomes

A safe output records what a workflow emitted. An outcome records what CAO later
observed in the repository. Outcomes may remain pending until enough evidence is
available. When CAO has several observations for one safe output, Overview uses
the latest one.

Overview does not invent a factory score or estimate time saved. A numeric claim
needs an operation-specific value contract, accepted evidence, a stable
opportunity, clear maturation rules, and a defensible baseline. Until that data
exists, Overview reports accepted outcomes without assigning made-up minutes to
each output.

## When Overview asks for attention

Failed runs appear first when action is needed. A `failure`, `startup-failure`,
`stale`, or `timed-out` conclusion provides a link to Runs with the failure
filter already selected. If the evidence is degraded or unknown, Overview says
that the count comes from retained observations instead of hiding the failure.

When there are no observed failures, Overview summarizes how much you can trust
the available outcome, run, repository, and workflow data:

- **Trusted:** Every required source is available, complete, and fresh.
- **Degraded:** At least one required source is incomplete or stale.
- **Unknown:** CAO cannot determine the state of a required source.
- **Insufficient:** A required source is unavailable.

Overview shows **No maintenance needed** only when the evidence is trusted and
there are no observed failures. Missing, incomplete, stale, unknown, or
unavailable data never becomes a healthy verdict by default.
