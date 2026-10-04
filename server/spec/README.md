# Server contracts

`server/spec/` is the editable TypeSpec contract for the Go dashboard server.
`main.tsp` imports independent domains: shared response/auth types, Dashboard
Language queries and SSE, health, agent discovery, hosted sessions, canonical
entities, repository memory, ingestion/administration, and the optional MCP HTTP
transport. MCP protocol messages and tool schemas, and static dashboard assets,
are intentionally out of scope.

`storage.tsp` is a separate, **fresh-only** physical Postgres contract.
`storage.tspconfig.yaml` runs the repository-owned `postgres-emitter.mjs` to
generate `../internal/postgresx/schema.sql` and `schema.gen.go`. The SQL file is
standalone DDL for downstream implementations; the Go file supplies the same
entity names, fields, and native types to ingestion and reads. Both are generated
artifacts. Edit TypeSpec, never the generated SQL or bindings.

Each canonical collection has one root table. Only fields
consumed by `dashboard/site/src/data/queries/database.json` and its joins are
retained, plus identity/storage keys. Counters use `BIGINT`, fractional measures
use `NUMERIC`, booleans use `BOOLEAN`, timestamps use `TIMESTAMPTZ`, and identifiers
use `TEXT`. Optional-field presence costs one bit per scalar column, preserving
absent versus explicit null. Query-required structured evidence uses entity-owned
relational child values; no JSON, JSONB, serialized row documents, or duplicate
generic scalar rows are stored.

The `Storage` namespace describes the current source metadata, auxiliary
sources, revision, and diagnostics scaffolding, separately from entity models.
It is not an alternate canonical representation. Startup only initializes this
schema; there are no old-layout migrations or backward-compatible imports.
Use a fresh database when changing its physical layout.

The local SQLite evidence mirrors likewise retain typed query columns and
observation metadata, but no `record_json` copy. The complete document lives
once in `__idb_records.value`. Outdated mirrors are rebuilt transactionally
from those canonical records, never from a second stored representation.
Canonical normalization and writes also prune unused raw Run payload copies,
Workflow declaration copies, Issue lifecycle aliases, and the unused
`isSkill` flag. The explicit exclusions live in
`dashboard/site/src/data/model/fields.js`; provenance and unrecognized
evidence remain intact.

### Compact Tool storage

`tools` stores one usage fact per Run, observed tool identity, and evidence
source. `toolIdentities` shares repeated identities within a namespace.
`toolCounters` owns exact categorical counters by UTC event day; incomplete
outcomes are not confirmed failures, and sizes are counted at call grain only.
All facts reference the owning Run's current `toolUsageRevision`.

`tools` and `tool_counters` use weekly `run_at` range
partitions, with partition-aware foreign keys and child-first expiry.
Original Tool events are discarded after aggregation. There is no cold archive,
locator table or exact-event endpoint. Intraday sequence, original correlation
and percentile analysis are unavailable; diagnostics report exact Tool detail
as unavailable rather than inventing an empty history.

Canonical model 29, Go model 18, SQL export 5, and the new browser namespace
are breaking contracts. Use fresh databases; old layouts and normalized
payloads are rejected. There are no upgrades, migrations, event-grain
compatibility sources, or retained hot event copies. See the normative Tool
aggregation contract in `specs/dashboard-data.md` Section 12.1.

Jobs, sessions, and events are not stored as canonical entity tables or
exposed as HTTP or query sources.

Run `npm run generate:storage` for storage only, or `npm run generate` for both
storage and HTTP contracts. `storage.test.mjs` checks one-to-one table coverage,
required query fields, absence of speculative columns, and document-free DDL.
The follow-on removal and rebuild plan is [Postgres rebuild plan](../POSTGRES-REBUILD-PLAN.md).

The compiled `generated/openapi.json` is OpenAPI **3.1** and can be consumed by
another server implementation. Its `info.version` records the HTTP contract
version; review and update it when changing externally observable API signatures.
`generated/schemas/` contains JSON Schema 2020-12
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
   The root `dashboard:server:build` and `check` scripts also verify committed
   generated API signatures before proceeding; install spec dependencies with
   `npm --prefix server/spec ci` before running either command.

The Go server has **two authentication profiles**: the loopback local profile
requires an `Authorization: Bearer` capability for protected `/api/` routes;
hosted mode requires an authorized `cao_session` cookie and `X-CSRF-Token` on
mutations. Health/readiness and `GET`/`HEAD /llms.txt` are public, while the webhook
authenticates the raw body using `X-Hub-Signature-256`. Collection and quota
endpoints require an admin-authorized session in hosted mode. Hosted-only `/auth/` routes do not exist
in the local profile. `302` OAuth callback failures return an HTML error page,
not the JSON error body used by ordinary API endpoints. Limits and runtime
authorization rules are enforced by the implementation, not by JSON Schema.
In hosted mode, CAO may own the HTTP listener or supply its complete handler
to an external Go host. Before startup and after shutdown, the externally
hosted handler returns a `503` error body even for health/readiness. The host
must preserve SSE flushing and must not impose a finite whole-request timeout
on `/api/v1/events`.
