# Dashboard Language Renderer

Production Dashboard Language validator and presenter for the Central Agentic Ops dashboard package.

The dashboard build workflow copies this directory to its configured `site-path`, bundles installed `.github/aw/dashboards/*.json` package documents into `dashboard.json`, and generates `sources.json`. The browser loads those two files, derives presentation-only data, and renders the `/cao` experience without page-specific HTML generation.

## Data pipeline

1. The activity action writes inventory, deployed-workflow, AI Credit, and operational-value JSON into one bounded cache snapshot.
2. `dashboard/report/records.mjs`, executed by the activity action, normalizes durable issues, pull requests, comments, review artifacts, and run attribution.
3. `dashboard/report/dashboard-language-sources.mjs` adapts collector and record data into `sources.json`.
4. Quality gates validate package dashboard sources; the builder bundles installed package dashboards into `dashboard.json`.
5. The renderer displays the dashboard shell and loading skeleton from `dashboard.json`, preloads cached sources from IndexedDB when available, then refreshes the interface and cache from validated `sources.json`.

`sources.json` is the default deployed input. Add `?fixtures` locally to use the illustrative fixture data.

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