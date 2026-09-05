# ADR 2912: Consolidate the Packages view's mode-tab-shell composition into a shared, reusable `packages-mode-shell` module exposed to Dashboard Language as the `package-activity-shell` element

## Status

Draft

## Context

The built-in Packages page previously kept its mode-tab composition in page-specialized JavaScript: `dashboard/site/src/components/packages-view.js` hard-coded the tab shell and section composition (all/review/live tabs, utilization cards, run trend, and summary table) around the built-in `packages` page, rather than letting Dashboard Language select a reusable page primitive.

`dashboard/site/dashboard.json` composed the Packages page from three separate views — `packages-utilization`, `packages-run-trend`, and `packages-summary`, using elements `package-utilization`, `package-run-trend`, and `package-summary-table` — instead of a single reusable composition.

This followed positive prior art from the three most recent closed workflow PRs, newest first: #2821 moved experiments composition into declarative slices, #2273 extracted reusable workflow-route body composition, and #1940 replaced workflow-page specialization with declarative route bodies.

## Decision

Refactor the Packages view composition to use a shared, reusable mode-shell primitive instead of page-specialized tab-shell logic:

- Add a new module `dashboard/site/src/components/packages-mode-shell.js` (`+82` lines, new file) exporting `renderPackagesModeShell({pageId, sections, defaultMode})`, which builds the mode tabs (all/review/live) via `renderInteractiveTabs`, manages `selectedMode` state from a URL param, and renders a list of `{id, render(mode)}` sections into a content panel; it also exports an `isPackageActivityMode` type guard.
- Reduce `renderPackagesView(sources, pageId)` in `dashboard/site/src/components/packages-view.js` (`+8/-51`) from roughly 50 lines of inline tab-shell/mode-selection logic to a thin call: `return renderPackagesModeShell({ pageId, sections: [utilization, run-trend, summary] })`, removing the local `MODES` constant and tab-nav imports (now used only inside `packages-mode-shell.js`).
- Register a new element renderer `package-activity-shell` in `dashboard/site/src/components/ui-elements.js` (`+27/-1`), mapped to `renderPackageActivityShellElement(context)`, which calls `renderPackagesModeShell` with the same three sections (utilization, run-trend, summary) driven by `context.sources`; add `'package-activity-shell'` to the `EMPTY_AWARE_ELEMENTS` set.
- Add `'package-activity-shell'` to `VIEW_ELEMENT_VALUES` in `dashboard/site/src/specification.js` (`+2/-0`), alongside the existing `'package-activity'`, `'package-utilization'`, `'package-run-trend'`, and `'package-summary-table'` values, without introducing new Dashboard Language vocabulary beyond this element name.
- Update `dashboard/site/dashboard.json` (`+5/-30`) so the `packages` page's views collapse the three separate views (`packages-utilization`, `packages-run-trend`, `packages-summary`) into a single view `packages-activity-shell`, using mark `element` and element `package-activity-shell`, sourcing `workflows`, `usage`, `runs`, `outcomes`, and `findings`.
- Add unit coverage: `dashboard/site/test/unit/ui-elements.test.js` (`+55` lines) adds a test that renders `package-activity-shell` via `renderUiElement` with synthetic sources and asserts presence of `.package-utilization-card`, `.package-chart-point`, `.package-summary-table`, and `.package-mode-tabs`; `dashboard/site/test/unit/validator.test.js` (`+21` lines) adds a test asserting the packages page's `definition.views` array now equals a packages-by-aic chart view plus the `packages-activity-shell` element view (element `package-activity-shell`, `data.sources` `['workflows','usage','runs','outcomes','findings']`), and that the document still validates ok.

The same `packages-mode-shell` module now drives both the legacy `renderPackagesView` entrypoint and the new `package-activity-shell` element, and package mode tabs, section order, accessibility semantics, and the existing utilization, trend, and summary content are preserved.

## Alternatives Considered

- **Keep the page-specialized tab-shell logic in `packages-view.js`**: Continue hard-coding the tab shell and section composition around the built-in `packages` page, and keep `dashboard.json` composing the Packages page from three separate views/elements (`packages-utilization`, `packages-run-trend`, `packages-summary`). This was the prior state and is implicitly rejected by the `-51`-line reduction in `packages-view.js` and the `+5/-30`-line collapse of `dashboard.json`'s packages views, though the PR evidence does not state explicit reasons beyond following the direction of prior ADRs #2821, #2273, and #1940.
- **Not inferable from current pull request evidence**: any alternative module boundaries, alternative element/vocabulary naming, or broader Dashboard Language changes were explicitly not pursued — the PR body states this change "follows that direction without repeating broader language changes or rejected scripting/template ideas," but does not describe what those rejected alternatives were.

## Consequences

**Positive:**

- The Packages page composition now follows the same declarative, reusable-primitive pattern already established by prior ADRs #2821 (experiments), #2273 (workflow-route), and #1940 (workflow-page route bodies), improving consistency across dashboard components.
- `packages-mode-shell.js` centralizes the mode-tab logic (all/review/live tabs, URL-param-driven `selectedMode` state, section rendering) so both the legacy `renderPackagesView` entrypoint and the new `package-activity-shell` element share one implementation instead of duplicating tab-shell logic.
- `dashboard.json`'s packages page composition is simplified from three separate views/elements to a single `packages-activity-shell` view using the `package-activity-shell` element, reducing net dashboard.json lines by 25 (`+5/-30`).
- No new Dashboard Language vocabulary or spec/validator contract change was needed beyond adding `package-activity-shell` to `VIEW_ELEMENT_VALUES`, per the PR body's statement that this "reused existing Dashboard Language `element` composition rather than introducing new vocabulary."
- New unit tests (`ui-elements.test.js`, `validator.test.js`) validate both the rendered output of the `package-activity-shell` element and the collapsed `dashboard.json` views definition, and the PR body reports a validation run covering typecheck, lint, test, validate:corpus, test:e2e, and npm test.
- Package mode tabs, section order, accessibility semantics, and existing utilization, trend, and summary content are preserved per the PR description.

**Negative:**

- The composition is now spread across more files (`packages-view.js`, `packages-mode-shell.js`, `ui-elements.js`, `specification.js`, `dashboard.json`), which the evidence does not indicate was evaluated for added indirection or navigation cost.
- `dashboard/site/src/specification.js`'s diff also re-exports `EXPERIMENTS_VIEW_BODY_VALUES` as an unrelated pre-existing export addition bundled into this change; whether this bundling was intentional is Not inferable from current pull request evidence.
- Any migration or compatibility considerations for other configurations of `dashboard.json` beyond the Packages page are Not inferable from current pull request evidence.
