# Server HTTP contract

`server/spec/` is the editable TypeSpec contract for the Go dashboard server.
`main.tsp` imports independent domains: shared response/auth types, Dashboard
Language queries and SSE, health, hosted sessions, canonical entities, repository
memory, and ingestion/administration. `/mcp` internals and static dashboard assets
are intentionally out of scope. `postgres.tsp` documents the private physical
storage contract separately from the HTTP entity response contract; it does
not add an API endpoint or alter the canonical response shape.

The PostgreSQL source classification is separate from the logical HTTP row
contract. The registered `$`-prefixed canonical collections (`campaigns`, `repositories`,
`workflows`, `runs`, `jobs`, `sessions`, `events`, `domains`, `tools`, `skills`,
`friction`, `audits`, `issues`, `operationalValues`, `experiments`,
`experimentAssignments`, `graders`, `graderObservations`, `evals`, and
`evalObservations`, and `marketplacePackages`) have native columns for known
producer fields and an extension for genuinely variable observation attributes.
The normalizer merges arbitrary
`observation.data` attributes without a closed field list. Inventory source
names and row objects (even names beginning with `$` when unregistered) are
caller-supplied and genuinely schemaless. The PostgreSQL store must never copy
a native field into an extension or its legacy row representation.
Marketplace package `contents` paths are a known ordered string list stored as
`TEXT[]`; only atypical historical shapes use the mutually exclusive
`contents_exception` JSON column.
Closed nested structures use native PostgreSQL composites: ordered worker and
target arrays, the campaign intelligence envelope and its field registry,
token-usage totals and a named array of per-model usage, and lifecycle source
provenance. Nested presence arrays preserve missing, null, empty objects and
empty lists. Numeric and timestamp columns retain exceptional lexical forms
without copying ordinary values. Known nested properties never enter a JSON
extension. SQL reconstructs the logical JSON response only at the read boundary.

JSON storage is explicitly limited to genuinely open data: upstream enriched
log payloads (`ambientContext`, `workingSet`, `behaviorFingerprint`, `comparison`,
`agenticAssessments`, `graders`, `context`, `ghAwMetadata`, `ghAwManifest`,
`data`, `logsPayload`); evaluator-defined evidence (`implementation`,
`observation`, `diagnostics`, `metrics`, `sources`, `evidenceProvenance`,
`dimensionStates`, `uncertainty`, `drivers`, `groups`, `events`,
`unmeasuredDrivers`); provider-specific token-usage and provenance extensions;
and arbitrary values of individually catalogued intelligence semantic fields.
Structured answers and cost-grain observations also have source-defined shapes.
These are not a compatibility representation for closed fields.

This schema targets a fresh database. Opening a populated earlier schema whose
closed nested columns are JSON fails transactionally; initialization never
discards tenant data or backfills those columns. Rebuild the disposable
projection from its authoritative artifacts into an empty database instead.
Unsupported known field shapes fail closed on replacement, preserving the
previous committed revision.

The compiled `generated/openapi.json` is OpenAPI **3.1** and can be consumed by
another server implementation. `generated/schemas/` contains JSON Schema 2020-12
documents for query definitions, requests and results, SSE data frames, and webhook
acknowledgements. Representative safe examples are embedded in the TypeSpec
models and emitted into OpenAPI/JSON Schema. `RevisionEvent.json` describes the
JSON *inside* each SSE `data:` frame; the stream itself is `text/event-stream`.
Canonical entity rows and GitHub webhook event bodies are deliberately open
objects because their fields are owned by the canonical data schema and GitHub
event types, respectively; do not infer Redis storage or MCP internals from them.

`blackbox-fixtures.json` records observable behavior outside the covered
TypeSpec operations: OAuth redirects and cookie attributes, trusted-proxy and
CORS decisions, SSE frame bytes, static asset fallback, and MCP discovery.
`go -C server test ./internal/server -run TestBlackbox` exercises those fixtures
through the complete HTTP handler (the SSE case needs `POSTGRES_URL` and skips
without it). The other server tests exercise hosted listener startup/drain and
additional edge cases. These fixtures are not an OpenAPI extension and do not
describe OAuth tokens or MCP protocol internals. Reuse the existing
`SourceReader` and `hosting.Service` seams when testing another implementation;
add a new port only when a second implementation or parity test needs one.

## Spec-writer workflow

1. Read the appropriate domain `.tsp` file, the registered handlers in
   `server/internal/server/server.go`, and the underlying handler/model types.
   For query vocabulary, also read `server/internal/query/types.go` and
   `specs/dashboard-data.md`. Keep new paths in the appropriate domain file;
   don't expand `main.tsp` into a monolith.
2. **Edit TypeSpec first** to propose the API change. Describe authentication
   (local bearer, hosted OAuth cookie, public, or signed webhook), request and
   response bodies, statuses, profile availability, and an illustrative
   non-sensitive example. Never model server-side OAuth tokens as API fields.
3. Update the Go handler and caller as needed to conform to the proposed
   contract. Spec changes alone do not deploy new endpoints: an implementation
   must pass the contract checks, and CI compares registered routes and key
   query fields with the generated artifacts.
4. In `server/spec/`, run `npm ci`, then `npm run generate` and `npm test`.
   From the repository root, `npm run dashboard:server:spec` runs the same
   TypeSpec generator after the spec dependencies are installed.
   Commit the `.tsp` source and refreshed `generated/` outputs together.
   `npm run check` regenerates and fails if the committed artifacts drift.
   Run `go -C server test ./...` when changing the implementation. The
   `server-spec` job in `.github/workflows/cgo.yml` runs on server changes.

The Go server has **two authentication profiles**: the loopback local profile
requires an `Authorization: Bearer` capability for protected `/api/` routes;
hosted mode requires an authorized `cao_session` cookie and `X-CSRF-Token` on
mutations. Health/readiness are public, while the webhook authenticates the raw
body using `X-Hub-Signature-256`. Collection and quota endpoints require an
admin-authorized session in hosted mode. Hosted-only `/auth/` routes do not exist
in the local profile. `302` OAuth callback failures return an HTML error page,
not the JSON error body used by ordinary API endpoints. Limits and runtime
authorization rules are enforced by the implementation, not by JSON Schema.
In hosted mode, CAO may own the HTTP listener or supply its complete handler
to an external Go host. Before startup and after shutdown, the externally
hosted handler returns a `503` error body even for health/readiness. The host
must preserve SSE flushing and must not impose a finite whole-request timeout
on `/api/v1/events`.
