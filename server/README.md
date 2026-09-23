# Go and Redis dashboard server

The `server/` module is a local-only backend for running the Central Agentic
Ops dashboard with server-owned persistence and query execution. It ingests the
same compacted data published with the deployed dashboard, materializes
generation-scoped logical sources in Redis Stack, executes Dashboard Language
queries in Go with RediSearch pushdown, and serves the built dashboard over
loopback HTTP by default or operator-configured HTTPS.

The browser never connects to Redis and never receives the Redis URL or
credentials. It communicates only with the same-origin HTTP(S) API.

> [!IMPORTANT]
> This server uses a local bearer capability, not user identity or GitHub
> authentication, and intentionally rejects non-loopback listen addresses. It
> is for local development and integration testing. Remote hosting, GitHub
> authentication, live GitHub queries, and webhook ingestion are future work.

## Architecture

```mermaid
flowchart LR
  Artifact["Deployed dashboard artifact<br/>inventory + run JSONL + record JSONL"]
  Ingest["Go ingester<br/>verify, parse, project"]
  Redis["Redis Stack<br/>generation rows + RediSearch indexes"]
  API["Go HTTP(S) server<br/>query planner + bounded fallback"]
  Browser["Dashboard browser app<br/>render bounded view payloads"]

  Artifact --> Ingest
  Ingest -->|"stage complete generation"| Redis
  Redis -->|"atomic activation"| API
  Browser -->|"POST /api/v1/query"| API
  API -->|"FT.SEARCH / FT.AGGREGATE"| Redis
  Redis --> API
  API -->|"LogicalSourceInput JSON"| Browser
  API -->|"SSE revision events"| Browser
```

### Components

| Component | Location | Responsibility |
| --- | --- | --- |
| CLI | `cmd/cao-dashboard/` | Implements the `ingest` and `serve` commands and keeps Redis configuration in the server process. |
| Artifact ingestion | `internal/ingest/` | Validates deployed manifests and hashes, loads run shards before record shards, projects canonical records into logical dashboard sources, and activates complete generations. |
| Query engine | `internal/query/` | Validates Dashboard Language definitions and executes joins, filters, computed fields, aggregates, temporal series, selection, ordering, and limits under resource budgets. |
| Redis projection | `internal/redisx/` | Stores source rows and metadata, creates RediSearch indexes, plans compatible pushdown, loads bounded fallbacks, and atomically publishes the active generation. |
| HTTP(S)/API server | `internal/server/` | Enforces loopback binding, optionally terminates operator-configured TLS, serves static dashboard assets, handles API requests, and publishes revision events. |
| Shared API model | `internal/model/` | Defines logical sources, active-generation metadata, diagnostics, and query metrics. |
| Local Redis | `docker-compose.yml` | Runs Redis Stack with RediSearch on `127.0.0.1:6379`. |

## Data ingestion

The `ingest` command consumes a directory with the deployed dashboard data
contract:

```text
payload-hashes.json
inventory-sources.json
gh-aw-logs-runs/*.jsonl
gh-aw-logs-records/*.jsonl
```

Ingestion fails closed when the manifest is missing, a manifested SHA-256 hash
does not match, a path is unsafe, run-information shards are absent, raw
Activity shards are present, a JSONL record is malformed, or projection fails.

The ingestion sequence is:

1. Validate every manifest path and content hash.
2. Require and read all compacted run-information shards.
3. Read compacted run-linked record shards.
4. Load `inventory-sources.json` as already-logical published sources.
5. Project canonical Campaign, Repository, Workflow, Run, Domain, Tool, Audit,
   and Issue records through
   `dashboard/site/src/data/queries/database.json`.
6. Stage every logical source, its metadata, diagnostics, row set, and
   RediSearch index under a new immutable generation.
7. Atomically update the namespaced active pointer and increment the namespaced
   active revision only after the generation is complete.

An ingestion with the same artifact revision reuses the active generation.
Failure before activation leaves the previous active generation available.

The active generation also records an authoritative `evaluatedAt` timestamp
derived from the latest canonical row or source metadata timestamp. Relative
dashboard time windows use this value rather than browser wall-clock time.

## Redis model

Redis is a disposable query projection, not an authoritative data source.

| Redis structure | Purpose |
| --- | --- |
| `<namespace>:active` | Active generation, monotonically increasing revision, artifact revision, evaluation time, activation time, and source counts. |
| `<namespace>:active-generation` | Active generation pointer updated during atomic activation. |
| `<namespace>:revision-sequence` | Revision counter used by atomic activation. |
| `<namespace>:g:<generation>` | Source metadata, field aliases and types, and canonical diagnostics for one generation. |
| `<namespace>:g:<generation>:source:<hash>:rows` | Set of row keys for one logical source. |
| `<namespace>:g:<generation>:source:<hash>:row:<id>` | Hash containing the complete JSON row plus scalar indexed fields. |
| `<namespace>:idx:<hash>` | RediSearch index scoped to one source in one generation. |

Source names, field names, and row identities are converted to deterministic
hashes before becoming Redis key or index fragments. Complete row JSON remains
available for bounded fallback execution. Every key and RediSearch index is
scoped by `--redis-namespace`. The default is a stable
`cao:checkout-<path-hash>` value derived from the absolute checkout/worktree
path, so separate checkouts using Redis database 0 do not collide. Explicit
values are normalized to a lowercase `cao:` namespace and reject Redis glob
metacharacters.

## Query execution

The browser sends declarative query definitions and requested source names to
`POST /api/v1/query`. The server validates the query graph and resource limits
before loading data.

For compatible base-source queries, the planner pushes work into Redis:

- exact TAG and numeric/time-range filters;
- full-text search over indexed text fields;
- `count`, `distinct-count`, `sum`, `mean`, `min`, and `max` aggregation;
- a single indexed sort;
- result limits.

Joins, computed fields, temporal-series projection, multi-field ordering,
filtered or specialized reducers, and other unsupported pushdown shapes execute
in bounded Go memory after Redis narrows the source. Query metrics report the
pushed-down stages, Redis command count, Redis rows returned, fallback stages,
and total duration.

The engine rejects unsupported prediction queries and enforces limits on query
definitions, joins, predicates, input rows, output rows, and total operations.
It does not silently truncate or return partial success for invalid queries.

## HTTP(S) and browser transport

`serve` binds to `127.0.0.1:8443` by default. Non-loopback listen addresses are
rejected. Local debugging uses HTTP and the server never generates
certificates. Provide both `--cert` and `--key` to enable HTTPS with an existing
operator-managed certificate.

The server injects:

```html
<meta name="dashboard-data-backend" content="redis-http">
```

into the dashboard HTML. The browser then uses the server API instead of
IndexedDB ingestion:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/health` | Public readiness exposes only Redis connectivity and data availability; capability-authenticated requests also receive generation/revision and source/row counts. |
| `POST /api/v1/query` | Execute requested Dashboard Language queries and return bounded logical sources plus metrics. |
| `POST /api/v1/refresh` | Return the current revision and authoritative evaluation time without ingesting data. |
| `GET /api/v1/events` | Server-Sent Events stream that notifies active views when the Redis revision changes. |
| `GET /api/v1/diagnostics` | Canonical schema counts, relationship errors, and duplicate IDs for the active generation. |

API responses use `Cache-Control: no-store`. The dashboard service worker
excludes `/api/` so query results and event streams are never placed in browser
caches.

## Security boundaries

- All data APIs except minimal readiness require a cryptographically random
  capability token. The bootstrap URL stores it in origin-scoped
  `localStorage`, cleans the current URL without navigating, and browser requests attach it
  explicitly as an `Authorization: Bearer` header. The token is never placed in
  a host-scoped cookie.
- Only loopback listeners are accepted.
- Non-loopback `Host` headers are rejected to reduce DNS rebinding exposure.
- Redis configuration is accepted only by the CLI and is never serialized into
  HTML, browser configuration, API payloads, or URLs.
- Plaintext `redis://` URLs are accepted only for literal loopback IP addresses
  or `localhost`; `localhost` is dialed through a literal loopback address, and
  arbitrary hostnames are not resolved to decide whether plaintext transport
  is safe.
- Remote Redis requires `rediss://`, standard certificate-chain and hostname
  verification, and TLS 1.2 or newer. There is no insecure skip-verification
  option.
- Redis namespaces isolate this server's keys and indexes, but are not a
  substitute for dedicated Redis credentials with narrow ACL key patterns or a
  dedicated Redis database or instance.
- The HTTP(S) server sets content-type, frame, referrer, permissions, and
  cross-origin resource policy headers.
- Request bodies, query structures, row counts, output counts, and operation
  counts are bounded.
- Deployed artifact paths and SHA-256 hashes are validated before parsing.
- Static files are served only from the configured built-site directory, with
  SPA fallback to that directory's `index.html`.
- Missing Redis, data, manifests, shards, projections, or diagnostics fail
  closed.

These controls do not make the current server suitable for remote or
multi-user deployment. The capability authorizes its holder to read the full
active dashboard generation; it provides no user identity or per-source
authorization. A future remote profile requires identity-aware authentication,
authorization, trusted-proxy policy, credential rotation, tenant isolation,
rate limiting, audit logging, and an explicit deployment threat model.

See [`SECURITY.md`](SECURITY.md) for the complete protection model, operational
guidance, limitations, and private vulnerability-reporting process.

## Run locally

The module targets and pins Go 1.27.1.

On a MacBook, install Homebrew first and run the idempotent project setup:

```bash
npm run dashboard:server:setup:macos
```

The command installs Homebrew Go, Node.js 24, the Docker CLI, Docker Compose,
Colima, and the dashboard npm dependencies. Redis Stack with RediSearch runs only through
`server/docker-compose.yml`; the setup does not install or start a native Redis
service.

From the repository root:

```bash
docker-compose -f server/docker-compose.yml up -d

npm --prefix dashboard/site ci
npm run dashboard:server:build

go -C server run ./cmd/cao-dashboard ingest \
  --source /absolute/path/to/deployed-dashboard

go -C server run ./cmd/cao-dashboard serve
```

`serve` prints a capability URL such as:

```text
http://127.0.0.1:8443/?access_token=<random-token>
```

Open that exact URL. The server removes the token from the address bar after
initializing origin-scoped browser local storage. Refreshes continue to work
without restoring the token in the URL. Use `--access-token` with a
value of at least 32 characters only when deterministic automation requires it.

Ingest and serve in one process:

```bash
go -C server run ./cmd/cao-dashboard serve \
  --source /absolute/path/to/deployed-dashboard \
  --access-token 0123456789abcdef0123456789abcdef
```

Use `--redis-url` and optional `--redis-namespace` only on the server command
line. The same namespace must be supplied to `ingest` and `serve` when
overriding the checkout-derived default:

```bash
go -C server run ./cmd/cao-dashboard serve \
  --redis-url redis://127.0.0.1:6379/0 \
  --redis-namespace local-dashboard
```

Use verified TLS for non-local Redis:

```bash
go -C server run ./cmd/cao-dashboard serve \
  --redis-url rediss://redis.example.com:6379/0 \
  --redis-namespace production-dashboard
```

Verify the local endpoint:

```bash
curl http://127.0.0.1:8443/api/v1/health

curl http://127.0.0.1:8443/api/v1/query \
  -H 'authorization: Bearer 0123456789abcdef0123456789abcdef' \
  -H 'content-type: application/json' \
  --data '{"sourceNames":["runs"],"queries":[]}'
```

Stop Redis:

```bash
docker-compose -f server/docker-compose.yml down
```

## Validation and CI

Install the pinned linter and run the local quality checks:

```bash
go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.13.2
npm run dashboard:server:lint
npm run dashboard:server:test
```

The Redis-backed end-to-end test uses the deployed-format subset under
`server/testdata/deployed-subset`, starts the HTTP server, and verifies that
the Runs, Workflows, and Repositories views render populated rows:

```bash
docker-compose -f server/docker-compose.yml up -d
npm ci
npm --prefix dashboard/site ci
npm run dashboard:server:build
npx playwright install chromium
npm run test:e2e:dashboard-server
```

`.github/workflows/cgo.yml` keeps server validation separate from the static
dashboard CI:

- **Go format, lint, and tests** runs Go 1.27.1, golangci-lint v2.13.2, and the
  server unit suite.
- **Redis dashboard integration** starts Redis Stack, runs the Redis integration
  tests, builds the dashboard and server, ingests the deployed shard subset,
  launches the localhost HTTP server, and executes the Playwright view assertions.
