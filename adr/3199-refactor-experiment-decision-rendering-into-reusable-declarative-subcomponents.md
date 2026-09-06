# ADR 3199: Refactor experiment decision rendering into reusable declarative subcomponents

## Status

Draft

## Context

`dashboard/site/dashboard.json` already declares three separate `experiments-evaluation` compositions (`body: overview`, `body: table`, and `sections: [detail]`), representing the summary, table, and detail slices declaratively through the Dashboard Language. However, `dashboard/site/src/components/experiments-evaluation.js` still contained page-shaped rendering logic for all three slices inline, along with private helpers (`renderExperimentSectionHeading`, `renderExperimentEffect`, `decisionTone`, `formatExperimentDate`, `sourceMetricLabel`, `metricSummaries`) that were duplicated or redefined in `experiment-detail-sections.js`. This meant the declarative Dashboard Language contract was not mapped 1:1 to component boundaries — the JSON already treated the three slices as separate compositions, but the JavaScript module kept them coupled in a single file with unshared logic.

This was the last renderer view in the dashboard still exhibiting this composition/rendering mismatch. Other in-tree renderers (`workflow-route`, `workflow-route-page`, `package-route`, `outcome-detail-section`) had already been split into reusable composition separate from page wiring, establishing a precedent pattern. There is also structural precedent in ADR 2821 (`experiments-dashboard-config-body-slices.md`), which addressed a prior body-slices decision for this same `experiments-evaluation` dashboard element.

## Decision

Extract the three `experiments-evaluation` slices (summary, table, detail) into standalone reusable subcomponents — `experiment-summary-view.js`, `experiment-table-view.js`, and `experiment-detail-view.js` — plus a shared `experiment-view-primitives.js` module hosting the common effect, heading, metric-summary, and date-formatting helpers. `experiments-evaluation.js` is updated to compose these subcomponents via `renderExperimentsViewShell` instead of hosting page-shaped logic inline, and `experiment-detail-sections.js` is updated to import the shared primitives rather than defining local duplicates. No changes were made to `dashboard.json` or the Dashboard Language validator, since the existing `experiments-evaluation` vocabulary already represented the three-slice composition declaratively; only the component boundaries were realigned to match it.

## Alternatives Considered

- **Leave rendering logic inline in `experiments-evaluation.js`.** This preserves the existing working code but perpetuates the mismatch between the declarative three-slice Dashboard Language composition and the single-module implementation, and leaves helper duplication between `experiments-evaluation.js` and `experiment-detail-sections.js` unresolved.
- **Extract slices without a shared primitives module** (i.e., duplicate the effect/heading/date helpers into each new per-slice file). This would achieve component-boundary separation but would reintroduce the duplication this refactor sought to eliminate, as the same helpers were already duplicated between `experiment-detail-sections.js` and `experiments-evaluation.js` before this change.

## Consequences

**Positive:**
- Dashboard Language composition in `dashboard.json` is now mapped 1:1 to component boundaries in the JavaScript, following the pattern already established by `workflow-route`, `workflow-route-page`, `package-route`, and `outcome-detail-section`.
- Shared formatting and rendering helpers (heading, effect, decision tone, date formatting, metric summaries) are centralized in `experiment-view-primitives.js`, removing duplication between `experiment-detail-sections.js` and `experiments-evaluation.js`.
- `experiments-evaluation.js` is substantially reduced (+6/-243 lines), narrowing its responsibility to composition via `renderExperimentsViewShell` rather than page-shaped rendering.
- Routes, semantics, and the declarative JSON contract are unchanged; validation (typecheck, lint, test, validate:corpus, test:e2e) passed against the existing behavior.

**Negative:**
- Introduces four new files (`experiment-summary-view.js`, `experiment-table-view.js`, `experiment-detail-view.js`, `experiment-view-primitives.js`), increasing the number of modules a developer must navigate to understand the full experiments-evaluation rendering behavior.
- Not inferable from current pull request evidence: any performance impact, bundle-size effect, or additional maintenance burden from the increased file count.
