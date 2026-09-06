# ADR 3532: Introduce `work-project-view` dashboard element for Projects-style Next Work board

## Status

Draft

## Context

The Dashboard Next Work page previously rendered a `work-inventory` table element (mark: `table`) with columns such as objective, scope, lifecycle-state, phase, and reason, sourced from the `work-items` data source (dashboard/site/dashboard.json diff shows the prior `work-inventory` block, -59 lines, being replaced). The PR body states this page "needed a GitHub Projects-style experience while keeping the global filter bar available for repository, owner, workflow name, and related filtering." The `work-items` row-building logic in `dashboard/report/dashboard-language-sources.mjs` only carried fields like `objective`, `organization`, `repository`, `scope`, `domain`, `work-type`, `lifecycle-state`, `phase`, `reason`, `verification-state`, `outcome-state`, and `observed-at` — it did not expose workflow identity (name/icon) or explicit run start/stop timestamps needed to render a runtime window.

## Decision

Replace the `work-inventory` table configuration in `dashboard/site/dashboard.json` with a `work-project-board` entry titled "Board / Tasks / Roadmap" that uses a new `work-project-view` dashboard element (registered in `dashboard/site/src/components/ui-elements.js`, implemented in the new 222-line `dashboard/site/src/components/work-project-view.js`). Extend the `work-items` data model in `dashboard/report/dashboard-language-sources.mjs` with `name`, `workflow`, `workflow-name`, `workflow-icon` (sourced from `workflow["package-icon"]` or defaulting to `"workflow"`), `started-at` (from `latestRun["started-at"]` or `workflow["observed-at"]`), and `ended-at` (from `latestRun["ended-at"]`, defaulting to empty string). Update the Dashboard Language schema/validation (`dashboard/site/src/specification.js`, `docs/dashboard-language-specification.md`) so the authoritative dashboard config accepts the new element type and fields, and add corresponding styles (`dashboard/site/src/styles.js`, +38 lines) and unit tests (`dashboard/site/test/unit/ui-elements.test.js`, `tests/unit/dashboard-language-sources.test.mjs`).

## Alternatives Considered

- **Keep the existing `table`-mark `work-inventory` element and add Board/Roadmap-style columns/styling on top of it.** Not chosen: the diff shows the prior table block was removed rather than extended, indicating the existing element's mark/encoding model was not reused for the new presentation.
- **Add workflow identity and runtime fields only as an internal computation for the new view without adding them to the shared `work-items` output schema.** Not chosen: the changes add `workflow-name`, `workflow-icon`, `started-at`, and `ended-at` directly onto the `work-items` row object in `dashboard-language-sources.mjs`, making them available to any consumer of that data source, not just the new element.

## Consequences

**Positive:**
- The Next Work page gains a Projects-inspired Board/Tasks/Roadmap presentation showing workflow name, icon/avatar, repository, owner, lifecycle state, and start/stop runtime window, per the PR body's stated goal.
- Workflow identity and runtime fields (`workflow-name`, `workflow-icon`, `started-at`, `ended-at`) are now part of the shared `work-items` schema, making them reusable by other dashboard elements or future views without re-deriving them.
- Schema/spec and documentation were updated alongside the code (`specification.js`, `docs/dashboard-language-specification.md`), and new unit tests were added for both the sources module and the UI element, indicating the change is validated at the data and rendering layers.

**Negative:**
- The prior `work-inventory` table element and its associated dashboard.json configuration (59 deleted lines) were removed, so any existing consumer or documentation reference relying specifically on `work-inventory`'s table encoding is no longer present.
- Not inferable from current pull request evidence: whether other dashboards or consumers depended on the removed `work-inventory` element, and whether backward compatibility for that element was considered.
- Not inferable from current pull request evidence: performance or scalability implications of rendering the new Board/Tasks/Roadmap views versus the previous table.
