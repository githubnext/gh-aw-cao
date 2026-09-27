---
argument-hint: Dashboard page or view id to migrate
description: Migrate a CAO dashboard view from published or derived logical-source files to the unified canonical data model. Use when redoing, converting, or moving a dashboard view to the view -> data query -> Web Worker -> view payload architecture.
metadata:
    local-path: /home/runner/work/gh-aw-cao/gh-aw-cao/.github/skills/migrate-dashboard-view
name: migrate-dashboard-view
---
# Migrate Dashboard View

Migrate one view at a time to a request-scoped canonical query while preserving the source-shaped payload expected by the renderer.

## Procedure

1. Locate the view in `dashboard/site/dashboard.json`. Record its page id, view id, `data.source`, filters, ordering, route fields, and every field consumed by its encoding or UI element.
2. Trace that source only far enough to identify its current producer and the canonical entities needed to replace it. Prefer an existing query in `dashboard/site/src/data/queries/database.json` (canonical entities) or `dashboard/site/src/data/queries/ingestion.json` (ingestion-scoped sources); add an index-backed query there when the required access pattern is missing.
3. Add the smallest declarative query definition — `stores`, `from`, `compute`, `select`, filters, joins, and ordering — to `database.json` or `ingestion.json` that converts canonical records into the existing renderer payload. Preserve field names and metadata semantics at the renderer boundary. Query definitions are pure JSON executed by `dashboard/site/src/data/queries/declarative.js` (`dashboardQueryIndex`, `resolveDashboardQuerySources`, `executeDashboardQueries`); do not add a JavaScript projection or shaping function.
4. Make the query request-scoped. A view request must execute only its required canonical reads and return only requested source payloads. Do not materialize every collection or send unrelated metadata shells.
5. Route the request through `dashboard/site/src/data-processor.js` and `dashboard/site/src/data-worker.js`. Keep canonical records and IndexedDB access inside the worker; send serializable query inputs in and source-shaped payloads out.
6. Preserve legacy derivations as compatibility fallbacks for views not yet migrated. Do not rewrite unrelated views, generated data, or published source producers in the same migration.
7. Add a focused unit test under `dashboard/site/test/unit/` for query selection and payload shape. Add or extend a Playwright test under `dashboard/site/test/e2e/` to exercise the real module worker, IndexedDB generation, and initial plus navigated page requests.
8. Run the focused unit test, focused Playwright spec, `npm run typecheck`, and `npm run lint` from `dashboard/site/`. Report any broader validation not run.

## Completion Contract

- The migrated view renders from canonical entities, not its precomputed source rows.
- The worker performs the query and returns only the requested view payload.
- Existing renderer behavior and unmigrated views remain compatible.
- Unit and browser tests prove the end-to-end path.
