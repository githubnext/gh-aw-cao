# Go and Redis dashboard server

The `server/` module is an optional backend for running the Central Agentic Ops
dashboard with server-owned persistence and query execution. It ingests the
same compacted data published with the deployed dashboard, materializes
generation-scoped logical sources in Redis Stack, executes Dashboard Language
queries in Go with RediSearch pushdown, and serves the built dashboard either
over loopback HTTP or through an authenticated host-neutral service profile.

The browser never connects to Redis and never receives the Redis URL or
credentials. It communicates only with the same-origin HTTP(S) API.

### Debug logging

The server includes the namespace logger helpers from `github/gh-aw`. Debug
logs are disabled by default and always go to stderr. Enable selected
components with `DEBUG`, for example:

```bash
DEBUG=cao:server,cao:query npm run dashboard:server:serve
DEBUG=cao:* npm run dashboard:server:ingest -- --source DIRECTORY
DEBUG='cao:*,-cao:redis' npm run dashboard:server:serve
```

Available namespaces are `cao:cli`, `cao:server`, `cao:ingest`, `cao:query`,
and `cao:redis`. `ACTIONS_RUNNER_DEBUG=true` enables all namespaces when
`DEBUG` is unset. Logs contain operation names, counts, timings, and status;
they do not include access tokens, OAuth credentials, Redis credentials,
query payloads, or source records. Authentication paths emit fixed
`oauth branch=<operation>.<outcome>` identifiers for every decision and outcome;
the identifiers never contain user, request, session, or credential values.
In the hosted dashboard, add `?debug=auth` to enable matching client-side
authentication branch events through `dashboard/site/src/debug.js`; these
events likewise contain fixed identifiers only.

> [!IMPORTANT]
> The default `serve` command remains local-only: it uses a local bearer
> capability and intentionally rejects non-loopback listen addresses. Remote
> Hosted use requires the explicit `serve-hosted` or Azure Functions profile, which
> replaces the local capability with GitHub OAuth, refresh-token-backed
> server-side sessions, explicit GitHub organization/team authorization, and an
> Azure trusted-proxy policy. PATs are not supported. The Azure Functions
> profile is experimental: deploy it only after security review, staging
> validation, and rollback planning for your Azure tenant.

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
| Azure Functions profile | `internal/server/azure.go` | Builds the same HTTP handler without starting a listener, validates Azure app settings, requires `rediss://` Redis, checks RediSearch availability, and trusts forwarded host/protocol headers only for configured Azure hosts. |
| GitHub OAuth sessions | `internal/server/oauth.go` | Implements the GitHub OAuth authorization-code flow, active organization/team authorization, refresh-token rotation, server-side encrypted sessions in Redis, logout revocation, and CSRF protection for mutating requests. |
| Shared API model | `internal/model/` | Defines logical sources, active-generation metadata, diagnostics, and query metrics. |
| Telemetry | `internal/telemetry/` | Configures the OpenTelemetry TracerProvider from standard `OTEL_*` environment variables, exposes the server's tracer, and writes W3C trace/span id response headers. |
| Local Redis | `docker-compose.yml` | Runs Redis Stack with RediSearch on `127.0.0.1:6379`. |

## Hosted service profile

`serve-hosted` runs the same stateless Go service on a container, VM,
Kubernetes workload, or comparable host. It defaults to
`127.0.0.1:8080`, where a same-host or same-pod HTTPS proxy may forward requests.
A non-loopback listener is accepted only when `--cert` and `--key` configure
TLS at the CAO service itself. It is not coupled to a Redis provider or cloud
SDK. Configuration is supplied through:

| Variable | Purpose |
| --- | --- |
| `CAO_REDIS_URL` | Required TLS `rediss://` endpoint. Credentials remain server-side. Plaintext Redis is limited to local `serve` mode. |
| `CAO_REDIS_NAMESPACE` | Optional deployment namespace; defaults to `hosted-dashboard`. |
| `CAO_ALLOWED_HOSTS` | Required comma-separated trusted public host names. |
| `CAO_GITHUB_CLIENT_ID`, `CAO_GITHUB_CLIENT_SECRET`, `CAO_GITHUB_REDIRECT_URL` | GitHub OAuth application. |
| `CAO_SESSION_SECRET` | Current session encryption/signing secret of at least 32 characters. |
| `CAO_SESSION_SECRET_PREVIOUS` | Optional previous session secret retained only during controlled rotation. |
| `CAO_GITHUB_ALLOWED_ORGS`, `CAO_GITHUB_ALLOWED_TEAMS` | Explicit authorization policy. |
| `CAO_GITHUB_ADMIN_USERS` | Required comma-separated GitHub logins allowed to trigger rebuilds. |
| `CAO_GITHUB_WEBHOOK_SECRET` | Required GitHub webhook signature secret of at least 32 characters. |
| `CAO_SOURCE_DIRECTORY` | Required authoritative deployed gh-aw artifact directory used by rebuild/reconciliation. |

Hosted HTTPS enforcement cannot be disabled. Forwarded host and protocol
headers are trusted only when the service is bound to loopback; externally
reachable listeners validate their direct TLS connection and `Host` header.
Supply secrets through the deployment platform's secret manager (for example,
Key Vault references, Kubernetes Secrets mounted into the process environment,
or an equivalent managed facility), never command-line arguments or checked-in
configuration.

The hosted server exposes canonical repository/run APIs, verifies and
deduplicates webhook deliveries, and coordinates projection updates with a
Redis lease so multiple replicas do not rebuild concurrently. Webhooks trigger
authoritative re-ingestion; they are not treated as complete canonical records.
Validated webhook and rebuild requests return `202` before projection work
continues under a bounded, request-independent context. Only explicitly listed
administrators may call `POST /api/admin/rebuild`; it always forces a new staged
generation, validates it, then atomically activates it. A failed rebuild leaves
the previous generation active.

The hosted dashboard shows a user icon at the lower left of the navigation.
It appears only after the server confirms an authenticated GitHub session and
opens a user view with account switching and logout. Logout remains on a
non-cacheable signed-out page until the user explicitly starts another login.
“Use another GitHub account” clears and revokes the current CAO session, then
starts a fresh OAuth flow with GitHub's account chooser. Only the newly selected
account is retained in the browser session; tokens for every account remain
server-side.

`internal/server/auth_model_test.go` defines the browser authentication state
model and generates every valid login, switch-account, and logout path through
three transitions. Each generated path drives the real HTTP handlers and checks
the canonical session endpoint after every transition.

The Redis command client reuses a bounded connection pool, applies operation
deadlines, and retries read-only commands once when a pooled connection has
gone stale. Write commands are not replayed automatically.

### Hosted Azure architecture

> [!WARNING]
> The hosted Azure architecture is an experimental production-readiness profile,
> not a turnkey production certification. Treat the Bicep, OAuth policy, Redis
> topology, and Key Vault access model as a reviewed baseline that must be
> validated against your organization's Azure, GitHub, compliance, monitoring,
> incident-response, and data-retention requirements before live use.

The Azure Functions profile keeps the dashboard browser isolated from Redis,
GitHub tokens, refresh tokens, Redis access keys, and Key Vault secret values.
The Function App is the only public application boundary and the only component
that talks to GitHub APIs, Key Vault references, and Redis Enterprise.

```mermaid
flowchart LR
  Browser["Authorized user's browser"]
  Edge["Azure HTTPS edge / App Service front end<br/>sets forwarded host + proto"]
  Function["Function App<br/>Go dashboard HTTP handler<br/>GitHub OAuth sessions + CSRF"]
  GitHubOAuth["GitHub OAuth + API<br/>login, refresh, org/team membership"]
  KeyVault["Azure Key Vault<br/>OAuth secret, session secret, Redis URL"]
  Redis["Azure Redis Enterprise<br/>TLS + RediSearch<br/>derived dashboard projection"]
  Storage["Functions storage account<br/>runtime state only"]
  Insights["Application Insights<br/>non-secret operational telemetry"]
  Operators["Control-plane operators<br/>deploy Bicep + rotate secrets"]

  Browser -->|"HTTPS static assets + API + best-effort SSE"| Edge
  Edge -->|"trusted forwarded host/proto only when allow-listed"| Function
  Function -->|"OAuth code, refresh, membership checks"| GitHubOAuth
  Function -->|"Key Vault references resolved by managed identity"| KeyVault
  Function -->|"rediss:// FT.SEARCH / FT.AGGREGATE"| Redis
  Function -->|"runtime binding state"| Storage
  Function -->|"no tokens, no Redis URL, no source records"| Insights
  Operators -->|"reviewed Bicep + secret rotation"| KeyVault
  Operators -->|"deploy package + app settings"| Function

  classDef boundary fill:#eef6ff,stroke:#0969da,stroke-width:2px;
  class Function,KeyVault,Redis boundary;
```

Primary actors and responsibilities:

- **Dashboard user**: authenticates through GitHub OAuth, must satisfy the
  configured organization/team authorization policy, and receives only
  same-origin dashboard HTML/API responses.
- **Azure platform**: terminates HTTPS, invokes the custom Functions handler,
  resolves Key Vault references through managed identity, and may cold-start,
  scale in, or terminate long-lived SSE requests.
- **GitHub OAuth/API**: issues expiring access/refresh tokens and confirms
  organization/team membership; GitHub tokens never leave the server.
- **Redis Enterprise**: stores disposable, namespaced dashboard projections and
  RediSearch indexes; it is not an authority or source of truth.
- **Control-plane operator**: reviews Bicep/app settings, keeps Key Vault
  mandatory, rotates credentials, and validates compliance evidence.

Trust boundaries:

- Browser ↔ Function App: authenticated same-origin HTTPS with `Secure`,
  `HttpOnly`, `SameSite=Lax` session cookies and CSRF headers for mutation.
- Function App ↔ GitHub: server-side OAuth/token refresh/membership calls; no
  PATs and no GitHub tokens forwarded to the browser.
- Function App ↔ Key Vault: managed identity and RBAC only; no secret values in
  Bicep outputs, logs, checked-in parameters, or browser-readable state.
- Function App ↔ Redis Enterprise: TLS-only `rediss://` and a deployment
  namespace for disposable derived data.

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
| `GET /api/health` | Public liveness; an empty Redis instance is healthy and reports `rebuildRequired`. |
| `GET /api/readiness` | Public readiness; returns 503 until an active generation exists. |
| `POST /api/v1/query` | Execute requested Dashboard Language queries and return bounded logical sources plus metrics. |
| `POST /api/v1/refresh` | Return the current revision and authoritative evaluation time without ingesting data. |
| `GET /api/v1/events` | Server-Sent Events stream that notifies active views when the Redis revision changes. |
| `GET /api/v1/diagnostics` | Canonical schema counts, relationship errors, and duplicate IDs for the active generation. |
| `GET /api/repositories` and `GET /api/repositories/:id` | Return canonical repository objects. |
| `GET /api/repositories/:id/runs` and `GET /api/workflows/:id/runs` | Return related canonical runs. |
| `GET /api/runs/:id/jobs`, `GET /api/runs/:id/sessions`, `GET /api/sessions/:id/events` | Return related canonical execution records when published. |
| `POST /api/github/webhook` | Verify, deduplicate, and reconcile a GitHub delivery. |
| `POST /api/admin/rebuild` | Force a staged full rebuild and atomic activation. |
| `GET /api/admin/rebuild/status` | Return shared rebuild state for all replicas. |

API responses use `Cache-Control: no-store`. The dashboard service worker
excludes `/api/` so query results and event streams are never placed in browser
caches.

## Telemetry

The server is instrumented with standard, vendor-neutral
[OpenTelemetry](https://opentelemetry.io/) tracing (`internal/telemetry/`):
every HTTP request is wrapped with `otelhttp`, the query engine and ingestion
paths start dedicated `cao_dashboard.query.execute` and
`cao_dashboard.ingest.run` spans, and span/trace attributes are limited to
non-secret aggregate counts, revisions, and durations (no Redis URLs,
credentials, GitHub tokens, or row contents). Identifiers follow the W3C Trace
Context specification: the tracer provider installs `propagation.TraceContext`
so a client-sent `traceparent` header continues an existing trace, and every
API response echoes the active request's ids as `X-Trace-Id` /
`X-Span-Id` headers for correlating a client-visible request with exported
spans.

Tracing is configured entirely through the standard OpenTelemetry SDK
environment variables; no exporter is linked unless one is configured:

| Variable | Effect |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Enables the OTLP/HTTP trace exporter and sets its destination. Spans are only created as no-ops until one of these is set. |
| `OTEL_EXPORTER_OTLP_HEADERS` | Extra headers (for example, a collector API key) sent with each export request; read directly by the OTLP exporter. |
| `OTEL_SERVICE_NAME` | Overrides the default `cao-dashboard` `service.name` resource attribute. |
| `OTEL_SDK_DISABLED` | Set to `true` to force the no-op tracer provider even when an endpoint is configured. |

There is no Azure-specific exporter linked into the binary. To ship spans to
Application Insights, point `OTEL_EXPORTER_OTLP_ENDPOINT` at an OpenTelemetry
Collector configured with the `azuremonitorexporter` and the
`APPLICATIONINSIGHTS_CONNECTION_STRING` provisioned by `azure/main.bicep`;
the Function App itself never imports an Azure Monitor SDK.

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

The local capability profile is not suitable for remote or multi-user
deployment. The capability authorizes its holder to read the full active
dashboard generation; it provides no user identity or per-source authorization.

The Azure Functions profile is the experimental remote profile. It is
enabled only by constructing the app with `HostingModeAzureFunctions` or by
calling `NewAzureFunctionsHandlerFromEnv`; `serve` does not enable it. Azure
mode fails closed unless all of the following are configured:

- `CAO_REDIS_URL` with a `rediss://` URL;
- a Redis namespace (`CAO_REDIS_NAMESPACE`, default `azure-dashboard`);
- `CAO_AZURE_ALLOWED_HOSTS` and HTTPS forwarded-protocol enforcement;
- GitHub OAuth App client ID/secret and redirect URL;
- at least 32 characters of `CAO_SESSION_SECRET`;
- at least one explicit `CAO_GITHUB_ALLOWED_ORGS` or
  `CAO_GITHUB_ALLOWED_TEAMS` value.

Azure mode does not accept the local bearer capability and does not support
PATs. Login alone does not grant access: after exchanging the OAuth code, the
server calls GitHub with the minimum `read:org` scope needed for organization
or team membership checks. Access and refresh tokens remain server-side,
encrypted before storage in Redis, and are never written to browser-readable
storage, URLs, API payloads, or Bicep outputs. Session cookies are `Secure`,
`HttpOnly`, and `SameSite=Lax`; mutating API requests must include the
session-bound CSRF token.

`GET /api/v1/events` is available through Azure Functions only while the
platform keeps the invocation alive. Clients must treat SSE as best-effort and
fall back to `/api/v1/refresh` because Functions instances may cold-start,
scale in, or terminate long-running requests. Cold starts rebuild the Go app
from app settings and check Redis plus RediSearch before serving requests.
Request cancellation propagates through `request.Context()` to Redis queries.

The Bicep deployment in `server/azure/main.bicep` provisions a Function App,
Key Vault, Application Insights, storage, and Redis Enterprise with the
RediSearch module. Every secret-bearing app setting—including Functions runtime
storage—uses a versionless Key Vault reference so ordinary credential rotation
does not require rewriting application configuration. Session-key rotation uses
the optional secure `previousSessionSecret` deployment parameter: deploy the old
key as previous and the new key as current, wait for active sessions and queued
revocations to drain, then remove the previous key. Encrypted records carry a
key identifier, and the server can read both keys during that window. The
template outputs only non-secret host names, redirect URI, Redis database name,
and Key Vault URI. Redis access keys
are an unavoidable path for Redis Enterprise client authentication today;
store the `rediss://` URL in Key Vault, rotate the Redis key in Azure, publish a
new Key Vault secret version, and allow the platform to refresh the reference.

### Azure secure-computing baseline

Treat the Bicep file as the minimum secure baseline for remote dashboard
hosting:

- Do not use PATs. Azure mode supports only the GitHub OAuth
  authorization-code flow and configured organization/team authorization.
- Keep Key Vault mandatory for every secret-bearing value, including the GitHub
  OAuth client secret, `CAO_SESSION_SECRET`, and `CAO_REDIS_URL`. Do not replace
  Key Vault references with literal app settings, deployment outputs, or
  checked-in parameter files.
- Use the Function App's system-assigned managed identity with Key Vault RBAC
  to read secrets. Do not copy Key Vault secret values into logs, telemetry,
  tickets, dashboard documents, or browser-readable configuration.
- Keep HTTPS-only Functions, TLS-only Redis, disabled FTPS, disabled Redis
  public network access, storage HTTPS enforcement, Key Vault soft delete, and
  non-secret Bicep outputs enabled for compliance review.
- Treat the Redis projection as disposable derived state. Compliance evidence
  comes from the checked-in Bicep, GitHub OAuth authorization policy, Key Vault
  access controls, Azure activity logs, Application Insights without secrets,
  and the CAO source artifacts that feed Redis.
- Rotate OAuth, session, storage, and Redis credentials through Key Vault and
  Azure platform controls; then restart the Function App so current secret
  versions are resolved.

Do not remove the experimental designation until the hosted profile has passed
a deployment-specific security review, compliance review, load/cost validation,
incident-response exercise, backup/rollback exercise, and Azure network-access
review for the target tenant.

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
