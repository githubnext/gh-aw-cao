# ADR 3648: Refactor workflow route page composition

## Status

Draft

## Context

Within `dashboard/site/src`, the workflow route family (`workflow-route-shell.js`, `workflow-route-page.js`, `workflow-route-composition.js`, `workflow-route-page-views.js`) rendered its body selection declaratively, but tab destinations were still encoded in JavaScript around built-in page identities. Specifically, `workflowTabs(...)` in `workflow-route-shell.js` hard-coded hrefs such as `#page-workflow-runtime...`, tying the renderer to built-in page IDs rather than a reusable declarative mapping.

A review of `dashboard/site/src` for page-identity branching found that the `package-route` and `experiments-route` components were already more fully declarative, and the current merged route-composition approach in `package-route` and `experiments-evaluation` was used as positive prior art for this change.

No existing ADR was found in `adr/*.md` referencing PR 3648 or this workflow-route-page-config change. The prior ADR `adr/2821-experiments-dashboard-config-body-slices.md` covers a different but architecturally analogous refactor (experiments-evaluation declarative `config.body` slices) and was used only as a stylistic template for section structure, not as a source of facts for this PR.

## Decision

Extract a reusable, domain-neutral workflow route page config primitive so that both route composition and tab navigation resolve from declarative page/body mappings, while preserving the rendered workflow runtime, reports, and runs behavior.

Concretely:

- Add `dashboard/site/src/components/workflow-route-page-config.js`, defining a `WORKFLOW_ROUTE_PAGE_CONFIGS` map (`workflow-runtime`->`insights`, `workflow-detail`->`reports`, `workflow-runs`->`runs`) and a reverse map `WORKFLOW_ROUTE_PAGE_ID_BY_BODY`, exporting `workflowRoutePageConfig(pageId)` and `workflowRoutePageConfigForBody(body)`, both using `selectNamedComposition` with `'workflow-detail'` as the default fallback.
- Update `workflow-route-composition.js` to import `workflowRoutePageConfig`, add a `pageId` field to each `WORKFLOW_ROUTE_BODY_COMPOSITIONS` entry (workflow-runtime/insights, workflow-detail/reports, workflow-runs/runs), and add an exported `workflowRouteCompositionForPage(pageId)` that resolves composition via `workflowRoutePageConfig(pageId).body`.
- Update `workflow-route-page.js` so `renderWorkflowRoutePage` calls `renderWorkflowRouteShell` (previously `renderWorkflowRouteView`), with composition resolved via `workflowRouteComposition(context.elementConfig.body)` when a body is given, otherwise via `workflowRouteCompositionForPage(context.pageId)`.
- Update `workflow-route-shell.js` so `workflowTabs(...)` no longer hard-codes hrefs, delegating instead to a new helper `workflowTab(pageId, label, icon, workflowQuery)` that builds the href from `workflowRoutePageConfigForBody(pageId).pageId`.
- Update `workflow-route-page-views.js` so `createWorkflowRoutePageView` emits `element: 'workflow-route-page'` (previously `'workflow-route'`), and resolves `config.body` via `workflowRoutePageConfigForBody(options.body).body` instead of using `options.body` directly.
- Update `dashboard/aw.yml` to package the new `workflow-route-page-config.js` runtime file.
- Add focused unit coverage: `validator.test.js` gains a test ("accepts workflow-route-page on multiple pages without page-specific JavaScript routing") validating two pages (`workflow-runtime`, `workflow-runs`) each using `element: workflow-route-page` with different `config.body` values; `workflow-runtime.test.js` is updated to expect `element: 'workflow-route-page'` and adds a test verifying `workflowRouteCompositionForPage` maps `workflow-runtime`->`insights`, `workflow-detail`->`reports`, `workflow-runs`->`runs`, with unknown page id `custom-workflow-page` falling back to `reports` (the default).

Validation passed: typecheck, lint, test, `validate:corpus`, and `test:e2e` (dashboard/site).

## Alternatives Considered

- **Leave `workflowTabs(...)` hard-coding page destination hrefs in `workflow-route-shell.js`**: This was the prior state and was rejected because it tied the renderer to built-in page IDs instead of a reusable declarative mapping, even though body selection was already declarative elsewhere in the route family.
- **Model each workflow route page as its own page-specific wrapper** (the prior approach in `workflow-route-page.js`, where composition resolution was page-specific rather than mapping-driven): This was replaced by resolving composition from the shared declarative mapping (`workflowRouteCompositionForPage`), following the precedent already established by the more fully declarative `package-route` and `experiments-route`/`experiments-evaluation` components.

## Consequences

**Positive:**

- Tab navigation and page composition for the workflow route family now resolve from a single declarative page/body mapping (`workflow-route-page-config.js`) instead of scattered page-identity branching in JavaScript.
- The mapping primitive is described as reusable and domain-neutral, aligning the workflow route family's structure with the already-declarative `package-route` and `experiments-route` components.
- Unit coverage was added for the page-to-body mapping contract and for validator acceptance of the same `workflow-route-page` element reused across multiple pages (`workflow-runtime`, `workflow-runs`) with different `config.body` values, and for the fallback behavior of unknown page IDs.
- Full validation (typecheck, lint, test, `validate:corpus`, `test:e2e` for dashboard/site) passed for the change.

**Negative:**

- `createWorkflowRoutePageView`'s emitted element name changed from `'workflow-route'` to `'workflow-route-page'`, and `renderWorkflowRoutePage` now calls `renderWorkflowRouteShell` instead of `renderWorkflowRouteView`, which required corresponding test updates in `workflow-runtime.test.js`.
- Unknown page identities silently fall back to the `'workflow-detail'`/`reports` default via `selectNamedComposition`, as confirmed by the `custom-workflow-page`->reports fallback test, rather than surfacing as an explicit error.
- Not inferable from current pull request evidence: any performance impact, migration cost for other route families, or broader stakeholder rationale beyond the stated candidate-selection review.
