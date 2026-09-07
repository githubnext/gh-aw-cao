# ADR 4785: Mobile-first tap-based interactions for the Work dashboard view

## Status

Draft

## Date

2026-09-07

## Context

The Work dashboard view (originally established in `adr/3532-work-project-view-dashboard-element.md`) renders delegated work items in three layouts — Board, Table (formerly "Tasks"), and Roadmap — implemented in `dashboard/site/src/components/work-project-view.js`. On mobile viewports, these layouts previously relied on desktop interaction patterns: a four-column CSS grid for the Board (`.work-board { grid-template-columns: repeat(4, minmax(220px, 1fr)); }`), a horizontally scrollable filter bar and roadmap timeline, and a dense multi-column task table — all requiring horizontal scrolling or cramped touch targets on small screens.

PR #4785 (fixing #4784) redesigns these three views for phone-first use. The diff to `work-project-view.js` (~470 changed lines) introduces:

- A `renderBoard` status-tab control (`work-board-group-tabs`, `role="tablist"`) that shows one board column at a time via `data-mobile-active`, replacing the four-column simultaneous layout.
- A `decorateMobileWorkItem` function that appends a "Move to…" `<select>` and a "Details" button to each Board card, Table row, and Roadmap lane, wiring a `<dialog className="work-mobile-detail">` full-screen detail view with quick-update `<select>` controls for owner and label.
- A `renderWorkFilterBar` change from returning a plain element to returning `{ element, apply }`, with a new mobile filter toggle button and `work-filter-facets` sheet (bottom-sheet pattern using `position: fixed; inset: 0` and `.is-open`).
- A `reapplyFilters` closure in `renderWorkProjectView` that is set to `filterBar.apply` and passed into each renderer's `onUpdate` callback, so a quick-update (e.g., changing an item's state via the mobile dialog) re-runs the active filter instead of just re-rendering all items — validated by the new test "reapplies active filters after a mobile quick update".
- A Roadmap `visualToggle` that switches between a period-grouped, list-style mobile timeline (default, per the new test "defaults Roadmap to a period-grouped mobile timeline") and an explicit horizontally-scrollable "Visual" timeline, plus month-stepping `previousPeriod`/`nextPeriod` controls.
- A Table "Fields & sort" bottom-sheet (`work-task-settings-sheet`) replacing the inline sort controls, letting users toggle visible fields (repository, status, owner, label, dates) via checkboxes that add/remove `work-mobile-hide-*` classes.

`dashboard/site/src/styles.js` adds a mobile media-query block that removes prior overflow-based patterns (e.g., `.work-task-scroll { max-height: none; overflow: visible; }`, `.work-roadmap-scroll { max-height: none; overflow: visible; }`, `.work-board { overflow: visible; }`) and converts the Board, Table, and Roadmap layouts to single-column, non-scrolling stacks, explicitly hiding desktop-only elements (`.work-filter-mobile-toggle, .work-mobile-sheet-header, ... { display: none; }` outside the mobile breakpoint).

Test coverage was added/updated in `test/unit/work-project-view.test.js`, `test/unit/ui-elements.test.js`, `test/unit/view-transitions.test.js`, and `test/e2e/smoke.spec.js` to cover the tab-based board, tap-to-open detail dialog, filter reapplication, and roadmap period/visual toggling.

## Decision

Redesign the mobile Work view around four coordinated patterns, implemented directly in the existing `work-project-view.js` component (no new component files or libraries introduced):

1. **Status-tab navigation for Board** — collapse the four simultaneous columns into a single visible column selected via `role="tablist"` tabs, keyed off `data-mobile-active`.
2. **Bottom-sheet controls for filters and table settings** — mobile filter facets and table field/sort settings are moved into fixed-position, bottom-anchored sheets (`.work-filter-facets`/`.work-task-settings-sheet` with `.is-open`) opened via toggle buttons, rather than always-visible inline controls.
3. **Full-screen detail view with tap-based quick updates** — each Board card, Table row, and Roadmap lane gains a "Details" button opening a full-screen native `<dialog>` (`work-mobile-detail`), and a "Move to…" `<select>` for direct state changes, with updates re-running (`reapplyFilters`/`onUpdate`) the currently active filter set so the list stays consistent after a tap-based edit.
4. **Scroll containment** — mobile CSS replaces `overflow: auto`/fixed-height scroll containers on Board, Table, and Roadmap with `overflow: visible` single-column stacks, and the Roadmap's horizontally-scrollable calendar becomes an opt-in "Visual" mode behind a toggle, with a period-grouped list as the mobile default.

## Alternatives Considered

- **Keep the existing scrollable multi-column layouts and only adjust CSS sizing (responsive shrink)**: Not chosen — the diff replaces the grid/scroll containers themselves (e.g., `work-board` grid-template-columns removed, `work-task-scroll`/`work-roadmap-scroll` overflow reset to `visible`) rather than merely resizing them, indicating the team rejected a purely cosmetic responsive approach in favor of structural changes to eliminate horizontal/nested scrolling.
- **Inline mobile controls instead of bottom sheets/full-screen dialogs**: Not chosen — filter facets, table field settings, and item details are each moved into `position: fixed` sheet/dialog overlays (`work-filter-facets`, `work-task-settings-sheet`, `work-mobile-detail` dialog) rather than being rendered inline on the card/row, indicating a deliberate choice to conserve limited mobile screen space by deferring secondary controls to on-demand overlays.

## Consequences

**Positive:**
- Eliminates horizontal and nested scrolling on mobile for Board, Table, and Roadmap, per the styles.js changes converting scroll containers to `overflow: visible` single-column layouts.
- Enables direct, tap-based state changes (move item, edit owner/label) from any of the three views without navigating to a separate edit screen, via `decorateMobileWorkItem`'s move `<select>` and quick-update controls in the detail dialog.
- Filter state is preserved across quick updates (`reapplyFilters`), avoiding the stale/inconsistent list contents that would otherwise occur after an in-place edit under an active filter.
- Roadmap mobile default (period-grouped list) avoids the wide horizontally-scrolled calendar grid by default, while still allowing users to opt into the visual timeline.

**Negative:**
- `work-project-view.js` grows substantially in complexity (renderers now take an additional `onUpdate` parameter; `decorateMobileWorkItem` is a new cross-cutting function invoked from Board, Table, and Roadmap renderers), increasing the surface area that must be kept in sync across the three view types.
- The Board mobile view now shows only one status column at a time (`data-mobile-active`), meaning cross-column comparisons that were previously possible via horizontal scroll require switching tabs instead.
- Additional DOM elements per item (native `<dialog>`, move `<select>`, footer actions) increase per-row markup size across all three views on mobile.
- Not inferable from current pull request evidence: any performance measurements, accessibility audit results, or user research that motivated the specific choice of native `<dialog>` for full-screen details versus other overlay techniques.
