---
title: At a glance
description: See what is moving, what needs attention, and whether the evidence is ready for follow-up.
---

The dashboard gives you an at-a-glance view of activity across your enrolled
repositories. It organizes that activity into views, with each view answering a
different operational question. Open one to see:

- What work is moving now?
- What has reached the repositories in scope?
- What needs attention or a closer look?
- Is the evidence complete and current enough to act on?

<div class="docs-theme-diagram">
	<img class="docs-theme-diagram-light" alt="The selected dashboard view sends a Dashboard Language query to structured data and receives results" src="/gh-aw-cao/assets/dashboard-view-system-light.svg">
	<img class="docs-theme-diagram-dark" alt="The selected dashboard view sends a Dashboard Language query to structured data and receives results" src="/gh-aw-cao/assets/dashboard-view-system-dark.svg">
</div>

Behind each view, the flow stays simple:

1. **Choose a view.** The Dashboard keeps navigation on the left and opens the
	selected View on the right.
2. **The view requests its data.** Its UI components send a declarative query,
	written in [Dashboard Language](dashboard-language-specification.md), to the
	shared canonical Data.
3. **Read the results.** Matching repository, workflow, and run records return
	to the open view. When newly downloaded evidence changes the local data, the
	view refreshes its result.

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
- **Partial** means the result may describe only part of the operation.
- **Stale** means newer activity may not be represented yet.

These distinctions keep missing information from looking like a healthy zero.

## Know the boundary

The dashboard helps you observe and investigate operations. It does not start
work, approve an output, grant workflow authority, change rollout policy, or
write to a repository. Make those decisions through the control repository and
its reviewed workflows and policy.

## Continue reading

- **Views → Overview** identifies what each part of the default view tells you.
- **Data ingestion** follows evidence from GitHub Actions into the dashboard.
- **Data model** explains the records, relationships, and evidence states behind
	each result.