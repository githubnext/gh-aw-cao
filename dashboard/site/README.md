# Dashboard Language Renderer

Production Dashboard Language validator and presenter for the Central Agentic Ops dashboard campaign.

The dashboard build workflow copies this directory to its configured `site-path`, bundles installed `.github/aw/dashboards/*.json` campaign documents into a small core `dashboard.json` plus per-page `dashboard-pages/*.json` chunks, and generates `sources.json`. The browser loads the core shell first, fetches page chunks on demand, derives presentation-only data, and renders the `/cao` experience without page-specific HTML generation.

## Data pipeline

1. The activity action writes inventory, deployed-workflow, AI Credit, and operational-value JSON into one bounded cache snapshot.
2. `dashboard/report/records.mjs`, executed by the activity action, normalizes durable issues, pull requests, comments, review artifacts, and run attribution.
3. `dashboard/report/dashboard-language-sources.mjs` adapts collector and record data into `sources.json`.
4. Quality gates validate campaign dashboard sources; the builder bundles installed campaign dashboards into the split dashboard shell and page chunks.
5. The renderer displays the dashboard shell and loading skeleton from `dashboard.json`, fetches the active page chunk on demand, preloads cached sources from IndexedDB when available, then refreshes the interface and cache from validated `sources.json`.

`sources.json` is the default deployed input. Add `?fixtures` locally to use the illustrative fixture data.

The [Overview component model](../../docs/dashboard-overview-components.md) documents that page's UI ownership boundaries, state coverage, and fixture-based visual testing convention. The [dashboard view catalog](../../docs/dashboard-view-catalog.md) indexes every standardized product view, built-in page, mark, chart, and named element.

## Quality gates

```bash
npm install
npm run build
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm run test:performance
```

The performance suite audits CFO, CTO, and CSO dashboard journeys with Lighthouse. It writes machine-readable reports, browser traces, and a summary under `test-results/lighthouse/`; CI retains that directory as the `dashboard-lighthouse-performance` artifact.

The production build bundles and minifies the application with esbuild and publishes external source maps alongside the JavaScript bundles.