# ADR 4786: Lazily hydrate offscreen dashboard views

## Status

Draft

## Context

Dashboard pages previously rendered every custom view eagerly, including views outside the viewport. This pull request (githubnext/gh-aw-cao#4786, "Lazily hydrate offscreen dashboard views") changes this by deferring the rendering of offscreen views while preserving layout stability and navigation behavior.

The change touches 7 files: `dashboard/aw.yml`, `dashboard/site/index.html`, a new component `dashboard/site/src/components/lazy-view.js`, `dashboard/site/src/presenter.js`, `dashboard/site/src/styles.js`, and updated tests `dashboard/site/test/e2e/smoke.spec.js` and `dashboard/site/test/unit/lazy-view.test.js`.

The diff shows `renderCustomPage` in `presenter.js` now renders a view eagerly only when it is route-driven, is the first view (`index === 0`), or is marked as a `callout`; all other custom views are wrapped via `renderLazyView(...)` from the new `lazy-view.js` module. `lazy-view.js` implements:
- `renderLazyView`, which produces a placeholder element (`role="region"`, `tabIndex="0"`, `aria-busy="true"`, and an `aria-label` of the form "Loading {label}") with a reserved `--dashboard-lazy-view-min-height` and an accessible skeleton (`dashboard-lazy-view-skeleton` with `aria-hidden` spans), and stores the deferred `render` function in a `WeakMap`.
- `enableLazyViews`, which uses `IntersectionObserver` (with `rootMargin: '320px 0px'`) to hydrate views as they approach the viewport, hydrates on `<details>` disclosure `toggle` events, and hydrates on `focusin` (keyboard focus). If `IntersectionObserver` is not available on `window`, all lazy views hydrate immediately.
- `disconnectLazyViews`, which disconnects the observer for a root element.
- `trackViewTransition` / `hydrateLazyView`, which defer replacing a skeleton with real content until any active View Transition (`document.startViewTransition`) finishes, and restore focus to the newly hydrated element if the skeleton had focus when hydration completed.

`presenter.js` also adds `disposeDashboard(root)`, called from `index.html` before a previous dashboard's DOM is replaced, which disconnects lazy-view observers for each `.dashboard-page`. `enableDashboardPageNavigation` now calls `disconnectLazyViews(activePage)` before clearing a page's children during navigation and `enableLazyViews(renderedPage)` after a new page is rendered. `styles.js` adds `.dashboard-lazy-view` / `.dashboard-lazy-view-skeleton` rules, including reduced-motion handling that disables the skeleton pulse animation. `dashboard/aw.yml` adds `lazy-view.js` to the list of site resources copied into the generated dashboard workflow assets. Unit tests (`lazy-view.test.js`) cover viewport-triggered hydration, the no-`IntersectionObserver` fallback, View Transition coordination, and keyboard-focus hydration; the e2e smoke spec is updated to explicitly hydrate offscreen views before asserting on them.

Not inferable from current pull request evidence: prior performance measurements motivating this change, user/stakeholder reports of slow dashboard loads, or any explicit rejection of alternative libraries/approaches beyond what the diff itself implies.

## Decision

Defer rendering ("hydration") of offscreen custom dashboard views using a dedicated `lazy-view.js` component built on `IntersectionObserver`, while eagerly rendering the first view, route-driven views, and callout-marked views. Each deferred view is represented by a placeholder that reserves its expected height and shows an accessible loading skeleton, and is hydrated when it nears the viewport (320px rootMargin), when its containing `<details>` disclosure is opened, or when it receives keyboard focus. Hydration is coordinated with in-flight View Transitions (waiting for `transition.finished` before swapping in real content) and with page lifecycle events (observers are disconnected on page navigation via `disconnectLazyViews` and on dashboard replacement via the new `disposeDashboard`). When `IntersectionObserver` is unavailable on the document's `window`, all lazy views fall back to immediate rendering.

## Alternatives Considered

- **Continue eagerly rendering all custom views on page load.** This is the prior behavior being replaced; the PR body states it caused every view, including those outside the viewport, to be rendered up front.
- **Hydrate offscreen views without reserving layout space or showing a loading indicator.** The diff instead reserves a `--dashboard-lazy-view-min-height` and renders an `aria-hidden` skeleton inside an `aria-busy="true"` placeholder, indicating an explicit choice to avoid layout shift and to keep the loading state accessible rather than leaving blank or collapsing space.

## Consequences

**Positive:**
- Only the first view, route-driven views, and callout views render immediately; other custom views defer their rendering work until they are needed (near-viewport, disclosed, or focused), per the `renderCustomPage` logic in `presenter.js`.
- Reserved placeholder height (`dashboard-lazy-view` min-height) and skeleton styling are intended to minimize layout shifts while views are pending, including a reduced-motion variant that disables the skeleton pulse animation.
- Hydration on `focusin` and restoring focus to the hydrated element (when the placeholder held focus) preserves keyboard navigation behavior across the swap.
- Hydration falls back to immediate rendering when `IntersectionObserver` is unavailable, avoiding views that never render in unsupported environments.
- Observers are explicitly disconnected during page navigation (`disconnectLazyViews(activePage)`) and dashboard replacement (`disposeDashboard`), reducing the risk of observer/handler leaks across page and dashboard transitions.
- New unit tests (`lazy-view.test.js`) and updated e2e smoke coverage exercise viewport, fallback, transition, and keyboard hydration paths.

**Negative:**
- The hydration logic in `lazy-view.js` (view transition tracking, disclosure/focus listeners, observer lifecycle) adds new asynchronous coordination code that must be kept correct across page navigation, dashboard replacement, and View Transition timing.
- Content that is deferred is not present in the DOM until hydrated, which changes when consumers of the rendered custom views (e.g., other DOM queries or the smoke test) can observe their content; the e2e smoke spec required updates to explicitly hydrate offscreen views before asserting on them.
- Not inferable from current pull request evidence: any measured performance improvement from this change, or the impact on dashboards with a very large number of custom views beyond what is described in the diff.
