---
title: Restructure Dashboard Home Page Around an Attention-First, Work-Item-Oriented View
description: Record the dashboard's attention-first home page and work-item-oriented view decision.
---

# ADR 2572: Restructure Dashboard Home Page Around an Attention-First, Work-Item-Oriented View

## Status

Proposed

## Context

The dashboard previously rendered its home page and drill-down views without dedicated sources for work-item-level telemetry. This PR adds four new data sources — `work-items`, `attention-signals`, `agent-assignments`, and `evidence-records` — registered in `.github/cao/dashboard/report/dashboard-language-sources.mjs`, and extends `.github/cao/dashboard/site/src/specification.js` with corresponding source fields and entity identifiers.

Using these new sources, `.github/cao/dashboard/site/dashboard.json` introduces a "home" page of kind "custom" with an "attention-first" layout composed of four views:
- `home-attention`: renders `attention-signals` as a full-width signal-list, described as "Unresolved conditions that require an authorized person to act or investigate, ordered by deterministic priority."
- `home-work`: a `work-items` table limited to 5 rows, keyed on objective/scope/phase/reason/next-action/owner — a grain described as "independent of the number of executions or agents involved."
- `home-outcomes`: uses the existing `outcomes` source, explicitly described as distinct from runtime success and operational value.
- `home-operational-pulse`: a pie chart of `work-items` by lifecycle-state, explicitly described as not collapsing "runtime, verification, outcome, evidence quality, budget, or capacity into one score."

Separate "work" and "agents" pages provide deeper drill-down views keyed on the same new sources (`work-lifecycle-distribution`, `work-inventory` including "waiting-on", and `agents-state-distribution` from `agent-assignments`).

Supporting changes include UI/styling updates for responsiveness (`ui-elements.js`, `styles.js`), new e2e tests asserting the new sources render correctly and that "decision hierarchy" is preserved across desktop and mobile (`smoke.spec.js`), updated unit tests validating presence and behavior of the new sources (`presenter.test.js`, `ui-elements.test.js`, `dashboard-language-sources.test.mjs`), and an updated dashboard authoring corpus test to account for the new attention-first home page view.

No existing ADR in `docs/adr/` referenced this PR at the time of writing, and the PR body does not link to one.

## Decision

Introduce four new dashboard data sources — `work-items`, `attention-signals`, `agent-assignments`, and `evidence-records` — and restructure the dashboard home page into an "attention-first" layout keyed on stable work-item identity (objective/scope/phase/reason/next-action/owner) rather than per-execution or per-agent telemetry. The home page is composed of four distinct views (attention signals, work-item summary, outcomes, and lifecycle-state pulse) that are explicitly kept separate rather than combined into a single score, and dedicated "work" and "agents" pages are added for deeper drill-down using the same sources.

## Alternatives Considered

Not inferable from current pull request evidence. The PR body and diff do not describe rejected designs, prior layout options, or alternative data modeling approaches that were considered and declined.

## Consequences

**Positive:**
- The dashboard specification (`specification.js`) and source registry (`dashboard-language-sources.mjs`) now formally define fields and entity identifiers for work-items, attention-signals, agent-assignments, and evidence-records, providing a documented contract for these sources.
- The home page surfaces unresolved conditions requiring action ("attention-first") ordered by deterministic priority, and separates work-item state from runtime success/operational value and from a single collapsed score, per the descriptions embedded in `dashboard.json`.
- New e2e tests (`smoke.spec.js`) assert the new sources render correctly and that the decision hierarchy is preserved across desktop and mobile views, and unit tests (`presenter.test.js`, `ui-elements.test.js`, `dashboard-language-sources.test.mjs`) validate presence and behavior of the new sources.
- Dedicated "work" and "agents" pages provide drill-down detail (e.g., lifecycle distribution, inventory with "waiting-on", agent-state distribution) without expanding the home page itself.

**Negative:**
- The dashboard authoring corpus test required modification to account for the new attention-first home page view, indicating the change affects previously established corpus/test expectations for the home page.
- Not inferable from current pull request evidence: no information is given on migration impact for existing dashboard consumers, backward compatibility of the prior home page layout, or performance implications of the added sources.
