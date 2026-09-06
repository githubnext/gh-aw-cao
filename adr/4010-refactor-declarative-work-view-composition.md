# ADR 4010: Refactor work-project-view to declarative Dashboard Language composition

## Status

Draft

## Context

`dashboard/site/src/components/work-project-view.js` previously hard-coded the `Board`, `Tasks`, and `Roadmap` sections inside a single renderer, including page-local fragment/anchor IDs. This made the Work page's structure a special case in JavaScript, inconsistent with the existing declarative route and experiments elements in the Dashboard Language, which compose their structure from configuration rather than embedding it in renderer code.

`dashboard/site/dashboard.json` referenced this renderer once for the Work page with no declarative composition, so the page's structure (which slices appear and in what order) was not visible or configurable through the Dashboard Language surface.

Prior work established relevant precedent: PR #3679 reinforced declarative composition/validation rules for Dashboard Language views. PR #3620 added an `agent-marketplace-view` custom renderer that remained page-specialized, and was noted as a weaker candidate for this kind of refactor. PR #3649 was unrelated workflow-policy work.

## Decision

Refactor `work-project-view` so that the Work page's `Board`, `Tasks`, and `Roadmap` slices are composed declaratively via `config.body` or `config.sections` in the Dashboard Language, rather than hard-coded inside the renderer.

This was implemented by:
- Extracting reusable composition primitives into new modules: `work-view-primitives.js`, `work-view-sections.js`, and `work-view-composition.js` under `dashboard/site/src/components/`.
- Updating `work-project-view.js` to render slices from `config.body` or `config.sections` instead of a fixed internal layout.
- Updating `dashboard.json` so the Work page explicitly composes `board`, `tasks`, and `roadmap`.
- Extending `validator.js` and `specification.js` (and the normative spec in `docs/dashboard-language-specification.md`) with the smallest vocabulary needed to validate `work-project-view` configuration.
- Updating `route-body-specification.js` to accommodate the new configuration shape.

Rendered behavior, navigation affordances, empty states, and work-item presentation over `work-items` are preserved unchanged; only the composition mechanism changes from imperative/hard-coded to declarative.

## Alternatives Considered

- **Refactor `agent-marketplace-view` (from PR #3620) instead.** This renderer remained page-specialized after #3620 and was identified in the PR body as a weaker candidate for this refactor, so it was not selected.
- **Leave `work-project-view` as a hard-coded, page-specific renderer.** This was the prior state; it was rejected because it was inconsistent with the declarative pattern already used by other route and experiments elements in the Dashboard Language, and it did not expose a reusable composition boundary for additional existing or fixture-based compositions.

## Consequences

### Positive

- The Work page's structure (`board`, `tasks`, `roadmap`) is now expressed declaratively in `dashboard.json` via `config.body`/`config.sections`, consistent with other declarative Dashboard Language elements.
- Reusable composition primitives (`work-view-primitives.js`, `work-view-sections.js`, `work-view-composition.js`) are now available under `dashboard/site/src/components/` for additional existing or fixture-based compositions.
- Validator and specification support for `work-project-view` configuration was extended, with added positive and negative validator test cases and unit coverage for full-page and single-slice (`config.body`) composition.
- Rendered behavior, navigation affordances, empty states, and work-item presentation are preserved unchanged, as confirmed by retained e2e coverage (`dashboard/site/test/e2e/smoke.spec.js`) and passing typecheck, lint, unit tests, `validate:corpus`, and `test:e2e`.

### Negative

- Not inferable from current pull request evidence: no performance, migration cost, or long-term maintenance trade-offs are described in the PR body or diff summary.
- Not inferable from current pull request evidence: no discussion of whether other page-specialized renderers (e.g., `agent-marketplace-view`) will be refactored similarly, or of a broader rollout plan.
