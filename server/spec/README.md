# Server HTTP contract

`server/spec/` is the editable TypeSpec contract for the Go dashboard server.
`main.tsp` imports independent domains: shared response/auth types, Dashboard
Language queries and SSE, health, hosted sessions, canonical entities, repository
memory, and ingestion/administration. `/mcp` internals and static dashboard assets
are intentionally out of scope.

The compiled `generated/openapi.json` is OpenAPI **3.1** and can be consumed by
another server implementation. `generated/schemas/` contains JSON Schema 2020-12
documents for query definitions, requests and results, SSE data frames, and webhook
acknowledgements. Representative safe examples are embedded in the TypeSpec
models and emitted into OpenAPI/JSON Schema. `RevisionEvent.json` describes the
JSON *inside* each SSE `data:` frame; the stream itself is `text/event-stream`.
Canonical entity rows and GitHub webhook event bodies are deliberately open
objects because their fields are owned by the canonical data schema and GitHub
event types, respectively; do not infer Redis storage or MCP internals from them.

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
