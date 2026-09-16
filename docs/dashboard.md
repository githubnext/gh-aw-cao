---
title: What it shows
description: Use the CAO dashboard to check work in motion, spot what needs attention, and judge the evidence before following up.
---

Use the dashboard when you need a quick, shared picture of how your operations
are going. It helps you answer four practical questions:

- What work is moving now?
- What has reached the repositories in scope?
- What needs attention or a closer look?
- Is the evidence complete and current enough to act on?

Treat the dashboard as a starting point for investigation, not as a scorecard.
A high count, a quiet period, or a warning tells you where to look next; it does
not explain the cause by itself.

<picture>
	<source media="(prefers-color-scheme: dark)" srcset="/gh-aw-cao/assets/dashboard-view-system-dark.svg">
	<source media="(prefers-color-scheme: light)" srcset="/gh-aw-cao/assets/dashboard-view-system-light.svg">
	<img alt="Language queries the shared data model and supplies results to the selected view beside view navigation inside the dashboard shell" src="/gh-aw-cao/assets/dashboard-view-system-light.svg">
</picture>

The dashboard is not a live feed. It reads the latest snapshot collected by the
Activity workflow; the [Data model](dashboard-data-model.md) explains that flow.
Each view uses the dashboard's [Language](dashboard-language-specification.md)
to query the shared model. While a view is open, it updates when newly
downloaded evidence changes the local data.

Before acting, check the availability, completeness, and freshness shown with
the result:

- **Empty** means the dashboard has evidence and found no matching activity.
- **Unavailable** means the dashboard could not obtain the evidence it needs.
- **Partial** means the result may describe only part of the operation.
- **Stale** means newer activity may not be represented yet.

These distinctions keep missing information from looking like a healthy zero.

The dashboard helps you observe and investigate operations. It does not start
work, approve an output, grant workflow authority, change rollout policy, or
write to a repository. Make those decisions through the control repository and
its reviewed workflows and policy.

## Continue reading

- **Views → Overview** maps the Overview view and its responsive behavior.
- **Data model** explains the records, relationships, and evidence states behind
	dashboard results.