---
title: At a glance
description: See what is moving, what needs attention, and whether the evidence is ready for follow-up.
---

The dashboard is the operational view of your Central Agentic Ops control
plane. It turns retained activity evidence into focused views, each designed to
answer a specific question:

- What work is moving now?
- What has reached the repositories in scope?
- What needs attention or a closer look?
- Is the evidence complete and current enough to act on?

<div class="docs-theme-diagram">
	<img class="docs-theme-diagram-light" alt="The selected dashboard view sends a Dashboard Language query to structured data and receives results" src="/gh-aw-cao/assets/dashboard-view-system-light.svg">
	<img class="docs-theme-diagram-dark" alt="The selected dashboard view sends a Dashboard Language query to structured data and receives results" src="/gh-aw-cao/assets/dashboard-view-system-dark.svg">
</div>

## How it works

Every view follows the same data flow:

1. **Activity collects evidence.** The Activity workflow publishes a bounded
	snapshot of workflow activity.
2. **The dashboard prepares the data.** A Web Worker normalizes the snapshot
	into a consistent data model and runs declarative queries.
3. **The active view presents the result.** When the local data changes, the
	query runs again and the view updates.

The dashboard is not a live feed. It reads the latest snapshot collected by the
Activity workflow. [Data ingestion](dashboard-data-ingestion.md) follows that
evidence from collection into the browser, while the
[Data model](dashboard-data-model.md) explains the records and relationships
available to every view.

## Read a result

Treat each result as a starting point for investigation, not as a scorecard. A
high count, a quiet period, or a warning tells you where to look next. Before
following up, check the availability, completeness, and freshness shown with it:

- **Empty** means the dashboard has evidence and found no matching activity.
- **Unavailable** means the dashboard could not obtain the evidence it needs.
- **Partial** means the result may describe only part of the campaign.
- **Stale** means newer activity may not be represented yet.

These distinctions keep missing information from looking like a healthy zero.

See the [Glossary](glossary.md) for definitions of Dashboard terms such as
rollout mode, safe output, outcome, and operational value.

## Know the boundary

The dashboard helps you observe and investigate campaigns. It does not start
work, approve an output, grant workflow authority, change rollout policy, or
write to a repository. Make those decisions through the control repository and
its reviewed workflows and policy.

## Continue reading

- Start with [Overview](dashboard-overview.md) to understand the default
	operational view.
- Read [Data ingestion](dashboard-data-ingestion.md) to follow evidence from
	GitHub Actions into the browser.
- Use the [Data model](dashboard-data-model.md) to understand entities,
	relationships, identities, and retention.
- Build views with the [Dashboard Language guide](dashboard-language.md), then
	consult the [language specification](dashboard-language-specification.md) and
	[view catalog](dashboard-view-catalog.md) for complete reference material.