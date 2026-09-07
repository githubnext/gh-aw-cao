# ADR 4609: GitHub native redesign of CAO dashboard

## Status

Draft

## Context

The CAO dashboard previously organized navigation around a different set of views, including legacy and investigative navigation groups. This pull request (githubnext/gh-aw-cao#4609, `improve-roadmap-views` → `main`, authored by mnkiefer) redesigns the dashboard around five primary destinations: "Home", "Work", "Agents", "Insights", and "Settings":

- "Home" is described as an attention-first catch-up experience grounded in retained evidence.
- "Work" provides GitHub Projects-style Board, Tasks, and Roadmap views, with the Roadmap supporting Day, Week, Month, Quarter, and Year zoom levels, and shows safe-output primitives, actor roles, and a current-date marker.
- "Agents" adds a policy-scoped Agents Marketplace with package README details.
- "Insights" composes an overview across outcomes, value, usage, runtime, security, and experiments.
- "Settings" improves checked-in `cao.json` policy editing.

The PR also extends dashboard source generation for work identity, package metadata, safe outputs, and actor roles, and updates the Dashboard Language and normative dashboard specifications (`docs/dashboard-language-specification.md`, `specs/dashboard.md`) to reflect these views. The change touches 59 files with roughly 3,410 core additions, including new components (`agent-marketplace-view.js`, `insights-overview.js`, `package-readme.js`, `package-route-composition.js`, `work-project-view.js`) and updates to existing presenter, validator, styles, and data-source modules.

Separately, the PR body notes that with this change, legacy and investigative navigation groups are hidden by default, remaining reachable only via the shareable hash parameter `?show=experimental` (e.g. `#page-overview?show=experimental`).

Not inferable from current pull request evidence: the specific prior navigation structure being replaced, user or stakeholder feedback motivating the redesign, and any performance or usage metrics.

## Decision

Reorganize the CAO dashboard's information architecture around five primary, "locked" (reviewed and stabilized) destinations — Home, Work, Agents, Insights, and Settings — as the default navigation surface, and move legacy and investigative navigation groups behind an opt-in `?show=experimental` hash parameter rather than removing or continuing to surface them by default.

This decision is implemented by adding new view components for Work (Board/Tasks/Roadmap), Agents (Marketplace with package README composition), and Insights (composed overview), improving the existing Settings/configuration view for `cao.json` policy editing, and extending the dashboard source-generation pipeline (`dashboard/report/*`) and specifications (`dashboard-language-specification.md`, `specs/dashboard.md`) to support the new work identity, package metadata, safe-output, and actor-role data needed by these views.

## Alternatives Considered

- **Keep the existing navigation structure and add the new Work/Agents/Insights capabilities as additional, non-primary views alongside legacy and investigative groups.** This was not the direction taken; the PR instead makes the five destinations primary and demotes legacy/investigative groups to an opt-in experimental flag.
- **Remove legacy and investigative navigation groups outright instead of hiding them behind a flag.** The PR evidence shows these groups are retained and reachable via `?show=experimental`, indicating an explicit choice to preserve access rather than delete the functionality.

## Consequences

**Positive:**
- Users get a single, attention-first default navigation (Home, Work, Agents, Insights, Settings) instead of a broader set of navigation groups, with Work explicitly modeled on familiar GitHub Projects-style Board/Tasks/Roadmap concepts.
- Legacy and investigative views remain available for users who need them, via the `?show=experimental` shareable hash parameter, avoiding outright loss of functionality.
- The dashboard's underlying data pipeline is extended (work identity, package metadata, safe outputs, actor roles) and the Dashboard Language / dashboard specifications are updated, giving the new views a documented, normative basis.
- Related run-metadata handling in `activity/README.md` is updated so that if `gh aw logs` fails, the downloader can fall back to the control repository's Actions workflow-run API to enrich cached snapshots with basic run identity, status, conclusion, and timing fields, while existing artifact-derived fields remain authoritative and admission evidence remains unavailable until gh-aw exposes it.

**Negative:**
- Legacy and investigative navigation groups are no longer visible by default, which changes discoverability for any users who relied on them without knowing about the `?show=experimental` parameter.
- The change spans 59 files and roughly 3,410 core additions across components, report generation, specifications, and data sources, representing a broad, coupled surface area that must be kept consistent going forward.
- Not inferable from current pull request evidence: any measured impact on user workflows, migration steps for existing bookmarked/shared dashboard links, or performance implications of the extended source-generation pipeline.
