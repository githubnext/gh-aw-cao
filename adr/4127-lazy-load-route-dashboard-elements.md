# ADR 4127: Lazy-load route dashboard elements

## Status

Draft

## Context

The dashboard's Lighthouse performance suite identified `unused-javascript` as the selected bottleneck across all three persona dashboards (CFO, CTO, CSO), each scoring `0.87` and dragging below budget. The largest repeated source-level cost was traced to eager loading of route-only dashboard modules, most notably `dashboard/site/src/components/packages-view.js` and related route compositions, which were bundled into the initial page load even though they are only needed for specific route-only package/workflow views.

## Decision

Load route-only package and workflow dashboard elements lazily instead of eagerly bundling them into the initial page load. This was implemented by:

- Adding async element rendering support in `dashboard/site/src/components/ui-elements.js` (+69/-0), introducing a `LAZY_ELEMENT_RENDERERS` map that uses dynamic `import()` of `packages-view.js` for route-only element variants (`package-activity-lazy`, `package-utilization-lazy`, `package-run-trend-lazy`, `package-summary-table-lazy`, `package-activity-shell-lazy`, etc.).
- Updating `dashboard/site/src/presenter.js` (+200/-11) so deferred filter/page repaints can `await` these lazy element imports instead of requiring the modules to be eagerly bundled into the initial load path.
- Preserving the existing synchronous rendering paths for the current dashboard and unit-level reusable element entry points, so only route-only compositions are deferred.

## Alternatives Considered

- **Keep eager bundling of all dashboard route modules**: This was the prior state and was rejected because it kept `unused-javascript` as the dominant Lighthouse bottleneck, holding all three persona scores at `0.87` and inflating LCP (CFO 2204.60ms, CTO 2199.20ms, CSO 2187.85ms).
- **Lazy-load via the same synchronous rendering path used for reusable elements**: Not adopted for route-only compositions; the change explicitly preserves synchronous rendering only for the current dashboard and unit-level reusable elements, while introducing a distinct async/dynamic-import path (`LAZY_ELEMENT_RENDERERS`) for route-only elements.

## Consequences

**Positive:**
- Lighthouse scores improved for all three personas: CFO `0.87 -> 0.89`, CTO `0.87 -> 0.89`, CSO `0.87 -> 0.89`.
- LCP improved across personas: CFO `2204.60ms -> 2034.84ms`, CTO `2199.20ms -> 2038.93ms`, CSO `2187.85ms -> 2033.00ms`.
- Unused JavaScript audit improved: CFO `46 KiB / 70ms -> 45 KiB / 40ms`, CTO `66 KiB / 60ms -> 46 KiB / 20ms`, CSO `104 KiB / 90ms -> 86 KiB / 80ms`.
- The performance suite, along with dashboard lint, typecheck, unit, and e2e suites, passed validation.

**Negative:**
- Deferred filter/page repaints now depend on awaiting dynamic `import()` calls for route-only elements, introducing asynchronous loading behavior into repaint flows that previously (per the preserved paths) were synchronous for other dashboard entry points.
- Not inferable from current pull request evidence: any additional runtime complexity, caching behavior, or failure-mode handling introduced by the dynamic import mechanism beyond what is described above.
