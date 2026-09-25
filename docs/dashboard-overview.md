---
title: Overview
description: Understand the current activity, delivery evidence, and operational signals on the dashboard's default view.
---

Overview is the dashboard's default operational view. It answers three
questions without requiring you to inspect raw workflow activity:

1. Is work moving?
2. What activity and evidence have been retained?
3. Where should I investigate next?

The page presents campaign activity. Its status header and weekly
rhythm summarize current activity, while a campaign-health station and a
repository-coverage station connect that activity to registered campaigns and
repository scope. A campaign links list gives direct navigation into every
registered campaign's Insights view. These are related operational signals,
not stages in a conversion funnel.

## What Overview shows

<div class="docs-theme-diagram">
	<img class="docs-theme-diagram-light" alt="Overview page composition with a status header, weekly rhythm, and two operational stations" src="/gh-aw-cao/assets/dashboard-overview-desktop-light.svg">
	<img class="docs-theme-diagram-dark" alt="Overview page composition with a status header, weekly rhythm, and two operational stations" src="/gh-aw-cao/assets/dashboard-overview-desktop-dark.svg">
</div>

| Dashboard area | What it tells you | Where it leads |
| --- | --- | --- |
| **Status header** | Whether runs are queued or in progress and the current evidence-based status. | Runs, outputs, or operational graders when the status is unexpected. |
| **Campaign rhythm** | Successful runs for each weekday in the current week, with previous-week context for weekdays not yet reached. | Runs when the cadence changes unexpectedly. |
| **Campaigns (health station)** | The share of registered campaigns with no retained workflow or target errors. | Campaigns for the campaigns reporting a problem. |
| **Repositories (coverage station)** | Registered repositories that received a successful worker delivery against the total registered scope. | Repositories for the complete inventory and delivery evidence. |
| **Campaigns list** | One navigation row per registered campaign, with a problem indicator when one exists. | Each campaign's dedicated Insights view. |

The selected dashboard time range applies before Overview calculates these
values. The start time is inclusive and the end time is exclusive. Campaign
rhythm uses a 15-day input window to construct its current- and previous-week
comparison.

For the component boundaries, responsive behavior, and exact query names behind
each area, see the [Overview component model](dashboard-overview-components.md).

## How to interpret the metrics

Read each station as a prompt for investigation, not as a health or conversion
score:

- Campaign health counts registered campaigns with no retained workflow or
  target error; it does not measure repository outcomes or operational value.
- Repository coverage counts registered repositories that received at least
  one successful worker delivery; a repository can be registered without yet
  receiving work during the selected time range.
- A campaign link opens that campaign's Insights view; a problem indicator
  there reflects retained workflow or target errors, not operational value.

Missing evidence remains unavailable rather than becoming a healthy zero.

## Where the data comes from

Overview uses the shared snapshot published by [CAO Activity](activity.md). The
[Activity Specification](https://github.com/githubnext/gh-aw-cao/blob/main/specs/activity.md)
defines the snapshot and its requirements.

| Source | How Overview uses it |
| --- | --- |
| `runs` | Counts active, successful, and failed runs; builds Campaign rhythm and the run-motion status input. |
| `campaigns` | Lists registered campaigns for the campaign-health station and campaign links. |
| `campaign-runtime-problem-counts` | Flags campaigns with retained workflow or target errors for campaign health and link indicators. |
| `repositories` | Counts canonical repository identities in the observed control-plane scope for repository coverage. |
| `workflows` | Identifies declared workers and enriches run context. |
| `outcomes` | Supplies delivery evidence for the repository-coverage station. |

If one of these sources is unavailable, Overview reports the missing evidence
instead of reconstructing it from unrelated totals.

## When to investigate

Start with Runs when the status heading reports strain, a failure count is
nonzero, or Campaign rhythm changes unexpectedly. Use Campaigns to find a
campaign reporting a problem, and Repositories to reconcile registered scope
against delivery evidence. Always check the selected time range and evidence
freshness before drawing a conclusion.
