# ADR 4111: Extract per-item work renderers into reusable domain-neutral subcomponents

## Status

Draft

## Context

The Dashboard Next Work view's `dashboard/site/src/components/work-project-view.js` (introduced by ADR 3532 and part of the broader restructuring covered by ADR 2572) embedded three page-shaped rendering slices inline: a `renderWorkCard` function, an inline task-row map callback inside `renderTasks`, and an inline roadmap-lane map callback inside `renderRoadmap`. This inline structure existed even though `dashboard/site/dashboard.json` already composes the view declaratively via `element: "work-project-view"` with `config.sections: ["board", "tasks", "roadmap"]` — the Dashboard Language contract for this view was already sufficient to express the composition, but the per-item rendering logic behind each section was not separated into its own reusable units. The PR body identifies this as a mismatch: page-shaped rendering code duplicated inside a single component file rather than factored into independently testable, reusable renderers.

## Decision

Extract the three inline per-item renderers out of `dashboard/site/src/components/work-project-view.js` into three new, domain-neutral modules: `dashboard/site/src/components/work-item-card.js` (`renderWorkItemCard(item)`, 39 lines, producing the same `article.work-card[data-work-state]` markup previously inlined as `renderWorkCard`), `dashboard/site/src/components/work-item-row.js` (`renderWorkItemRow(item)`, 36 lines, producing the same `article.work-task-row[role=listitem]` markup previously inlined in the `renderTasks` map callback), and `dashboard/site/src/components/work-item-timeline-lane.js` (`renderWorkItemTimelineLane(item, extents)`, 41 lines, producing the same `article.work-roadmap-lane` markup with computed `--work-start`/`--work-width` inline style previously inlined in the `renderRoadmap` map callback). `work-project-view.js` is modified (+8/-60 lines) to remove the inline definitions and instead import and call these three functions. No changes are made to `dashboard/site/dashboard.json`, `ui-elements.js` registration, or the Dashboard Language schema — the existing `config.sections`/`config.body` contract for the `work-project-view` element is preserved unchanged, since it was deemed already sufficient to represent this composition. New jsdom-based unit tests (`dashboard/site/test/unit/work-project-view.test.js`, 53 lines) import and exercise the three extracted renderers directly, independent of the full `work-project-view` page, asserting className, key attributes, and text-content parity with the pre-existing markup.

## Alternatives Considered

- **Leave the board/tasks/roadmap renderers inline within `work-project-view.js`.** Not chosen: this was the pre-existing state that the PR explicitly refactors away from, since it prevented the per-item renderers from being tested or reused independently of the full page component.
- **Change the Dashboard Language vocabulary or schema (e.g., `dashboard.json`'s `config.sections`/`config.body` contract) as part of this refactor.** Not chosen: the PR body states the existing declarative composition via `element: "work-project-view"` and `config.sections: ["board", "tasks", "roadmap"]` was "already sufficient" and explicitly leaves `dashboard.json`, `ui-elements.js` registration, and the schema unchanged, confining the change to internal module extraction.

## Consequences

**Positive:**
- The per-item board, task-row, and roadmap-lane renderers (`renderWorkItemCard`, `renderWorkItemRow`, `renderWorkItemTimelineLane`) are now standalone, domain-neutral modules that can be imported and tested independently of the full `work-project-view` page, as demonstrated by the new unit tests in `work-project-view.test.js`.
- Rendered markup and behavior are preserved: each extracted function is documented as producing the same classNames, attributes, and structure (`article.work-card[data-work-state]`, `article.work-task-row[role=listitem]`, `article.work-roadmap-lane` with computed `--work-start`/`--work-width` styles) as the code it replaces, and the PR reports passing typecheck, lint, unit tests, corpus validation, e2e tests, and the full `npm test` suite.
- The Dashboard Language composition contract (`dashboard.json`'s `element`/`config.sections`) is left untouched, avoiding any schema migration or re-validation burden for this change.

**Negative:**
- `work-project-view.js` now depends on three additional sibling modules for its rendering behavior, increasing the number of files that must be read together to understand the full view's rendering logic, versus having it in one file.
- Not inferable from current pull request evidence: whether these extracted renderer modules are intended for reuse by any other dashboard view or element beyond `work-project-view`.
- Not inferable from current pull request evidence: any performance implications of the extraction (e.g., additional module resolution/import overhead).
