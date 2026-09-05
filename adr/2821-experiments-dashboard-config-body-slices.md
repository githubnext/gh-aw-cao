# ADR 2821: Compose the experiments dashboard view through a declarative config.body slice vocabulary (overview/table/detail) on experiments-evaluation

## Status

Draft

## Context

The `experiments-evaluation` component (`dashboard/site/src/components/experiments-evaluation.js`) previously combined filter state, readiness overview, decision-table ranking, and detail composition in a single page-specialized renderer. This differed from existing route/body composition primitives already used elsewhere in the dashboard, such as `workflow-route` and `package-route`, which compose pages declaratively rather than through one monolithic renderer.

`dashboard/site/dashboard.json` needed to compose the built-in Experiments page from multiple distinct views (overview, table, detail) while preserving existing experiment behavior, accessibility semantics, filtering, deep linking, and evidence presentation (comparison, eval outcomes, grader diagnostics, observation quality, run evidence).

## Decision

Refactor the experiments dashboard composition to use reusable declarative slices instead of a single page-specific renderer:

- Add support in `experiments-evaluation` for a `config.body` vocabulary with values `overview`, `table`, and `detail`, mirroring the shared route/body-style value handling already used for other components.
- Extract `experiments-view-shell` (`+443` lines, new file) and `experiments-view-composition` (`+25` lines, new file) so the experiments renderer can declaratively select which slice to render.
- Reduce `experiments-evaluation.js` from a combined renderer to a thin dispatcher (`+27/-331` lines) that delegates to the extracted shell/composition modules based on `config.body`.
- Update `dashboard/site/dashboard.json` (`+47` lines) to compose the Experiments page from three separate `experiments-evaluation` element views, each configured with a different `config.body` value (`overview`, `table`, `detail`).
- Register the new `config.body` values in `route-body-specification.js` and validate them in `dashboard/site/src/validator.js` (`+6/-3`) using the existing shared route/body-style value handling.
- Document the normative `config.body` contract for `experiments-evaluation` in `docs/dashboard-language-specification.md` (`+2/-2`).
- Add unit coverage for valid/invalid `experiments-evaluation` `config.body` values (`validator.test.js`, `+46` lines) and for declarative `overview`/`table` slice rendering (`experiments-evaluation.test.js`, `+54` lines).

## Alternatives Considered

- **Keep the single page-specialized renderer**: Continue combining filter state, overview, table ranking, and detail composition in one renderer as `experiments-evaluation.js` did previously. This was the prior state and is implicitly rejected by the `-331` line reduction and extraction of shell/composition modules, though the PR evidence does not state explicit reasons beyond inconsistency with existing route/body composition primitives (`workflow-route`, `package-route`).
- **Not inferable from current pull request evidence**: any alternative approaches beyond continuing the monolithic renderer (e.g., alternative slice naming, alternative module boundaries) are not discussed in the PR body.

## Consequences

**Positive:**

- `experiments-evaluation` now follows the same declarative route/body composition pattern already established by `workflow-route` and `package-route`, improving consistency across dashboard components.
- `dashboard.json` can compose the Experiments page from independently configured `overview`, `table`, and `detail` views rather than relying on one renderer's internal logic.
- Logic for readiness overview, decision table, and detail rendering is now reusable and separated into `experiments-view-shell` and `experiments-view-composition`, reducing the size and complexity of `experiments-evaluation.js` (from handling all concerns to a `+27/-331` line dispatcher).
- New unit tests validate both the `config.body` vocabulary (valid/invalid values) and the declarative rendering of `overview`/`table` slices, and the normative contract is documented in `docs/dashboard-language-specification.md`.
- Existing experiment behavior, accessibility semantics, filtering, deep linking, and evidence presentation (comparison, eval outcomes, grader diagnostics, observation quality, run evidence) are preserved per the PR description.

**Negative:**

- The composition is now spread across more files (`experiments-evaluation.js`, `experiments-view-shell.js`, `experiments-view-composition.js`, `dashboard.json`, `route-body-specification.js`, `validator.js`), which the evidence does not indicate was evaluated for added indirection or navigation cost.
- `experiments-view-shell.js` is a large new file (+443 lines), concentrating significant logic in a single new module; whether this file itself should be further decomposed is Not inferable from current pull request evidence.
- Any migration or compatibility considerations for other configurations of `dashboard.json` beyond the Experiments page are Not inferable from current pull request evidence.
