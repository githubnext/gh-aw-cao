---
title: Overview
description: Understand the current activity, delivery evidence, and operational signals on the dashboard's default view.
---

Overview is the dashboard's default operational view. It answers three
questions without requiring you to inspect raw workflow activity:

1. Is work moving?
2. What activity and evidence have been retained?
3. Where should I investigate next?

The page presents the control plane as a factory. Its status header and weekly
rhythm summarize current activity, while four metrics connect that activity to
repository scope, runs, dispatches, and value evidence. These are related
operational signals, not stages in a conversion funnel.

## What Overview shows

<div class="docs-theme-diagram">
	<img class="docs-theme-diagram-light" alt="Overview page composition with a status header, weekly rhythm, and four operational metrics" src="/gh-aw-cao/assets/dashboard-overview-desktop-light.svg">
	<img class="docs-theme-diagram-dark" alt="Overview page composition with a status header, weekly rhythm, and four operational metrics" src="/gh-aw-cao/assets/dashboard-overview-desktop-dark.svg">
</div>

| Dashboard area | What it tells you | Where it leads |
| --- | --- | --- |
| **Status header** | Whether runs are queued or in progress, the current evidence-based status, and the number of retained issue and pull request outputs. | Runs, outputs, or Operational value when the status is unexpected. |
| **Factory rhythm** | Successful runs for each weekday in the current week, with previous-week context for weekdays not yet reached. | Runs when the cadence changes unexpectedly. |
| **Repositories registered** | Distinct repositories represented in the retained control-plane scope. | Repositories for the complete inventory. |
| **Successful runs** | Runs that completed successfully, with failed runs shown separately. | Runs with the success or failure filter applied. |
| **Dispatches** | Retained `workflow_dispatch` runs, with failed dispatches shown separately. | Dispatches for campaign-worker activity. |
| **Value gains** | Grader observations available as operational-value evidence. | Operational value for the underlying graders, value contracts, and evidence. |

The selected dashboard time range applies before Overview calculates these
values. The start time is inclusive and the end time is exclusive. Factory
rhythm uses a 15-day input window to construct its current- and previous-week
comparison.

For the component boundaries, responsive behavior, and exact query names behind
each area, see the [Overview component model](dashboard-overview-components.md).

## How to interpret the metrics

Read each metric as a prompt for investigation, not as a health or conversion
score:

- A registered repository has entered the observed scope; it may not have
  received work during the selected time range.
- A successful run completed without a failure conclusion; it may correctly
  produce no safe output.
- A dispatch records a workflow handoff; it does not prove that work reached a
  target repository.
- A value gain records grader evidence; its meaning depends on the operation's
  metric identifier, native value, unit, direction, and evaluator.

Missing evidence remains unavailable rather than becoming a healthy zero.

## Where the data comes from

Overview uses the shared snapshot published by [CAO Activity](activity.md). The
[Activity Specification](https://github.com/githubnext/gh-aw-cao/blob/main/specs/activity.md)
defines the snapshot and its requirements.

| Source | How Overview uses it |
| --- | --- |
| `runs` | Counts successful, failed, active, review, live, and dispatched runs; builds Factory rhythm. |
| `repositories` | Counts distinct repositories in the observed control-plane scope. |
| `workflows` | Identifies declared workers and enriches run context. |
| `outcomes` | Counts retained issue and pull request outputs and repositories with accepted delivery evidence. |
| `grader-observations` | Counts evidence associated with operational value. |

If one of these sources is unavailable, Overview reports the missing evidence
instead of reconstructing it from unrelated totals.

## When to investigate

Start with Runs when the status heading reports strain, a failure count is
nonzero, or Factory rhythm changes unexpectedly. Use Repositories to reconcile
scope, Dispatches to inspect worker handoffs, and Operational value to interpret
grader evidence. Always check the selected time range and evidence freshness
before drawing a conclusion.
