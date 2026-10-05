---
title: At a glance
description: See what is moving, what needs attention, and whether the evidence is ready for follow-up.
agent:
  type: dashboard
  prominent: true
  binding:
    kind: dashboard-page
    id: overview
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

## Two ways to run the dashboard

There is one dashboard product and browser UI, with two data backends. Both use
the same Dashboard Language documents and are built from the dashboard site;
they differ in where data is stored and queries execute.

- **GitHub Pages (static/browser):** The starter experience and default
  deployment. GitHub Actions publishes the site and its data snapshot; each
  viewer's browser downloads the snapshot, and a Web Worker normalizes it into
  disposable IndexedDB storage and runs queries there. It needs no extra server,
  database, or cloud resources to operate beyond the control repository and
  GitHub Pages.
- **Go server (hosted):** The scale-oriented deployment for larger datasets, or
  when you need per-user sign-in or webhook-driven refresh. The Go service serves
  the dashboard UI and a same-origin API. It verifies the published snapshot,
  stores dashboard entities in PostgreSQL, and executes Dashboard Language
  queries on the server. The browser does not connect to the database. Redis is
  for operational state such as sessions and queues, not dashboard data or
  queries. This option requires operating the server and its database and Redis
  resources; hosted deployments can require GitHub OAuth and
  organization/team authorization.

These are backend modes of the same dashboard, not two separate page
implementations. A view or data source may still be supported by only one
backend. Compare the [deployment options](deployment.md) before choosing where
to run it.

## How it works

In the GitHub Pages deployment, every view follows this data flow:

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

On the first visit to a static dashboard, a dismissible import screen explains
how the browser downloads and caches its first snapshot. Dismissing it keeps
the import running; Overview continues to show preparation progress rather
than calling campaigns idle. The import screen is automatically removed when a
complete snapshot is ready, and its animation timers and progress subscription
are released. If preparation fails or is cancelled, Overview reports an incomplete
import and lets you reopen the screen to retry. Later visits use the cached
snapshot during refresh. Backend-backed dashboards do not use this browser-local
first-import experience. While the import screen is visible, 100 friendly notes
rotate randomly every six seconds without repeating within a cycle. These notes
are separate from factual import progress and pause when the screen is dismissed
or the import is no longer running.
Small screens use shorter copy and omit the explanatory step list so the main
action stays in view. The backdrop shares the exact grid styling used on
Overview, with a slow opacity animation disabled when the browser requests
reduced motion. The grid is decorative, not campaign telemetry.

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
- Choose where to host the dashboard in [Deployment options](deployment.md).
- Read [Data ingestion](dashboard-data-ingestion.md) to follow evidence from
	GitHub Actions into the browser.
- Use the [Data model](dashboard-data-model.md) to understand entities,
	relationships, identities, and retention.
- Build views with the [Dashboard Language guide](dashboard-language.md), then
	consult the [language specification](dashboard-language-specification.md) and
	[view catalog](dashboard-view-catalog.md) for complete reference material.
- Let browser agents read the same pages through [WebMCP](dashboard-webmcp.md),
	and agents without a browser or shell through
	[Agent analysis](agent-analysis.md).