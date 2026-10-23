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
	<img class="docs-theme-diagram-light" alt="The selected dashboard view sends a Dashboard Language query to structured data and receives results" src="/gh-cao/assets/dashboard-view-system-light.svg">
	<img class="docs-theme-diagram-dark" alt="The selected dashboard view sends a Dashboard Language query to structured data and receives results" src="/gh-cao/assets/dashboard-view-system-dark.svg">
</div>

## How it works

Every view follows the same data flow:

1. **Activity collects evidence.** The Activity workflow publishes a bounded
	snapshot of workflow activity.
2. **The selected backend prepares and queries the data.** Static Pages uses a
	browser Web Worker and IndexedDB; local Go serving uses SQLite; hosted Go
	serving uses PostgreSQL. Each evaluates Dashboard Language.
3. **The active view presents the result.** When the underlying data changes, the
	query runs again and the view updates.

The dashboard is not a live feed. It reads the latest snapshot collected by the
Activity workflow. [Data ingestion](dashboard-data-ingestion.md) follows that
evidence into each query backend, while the
[Data model](dashboard-data-model.md) explains the records and relationships
available to every view.

On the first visit to a static dashboard, a dismissible import screen explains
how the browser downloads and caches its first snapshot. Dismissing it keeps
the import running; Overview continues to show preparation progress rather
than calling campaigns idle. The import screen is automatically removed when a
complete snapshot is ready, and its animation timers and progress subscription
are released. If preparation fails or is cancelled while the screen is still
open, it shows a **Retry import** action. **Explore data** or Escape dismisses
the screen; Overview cannot reopen it after dismissal. Later visits use the
cached snapshot during refresh. Go-backed dashboards do not use this
browser-local first-import experience and do not fall back to it on failure.

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

Reading dashboard evidence does not start work, approve an output, grant
workflow authority, change rollout policy, or write to a repository. Make those
decisions through the control repository and its reviewed workflows and policy.
Static Pages is read-only; optional canvas commands and
[hosted CLI actions](https://github.com/githubnext/gh-cao/blob/main/server/README.md#hosted-cli-actions)
have separate authorization and approval requirements.

### Design queries in a Copilot canvas

The local canvas adds a **Query editor** under **Experimental**, with
AI-assisted authoring and workspace-local saved views. It is not enabled on the
static website, hosted server, or ordinary local preview. See the
[canvas guide](agent-plugin.md#design-queries-in-a-copilot-canvas) for setup,
limits, AI-credit use, saving, and the Go/SQLite execution boundary.

### Configure compiler defaults

**Maintenance → Governance** is visible only to an authorized hosted
administrator with a current, assured session. It is hidden in published
dashboards, local Go previews and Copilot canvases, including through direct
links. The standalone Node `--admin` mode has been retired.

Hosted repository installation tokens cannot administer organization or
enterprise variables, so this editor remains disabled there. Use `gh aw env`
outside the dashboard with administrative credentials for the exact chosen
scope. Review sets and deletions before applying, verify saved variables and
recompile workflows to incorporate changed compiler defaults.

Organization and enterprise variables are inherited by repositories with access
to them, including CAO repositories, but may also affect repositories outside
CAO. Existing narrower overrides and variable access lists remain in effect.
`null` or omitted keys remove an override at the selected scope, not an inherited
default. Visibility controls access for newly created variables only.

This page manages **non-secret GitHub Actions variables**, not secrets, rollout
policy, or live authority. Never enter credentials in the YAML. The chosen scope
requires administrative access; hosted repository installation tokens cannot
perform these operations, so editing remains disabled for hosted administrators.

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
- Use the [Copilot plugin and canvas](agent-plugin.md) for local query authoring
	and explicitly approved commands.