# ADR 4979: Harden dashboard rendering for large datasets

## Status

Draft

## Context

The dashboard's local server (`dashboard/local-server.mjs`) previously produced a single
monolithic `sources.json` payload for the dashboard site, served in full to the browser.
This included a `logs-payload` field on each row of the "runs" source, which is unused by
the browser UI. Parsing one large JSON blob in the browser causes large parse spikes, and
sending unused raw run logs increases payload size unnecessarily.

PR #4979 ("Harden dashboard rendering for large datasets", author mnkiefer, branch
`better-signal-filtering` → `main`) addresses this by changing how dashboard sources are
served and consumed. The PR body states the goals as:
- "Loada dashboard sources incrementally to avoid large JSON parse spikes"
- "Omits unused raw run logs from browser payloads"
- "Renders overview notifications in viewport-sized batches"
- "Adds large-data and constrained-memory regression coverage"

## Decision

Split the previously monolithic `sources.json` dashboard payload into:
1. A manifest endpoint, `/sources/manifest.json`, returning `{ version: 1, sources: [...names] }`.
2. One JSON file per logical source, served on demand at `/sources/<name>.json`.

The server builds this by parsing `sources.json` once server-side, and for the "runs"
source specifically, stripping the `logs-payload` field from every row before storing the
per-source content (`splitSourceContent` map) that is served to the browser. Requests to
`/sources/<name>.json` that reference an unknown source name return 404.

This is paired with client-side changes to consume the new manifest-plus-per-source
loading model instead of a single bulk fetch:
- `dashboard/site/src/source-loader.js` — loads sources incrementally via the manifest.
- `dashboard/site/src/overview-data.js` — consumes incrementally loaded source data.
- `dashboard/site/src/components/notifications-inbox.js` — renders overview notifications
  in viewport-sized batches rather than all at once.
- `dashboard/site/index.html` and `dashboard/site/src/styles.js` — supporting UI changes.

New regression tests are added for large-data and constrained-memory scenarios:
`live-data.test.js`, `notifications-inbox.test.js`, `overview-data.test.js`,
`source-loader.test.js`, and `tests/e2e/dashboard-mobile-live.spec.mjs`.

## Alternatives Considered

Not inferable from current pull request evidence. The PR body and diff describe only the
implemented incremental-loading/manifest approach; no alternative designs (e.g., server-side
pagination, streaming JSON, or client-side lazy virtualization without a manifest split) are
mentioned or rejected in the available evidence.

## Consequences

**Positive:**
- The browser no longer needs to parse one large JSON blob for all dashboard sources,
  avoiding large parse spikes (per PR body).
- Raw run logs (`logs-payload`) are excluded from the "runs" source payload sent to the
  browser, reducing payload size (per PR body and diff).
- Overview notifications are rendered in viewport-sized batches, reducing the amount of
  DOM/rendering work done at once (per PR body).
- New regression tests targeting large-data and constrained-memory conditions increase
  confidence that this behavior is preserved going forward (per changed test files).

**Negative:**
- The dashboard site now depends on a two-step fetch protocol (manifest, then per-source
  files) instead of a single request, adding a coordination point in
  `dashboard/local-server.mjs` and `source-loader.js` that must stay in sync (manifest
  `version` and source names must match between server and client).
- Stripping `logs-payload` from the "runs" source in the browser payload means any future
  browser-side feature requiring raw run logs would need a separate mechanism, since this
  data is no longer available client-side (per diff).
- Not inferable from current pull request evidence: no data is provided on error-handling
  behavior if a per-source fetch fails, or on backward compatibility for cached/older
  dashboard clients expecting the previous monolithic `sources.json` shape.
