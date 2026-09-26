# Dashboard Language Renderer

Production Dashboard Language validator and presenter for the Central Agentic Ops dashboard campaign.

The dashboard build workflow copies this directory to its configured `site-path`, bundles installed `<campaign>/dashboard.json` documents into a small core `dashboard.json` plus per-page `dashboard-pages/*.json` chunks, and generates `sources.json`. The browser loads the core shell first, fetches page chunks on demand, derives presentation-only data, and renders the `/cao` experience without page-specific HTML generation.

## Source composition

An authoring `dashboard.json` may declare a top-level `fragments` array of JSON paths relative to that file. Each fragment is a partial `dashboard` object whose array fields are appended in declaration order. Keep coherent feature slices together: one fragment may contain multiple related `queries`, reusable `views`, and `pages`.

```json
{
  "language-version": "0.1.0",
  "fragments": ["dashboard-features/repositories.json"],
  "dashboard": {
    "id": "central-agentic-ops-dashboard",
    "title": "Central Agentic Ops"
  }
}
```

Fragment paths must remain within the root document's directory, including after symbolic-link resolution. Fragments cannot include other fragments. Builds and local previews fully compose authoring fragments before campaign composition, validation, and runtime page chunking, so the deployed `dashboard.json` and `dashboard-pages/` format is unchanged.

The built-in dashboard keeps its shared query foundations and its controls, repository, workflow/run, campaign, inventory, operations, overview, and entity surfaces under `dashboard-fragments/`. Each file stays below the repository's size limits and owns a coherent set of related queries, reusable views, and pages.

## Data pipeline

1. The activity action writes inventory, deployed-workflow, AI Credit, and operational-value JSON into one bounded cache snapshot.
2. `dashboard/report/records.mjs`, executed by the activity action, normalizes durable issues, pull requests, comments, review artifacts, and run attribution.
3. `dashboard/report/dashboard-language-sources.mjs` adapts collector and record data into `sources.json`.
4. Quality gates validate canonical campaign dashboard sources; the builder bundles those sources into the split dashboard shell and page chunks.
5. The renderer displays the dashboard shell and loading skeleton from `dashboard.json`, fetches the active page chunk on demand, preloads cached sources from IndexedDB when available, then refreshes the interface and cache from validated `sources.json`.

`sources.json` is the default deployed input. Add `?fixtures` locally to use the illustrative fixture data.

The [Overview component model](../../docs/dashboard-overview-components.md) documents that page's UI ownership boundaries, state coverage, and fixture-based visual testing convention. The [dashboard view catalog](../../docs/dashboard-view-catalog.md) indexes every standardized product view, built-in page, mark, chart, and named element.

## WebMCP adapter

Dashboard pages define the semantic capabilities of the dashboard. Human rendering and WebMCP are generated adapters over the same page definitions and the same query execution path, so there is no second tool catalog to maintain.

- `src/webmcp/manifest.js` is a pure generator. It derives one read-only tool descriptor per agent-facing page: `page.id` becomes the `cao_<page_id>` tool name, `title` becomes the tool title, `description` or `intent` becomes the tool description, a `route.hash-query-parameter` becomes a required string property, and `form.fields` controls map to JSON Schema properties (`slider` to a bounded number, `checkbox` to a boolean, `radio` and `select` to an enum, `text` to a string). A page is agent facing when it appears in the declared navigation or is addressed by one route parameter.
- `src/webmcp/runtime.js` registers those descriptors with `document.modelContext` and executes them. Execution validates the declared arguments, navigates the dashboard to the page route, and reads the page projection through the same page source loader and data-worker boundary the rendered page uses. Tools annotate `readOnlyHint` and never write.

WebMCP is progressive enhancement. The runtime feature-detects `document.modelContext.registerTool` instead of sniffing user agents, ships no polyfill, and registers nothing when the API is absent, disabled, or its origin trial has expired; the dashboard then behaves exactly as before.

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