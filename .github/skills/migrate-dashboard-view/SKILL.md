---
name: migrate-dashboard-view
description: 'Migrate a CAO dashboard view from published or derived logical-source files to the unified canonical data model. Use when redoing, converting, or moving a dashboard view to the view -> data query -> Web Worker -> view payload architecture.'
argument-hint: 'Dashboard page or view id to migrate'
---

# Migrate Dashboard View

Migrate one view at a time to a request-scoped declarative query while preserving the source-shaped payload expected by the renderer.

## Procedure

1. Locate the view in `dashboard/site/dashboard.json`. Record its page id, view id, `data.source`, filters, ordering, route fields, and every field consumed by its encoding or UI element.
2. Trace that source only far enough to identify its current producer (a JavaScript projection, a legacy logical source, or an existing declarative query) and the canonical entities needed to replace it. Prefer indexed reads from `dashboard/site/src/data/queries/index.js`; add an index-backed query there when the required access pattern is missing.
3. Define the smallest `from`/`filter`/`compute`/`aggregate`/`select`/`order-by` query under `dashboard.queries` in `dashboard/site/dashboard.json` (or the relevant campaign manifest) that converts canonical entities into the fields the view's encoding or UI element consumes. Bind the view's `data.source` to that query's `name`. Do not add a JavaScript projection module; every clause must compile to the serializable row operators executed by `dashboard/site/src/data/queries/declarative.js`.
4. Make the query request-scoped. A view request must execute only its required declarative query and return only the requested payload. Do not materialize every collection or send unrelated metadata shells.
5. The request is routed through `dashboard/site/src/data-processor.js` and `dashboard/site/src/data-worker.js`, which resolve declared queries via `dashboard/site/src/data/queries/database.js` and `declarative.js`. Keep canonical records and IndexedDB access inside the worker; send serializable query inputs in and source-shaped payloads out. Do not add a presenter callback, a derived source module, or main-thread row processing to satisfy this step.
6. Do not rewrite unrelated views, generated data, or published source producers in the same migration. Remove a superseded JavaScript source derivation only when it is owned solely by the migrated view; do not add a compatibility fallback for it.
7. Add a focused unit test under `dashboard/site/test/unit/` for query selection and payload shape. Add or extend a Playwright test under `dashboard/site/test/e2e/` to exercise the real module worker, IndexedDB generation, and initial plus navigated page requests.
8. Run the focused unit test, focused Playwright spec, `npm run typecheck`, and `npm run lint` from `dashboard/site/`. Run `npm run validate:corpus` when `dashboard/site/dashboard.json` changes. Report any broader validation not run.

## Completion Contract

- The migrated view renders from a declarative query over canonical entities, not JavaScript-shaped or precomputed source rows.
- The worker executes the declarative query and returns only the requested view payload.
- Existing renderer behavior and unmigrated views remain compatible.
- Unit and browser tests prove the end-to-end path.
