---
argument-hint: Dashboard page or view id to migrate
description: Migrate a CAO dashboard view from published or derived logical-source files to the unified canonical data model. Use when redoing, converting, or moving a dashboard view to the view -> declarative query -> Web Worker -> view payload architecture.
metadata:
    local-path: /home/runner/work/gh-aw-cao/gh-aw-cao/.github/skills/migrate-dashboard-view
name: migrate-dashboard-view
---
# Migrate Dashboard View

Migrate one view at a time to a request-scoped declarative query while preserving the payload shape expected by the renderer. The dashboard has no JavaScript view-source projection layer: every source is a JSON query object executed by the data Web Worker's query engine.

## Procedure

1. Locate the view in `dashboard/site/dashboard.json` or its declared fragment under `dashboard/site/dashboard-fragments/`. Record its page id, view id, `data.source`, filters, ordering, route fields, and every field consumed by its encoding or UI element.
2. Trace that source only far enough to identify the canonical entities needed to replace it. Prefer indexed reads exposed by `dashboard/site/src/data/queries/index.js` (`createCanonicalQueries`); add an index-backed read there when the required access pattern is missing.
3. Define the complete transformation as a `DashboardQuery` object under the `queries` array in the same root or fragment JSON document that owns the view (see the query shape documented in `dashboard/site/src/data/queries/declarative.js`). Express every join, filter, computed field, aggregate, prediction, and ordering step declaratively; do not add a JavaScript projection or callback.
4. Bind the view's `data.source` to the new query's `name` (or an alias produced by `dashboardViewAliasName` in `dashboard/site/src/data/queries/view-payload-compiler.js`). A view request must execute only its required declarative queries and return only requested source payloads; do not materialize every collection or send unrelated metadata shells.
5. The request already routes through `dashboard/site/src/data-processor.js` and `dashboard/site/src/data-worker.js`, which call `executeDashboardQueries` from `dashboard/site/src/data/queries/declarative.js`. Keep canonical records and IndexedDB access inside the worker; send serializable query inputs in and source-shaped payloads out. Do not add a compatibility JavaScript fallback for views not yet migrated.
6. Do not rewrite unrelated views, generated data, or published source producers in the same migration.
7. Add a focused unit test under `dashboard/site/test/unit/` for query selection and payload shape. Add or extend a Playwright test under `dashboard/site/test/e2e/` to exercise the real module worker, IndexedDB generation, and initial plus navigated page requests.
8. Run the focused unit test, focused Playwright spec, `npm run validate:corpus`, `npm run typecheck`, and `npm run lint` from `dashboard/site/`. Report any broader validation not run.

## Completion Contract

- The migrated view renders from a declarative JSON query over canonical entities, not a JavaScript-shaped source.
- The worker's query engine performs the query and returns only the requested view payload.
- Existing renderer behavior and unmigrated views remain compatible.
- Unit and browser tests prove the end-to-end path.
