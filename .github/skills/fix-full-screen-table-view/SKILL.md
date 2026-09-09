---
name: fix-full-screen-table-view
description: 'Interactively convert or repair a CAO dashboard view as a responsive full-screen table. Use when a table should fill the viewport, own scrolling, hide secondary chrome, remain usable on mobile, or when layout: full-view is clipped or collapses.'
argument-hint: 'Dashboard page or table view id'
---

# Fix Full-Screen Table View

Make one dashboard table a focused viewport-filling work surface, verify it in a real browser, and preserve behavior at desktop and mobile widths.

## Procedure

1. Locate the page and view in `dashboard/site/dashboard.json`. Confirm the target is one essential table view; full-view pages should not mix unrelated essential views or wrap the table in a layout section.
2. Set the table view to `layout: "full-view"`. Preserve its source, fields, filters, ordering, controls, empty state, and links. If its source still depends on precomputed data, use `../migrate-dashboard-view/SKILL.md` first.
3. Trace the existing full-view behavior in `dashboard/site/src/presenter.js` and `dashboard/site/src/styles.js`. Reuse `.dashboard-full-view` and `[data-view-layout="full-view"]`; do not add page-specific positioning when the shared shell can express the behavior.
4. Add a unit assertion for the target view's `full-view` declaration. Extend the real dashboard smoke flow to navigate into the page and assert that `.dashboard-root` gains `dashboard-full-view` and the target view is visible.
5. Run the focused unit test before changing shared CSS. If it passes, inspect the real site interactively with fixture data at `?fixtures#page-<page-id>`.
6. At desktop width, verify:
   - document height equals viewport height;
   - the view and `.table-scroll` consume the remaining app height;
   - `main.dashboard-prototype` does not own scrolling;
   - secondary view headings, descriptions, and footer are hidden;
   - table filtering, sorting, links, and internal scrolling remain operable.
7. At 390 x 844, verify:
   - the full-view root uses the dynamic viewport height and does not document-scroll;
   - the mobile sidebar and top navigation keep only their intrinsic height;
   - the app main, page, view, and table form an unbroken `min-height: 0` height chain;
   - `.table-filter` wraps within its client width;
   - only `.table-scroll` may scroll horizontally for the table's minimum width.
8. If responsive CSS is required, scope it to `.dashboard-full-view`. Preserve normal mobile pages. Prefer `100dvh` for the root, a grid row of `auto minmax(0, 1fr)` for stacked mobile chrome, and `min-height: 0` on flex/grid descendants.
9. Capture desktop and mobile screenshots and inspect them for clipped controls, overlapping text, outer scrollbars, and empty unused panels. Exercise the table-scroll event with enough rows to confirm the compact scrolled state hides the sidebar and top navigation.
10. Extend the shared `JSON full-view mode fills the viewport and hides chrome while scrolling` Playwright test for reusable behavior. Run that test, the target route smoke test, `npm run typecheck`, and `npm run lint` from `dashboard/site/`.

## Completion Contract

- The target is a real full-screen table, not merely a full-width table.
- Outer document dimensions stay within the viewport on desktop and mobile.
- Filtering stays contained; wide table columns scroll inside `.table-scroll`.
- Navigation into and out of the view works, including its breadcrumb.
- A real-route test protects the target and a synthetic test protects shared behavior.