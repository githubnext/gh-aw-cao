# Go dashboard server with Postgres and Redis

The [TypeSpec HTTP contract](spec/README.md) is the source for generated
OpenAPI 3.1 and selected JSON Schemas; consult it before changing server routes.

The `server/` module is an optional backend for running the Central Agentic Ops
dashboard with server-owned persistence and query execution. It ingests the
same compacted data published with the deployed dashboard, stores current
native entity rows in PostgreSQL and executes hosted Dashboard Language plans
as SQL through the bounded PostgreSQL query engine,
and serves the built dashboard either over loopback HTTP or through an
authenticated host-neutral service profile. Redis handles operational caches,
queues, and sessions; it does not hold or query dashboard entities.

The browser never connects directly to Postgres or Redis and never receives
database credentials. It communicates only with the same-origin HTTP(S) API.

## Offline query validation

From `server/`, run `go run ./cmd/cao-dashboard compile-queries` to check every
query in `dashboard/site/dashboard.json`, `dashboard/site/dashboard-fragments/`,
and the canonical database query file. Use `--format json` for
machine-readable results. This command validates definitions offline; it does
not compile or execute SQL plans.

Hosted queries are compiled to SQL and executed in PostgreSQL within the
request's repeatable-read transaction. The server does not fall back to a Go
row evaluator: unsupported definitions and unregistered sources fail closed.
Generated TypeSpec identifiers are used, values and namespace are
parameterized, missing values remain distinct from explicit null, and SQL
resource checks enforce operation, output, retained-row, and memory budgets.
Explicitly registered operational sources are provided at the server boundary
and participate as bounded SQL input relations.

The deployed query corpus is exercised through the SQL executor by the
`TestDashboardQueryCorpusUsesPostgres` integration test. It requires
`POSTGRES_URL`; the dashboard-query-parity CI job additionally compares
representative HTTP/MCP results with the browser evaluator over the deployed
unparameterized named-query corpus.

With a disposable fresh database, run
`POSTGRES_URL=... go test ./internal/postgresx -run '^$'
-bench '^BenchmarkNativeFilterPlan$' -benchmem -benchtime=100x -count=1`
from `server/` to compare typed SQL and hand-written SQL retrieval over 5,000
domain records. The benchmark reports
`EXPLAIN (ANALYZE, BUFFERS)`, table/index bytes, ingestion time, allocations,
and p50/p95; it asserts zero canonical scalar copies in generic value storage.
These synthetic measurements do not establish production traffic coverage.

### Debug logging

The server includes the namespace logger helpers from `github/gh-aw`. Debug
logs are disabled by default and go to stderr when enabled. Enable selected
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

To also export enabled namespaces as OTLP logs, set
`CAO_OTEL_LOGS_ENABLED=true` and configure `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`
or `OTEL_EXPORTER_OTLP_ENDPOINT`. `DEBUG` still selects the same namespaces
for both stderr and OTLP; setting an endpoint alone does not enable log export.
The exporter batches records and flushes at shutdown. `slog` error records
retain their severity and active trace/span context. Only enable reviewed,
non-sensitive namespaces when exporting to an external collector.

> [!IMPORTANT]
> The default `serve` command remains local-only: it uses a local bearer
> capability and intentionally rejects non-loopback listen addresses. Remote
> Hosted use requires the explicit `serve-hosted` or Azure Functions profile, which
> replaces the local capability with GitHub OAuth, refresh-token-backed
> server-side sessions, explicit GitHub organization/team authorization, and an
> Azure trusted-proxy policy. PATs are not supported. The Azure Functions
> profile is experimental: deploy it only after security review, staging
> validation, and rollback planning for your Azure tenant.

## Ingestion reliability simulator

The `simulate-api` and `simulate-webhooks` commands exercise the actual
collection API and webhook admission paths with synthetic repositories. The
scenario at `testdata/ingestion-scenarios/five-hour-outage.json` models 10,000
repositories, a five-hour GitHub API outage, recovery rate limiting, signed
duplicate/replayed deliveries, out-of-order activity, and a delayed delivery
batch. Scenarios are strict JSON; supported traffic distributions are uniform,
hot-repository, long-tail, and synchronized. Repository counts are bounded at
20,000 and generated workflow and issue events combined at one million. Set
`issue_events_per_repository` in a scenario to generate ordered `issues`
`opened`, `closed`, `reopened`, and `edited` webhook deliveries for each synthetic
repository; the default is zero.

Start the fake GitHub API in one terminal. `--time-scale 3600` advances one
scenario hour per wall-clock second:

```bash
cd server
go run ./cmd/cao-dashboard simulate-api \
  --scenario testdata/ingestion-scenarios/five-hour-outage.json \
  --listen 127.0.0.1:8081 --time-scale 3600
```

Start the CAO server and Redis using the normal collection setup, setting
`CAO_COLLECT_GITHUB_API_URL` (and, when needed,
`CAO_COLLECT_GITHUB_UPLOAD_URL`) to `http://127.0.0.1:8081`. Then deliver the
webhooks to its normal `/api/github/webhook` endpoint:

```bash
go run ./cmd/cao-dashboard simulate-webhooks \
  --scenario testdata/ingestion-scenarios/five-hour-outage.json \
  --endpoint http://127.0.0.1:8080/api/github/webhook
```

The simulator reads the signing secret from `CAO_GITHUB_WEBHOOK_SECRET` and
does not print it. Webhook installation and repository-add events are sent
before workflow events so admission is correctly scoped; repository removals
are sent after activity. The fake API implements the small REST surface needed
for app validation, installation tokens, rate-limit inspection, repositories,
and workflow runs, and returns GitHub-style transient errors and rate-limit
headers for configured windows. The collection runner passes the configured
API base URL to `gh aw logs --audit`; collection, queueing, retries, and
projection remain on the production path.

`go test ./internal/server ./internal/simulator` includes an end-to-end signed
webhook test through the production HTTP handler and admission-only collection
queue. It uses the server test Redis protocol fixture so it runs without an
external service. To run that test against a local Redis instance instead,
start Redis with `npm run dashboard:server:redis-up` from the repository root
and set `CAO_SIMULATOR_REDIS_URL=redis://127.0.0.1:6379/0` before running
`go test ./internal/server -run TestSimulatorUsesProductionWebhookAdmissionAndCollectionQueue`.
`TestSimulatorExercisesGoServerWithRedis` sends a deterministic recovery-burst
scenario through the same Go server webhook handler and checks its authorized
ingestion-health response, queue depth, and persisted counters. It requires a
real Redis instance; run it with:

```bash
CAO_SIMULATOR_REDIS_URL=redis://127.0.0.1:6379/0 \
  go test ./internal/server -run TestSimulatorExercisesGoServerWithRedis
```

The Redis-backed CI job runs this integration test as part of `go test ./...`.
For manual load runs, point the normal CAO server and worker at a local Redis
instance as well as the simulator API.

## Rate-limit stress harness

`internal/server/stress_test.go` drives the production HTTP handler (access
control, inbound rate limiting, and the lazy repository-memory resolver) with
real Redis and the simulator's fake GitHub API. It configures deliberately low
limits so every run exhausts them:

- **Inbound**: `Config.RateLimits` lowers the general policy to 50 requests per
  second and floods one endpoint. Admission must never exceed the token bucket,
  and every rejection must be a `429` with `Retry-After` and `RateLimit-*`
  headers.
- **GitHub primary limit**: the scenario `rate_limit` field (for example,
  `{"limit": 40, "window": "3s"}`) meters the fake API with a fixed-window
  budget and GitHub-style `X-RateLimit-*` headers. Cache-missing reads must
  stop at the governor floor so the simulator never rejects a request, and
  reads must resume after the window resets.
- **GitHub secondary limit**: a `secondary-rate-limit` window rejects the
  installation-token mint and, separately, REST calls behind a minted token.
  The server must park the installation, answer `429` with GitHub's
  `Retry-After`, and send no more than the in-flight requests upstream.

Each scenario also enforces a p95 latency budget and a throughput floor and
writes a JSON report. `BenchmarkStress*` benchmarks measure the throttled,
cached, and governor-exhausted paths with `-benchmem`. The tests skip unless
`CAO_STRESS_REDIS_URL` is set; use a disposable Redis database:

```bash
npm run dashboard:server:redis-up   # from the repository root
cd server
mkdir -p ../.tmp/go-stress
CAO_STRESS_REDIS_URL=redis://127.0.0.1:6379/0 \
CAO_STRESS_REPORT_DIR=../.tmp/go-stress \
  go test ./internal/server -run '^TestStress' -bench '^BenchmarkStress' \
    -benchmem -benchtime=2000x -count=1 \
    -cpuprofile=cpu.pprof -memprofile=mem.pprof \
    -blockprofile=block.pprof -mutexprofile=mutex.pprof -trace=trace.out \
    -outputdir=../.tmp/go-stress
go tool pprof -top ../.tmp/go-stress/cpu.pprof
```

`CAO_STRESS_MAX_P95_MS` (default 250) and `CAO_STRESS_MIN_RPS` (default 200)
override the thresholds. The `Go rate-limit stress and profiles` job in
`.github/workflows/cgo.yml` runs the harness in its own job and uploads the
`go-server-stress-profiles` artifact: per-scenario JSON reports, raw CPU,
allocation, block, and mutex profiles, an execution trace, `pprof -top`
summaries, and benchstat-compatible `bench.txt`. Compare `bench.txt` files
with `benchstat` and inspect profiles with `go tool pprof` or
`go tool trace` when optimizing the server.

## Architecture

```mermaid
flowchart LR
  Artifact["Deployed dashboard artifact<br/>inventory + run JSONL + record JSONL"]
  Ingest["Go ingester<br/>verify, parse, project"]
  Postgres["Postgres<br/>native entity tables"]
  Redis["Redis<br/>operational state"]
  API["Go HTTP(S) server<br/>bounded PostgreSQL SQL plans"]
  Browser["Dashboard browser app<br/>render bounded view payloads"]

  Artifact --> Ingest
  Ingest -->|"transactional replacement"| Postgres
  Postgres --> API
  Browser -->|"POST /api/v1/query"| API
  API -->|"source reads"| Postgres
  API -->|"sessions, queues, caches"| Redis
  API -->|"LogicalSourceInput JSON"| Browser
  API -->|"SSE revision events"| Browser
```

### Components

| Component | Location | Responsibility |
| --- | --- | --- |
| CLI | `cmd/cao-dashboard/` | Implements the `ingest` and `serve` commands and keeps Postgres and Redis configuration in the server process. |
| Artifact ingestion | `internal/ingest/` | Validates deployed manifests and hashes, streams run shards before record shards, and writes canonical rows through the native Postgres writer. |
| Query engine | `internal/query/` | Validates Dashboard Language definitions and compiles hosted query plans to bounded SQL. |
| Postgres entity storage | `internal/postgresx/` | Initializes fresh TypeSpec-generated tables and transactionally replaces native entities, quality metadata, diagnostics, and revision; executes query plans in repeatable-read snapshots. |
| Redis operations | `internal/redisx/` | Supports caches, queues, and sessions. |
| HTTP(S)/API server | `internal/server/` | Enforces loopback binding, optionally terminates operator-configured TLS, serves static dashboard assets, handles API requests, and publishes revision events. |
| Externally hosted service | `hosting/` | Exposes a listener-independent application lifecycle and the complete hosted HTTP handler to other Go HTTP hosts. |
| Azure Functions profile | `internal/server/azure.go` | Builds the same HTTP handler without starting a listener, validates Azure app settings, requires `rediss://` Redis, and trusts forwarded host/protocol headers only for configured Azure hosts. |
| GitHub OAuth sessions | `internal/server/oauth.go` | Implements the GitHub OAuth authorization-code flow, active organization/team authorization, refresh-token rotation, server-side encrypted sessions in Redis, logout revocation, and CSRF protection for mutating requests. |
| Shared API model | `internal/model/` | Defines logical sources, diagnostics, and query metrics. |
| Telemetry | `internal/telemetry/` | Configures OpenTelemetry trace, metric, and opt-in log providers, exposes the server's tracer, and writes W3C trace/span id response headers. |
| Local Redis | `docker-compose.yml` | Runs plain Redis on `127.0.0.1:6379`. |
| Coolify container profile | `Dockerfile`, `coolify/compose.yml` | Builds the dashboard and Go service into a non-root image and runs `serve-hosted` behind an explicitly trusted Coolify TLS proxy. |

### Host capability profiles

`internal/server/host_modules.go` independently resolves an app server target
module and a declarative Redis provider module. Their capabilities compose into
the profile validated by `internal/server/host_profile.go`. Target modules own
authentication, listener, HTTPS, and proxy behavior; Redis modules own
environment mappings, connection semantics, namespace isolation, replica
constraints, and collection support.

Hosted deployments normally declare these capabilities under
`control-plane.web.host` in `.github/workflows/cao.json`. The declaration names
environment variables for Redis connection and verified TLS inputs; secret
values remain in the deployment environment. New hosting platforms add a target
module without changing Redis providers; new Redis providers add declarative
environment defaults without changing target modules. `server.New` validates the
composed profile.
Do not add provider-name branches to shared authentication, proxy, ingestion,
or Redis enforcement. Startup rejects unsupported capability combinations, a
serialized profile backed by a pooled Redis client, collection on an
artifact-only profile, and process-listener settings on a platform-listener
profile.

The `generic` target also accepts `listener: external` for a Go host that owns
the HTTP server instead of CAO's `Serve` command. Use the public `hosting.New`
constructor with explicit paths to the built site and query documents, call
`Start(ctx)` before serving `Handler()`, then call `Drain()` to stop admitting
new requests and end SSE streams. Call the host's `http.Server.Shutdown` to
drain ordinary requests, then `Stop(ctx)` to cancel and await CAO background
tasks and close the hosted PostgreSQL pool. Pass a context with the host's
shutdown deadline; if it expires before tasks exit, the pool remains open and
`Stop` may be retried with a fresh context. Databases supplied to `server.New`
remain caller-owned. Keep the startup
context alive through HTTP shutdown. `Handler()`
includes all CAO authentication, trusted-host, CSRF, rate-limit, webhook, and
telemetry middleware; it returns `503` before startup or after drain.
There is no alternate raw router or automatic trust of an embedding host's
identity headers. The existing process-owned `serve-hosted` and Azure handlers
do not select this mode.

SSE streams share one PostgreSQL revision observation per replica while any
clients are connected. Authorized streams also share the Redis ingestion-health
observation. Each replica polls the durable state so updates originating on
another replica are delivered even without a local notification; local updates
are broadcast immediately. `Drain` still ends active streams.

`CAO_SSE_MEASURE=1 POSTGRES_URL=... go test ./internal/server -run
^TestSSEFanoutMeasurements$ -count=1 -v` measures connections, PostgreSQL
committed transactions per second (an approximate query-rate proxy), Go heap,
and stream drain against disposable PostgreSQL. On one local PostgreSQL instance
with a simulated Redis server, pre-change measurements for 1/12 clients on one
replica were 4/6 connections and 2.8/16.2 transactions per second; for 2/24
clients on two replicas, 7/8 connections and 5.0/28.4 transactions per second.
After shared observation, the same scenarios measured 4/5 connections and
3.6/5.8 transactions per second, and 7/8 connections and 5.6/9.4 transactions
per second. Heap after the 12-client and 24-client sampling windows was
2,615,304/3,364,256 bytes before and 2,102,776/2,840,400 bytes after.
Active-stream drain completed in 394/656 microseconds for 12/24 clients after
the change (the original harness only timed drain after closing its clients).
These are local observations, not performance budgets.
Generic OAuth targets cannot disable HTTPS in policy; Azure's explicit local
simulation is a separate platform-only case.

The external host must supply TLS or a private, explicitly trusted proxy
boundary, preserve request `Host`, direct peer address, TLS state, and
`http.Flusher`/response deadline control, and keep a long-lived
`/api/v1/events` stream outside finite whole-request timeouts. CAO's built-in
listener removes its ordinary write deadline only for that streaming route;
other routes retain bounded HTTP timeouts. A host's global request timeout
cannot be repaired by CAO after it cancels the request context. Use a dedicated
hostname: the browser's OAuth, API, and static paths are rooted at `/`.
Keep separate limits for concurrent streams, connections, and overall host
memory in the embedding deployment; CAO's Redis token buckets bound request
arrival, not the lifetime of an accepted stream.

## Hosted service profile

`serve-hosted` runs the same stateless Go service on a container, VM,
Kubernetes workload, or comparable host. It defaults to
`127.0.0.1:8080`, where a same-host or same-pod HTTPS proxy may forward requests.
A non-loopback listener is accepted only when `--cert` and `--key` configure
TLS at the CAO service itself. It is not coupled to a Redis provider or cloud
SDK. Set `CAO_POLICY_PATH` when loading a reviewed deployment-specific host
extension or when the policy is mounted somewhere other than
`.github/workflows/cao.json`. See
[`docs/deployment-managed-redis.md`](../docs/deployment-managed-redis.md) for
the generic `REDIS_URL` and TLS contract and provider modules.

Every hosted process requires `control-plane.web.host` in the composed policy. Redis
provider selection, TLS behavior, environment-variable names, namespace
selection, connection semantics, and replica count come only from that policy.
The selected environment variables hold secret values; they do not select or
override host behavior. Other hosted service inputs remain process environment
settings:

| Variable | Purpose |
| --- | --- |
| `CAO_ALLOWED_HOSTS` | Required comma-separated trusted public host names. |
| `CAO_TRUSTED_PROXY_CIDRS` | Required when a non-loopback `serve-hosted` listener relies on a TLS proxy. Only private CIDRs are accepted, and forwarded headers are rejected unless the direct peer is in one of them. |
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

### Upstash Redis provider

The `upstash` Redis module composes with the `container` target for Upstash
Redis's per-TCP-session causal consistency. It serializes every command through
one connection, never recycles that connection, disables transparent retries,
and permanently fails closed after transport loss. A process restart is required
to recover.

Every start derives a random internal namespace from `REDIS_NAMESPACE`.
This prevents state written through an earlier TCP session from reappearing
after restart, and deliberately invalidates existing OAuth sessions. Superseded
namespaces remain disposable data and consume capacity until an operator removes
them while the application is stopped.

This module requires exactly one application replica, a dedicated Upstash
database, artifact ingestion through `CAO_SOURCE_DIRECTORY`, and verified TLS.
Server-side collection and standalone collection roles are rejected. Policy
validation requires `target.replicas: 1`, and operators must set the hosting
platform itself to the same replica count. Do not configure the Upstash REST URL
or REST token. For the operator procedure, see [Deploying the dashboard with Upstash
Redis](https://github.com/githubnext/gh-aw-cao/blob/main/docs/deployment-upstash.md).

### Coolify container profile

Coolify is a peer deployment profile to Azure Functions; it does not replace or
modify the Azure Functions + Azure Managed Redis profile. The image reuses
`serve-hosted`, so GitHub OAuth, explicit organization/team authorization,
server-side encrypted sessions, CSRF checks, webhook signature verification and
deduplication, shared Redis rate limits, and secret-redacting logging remain the
same.

Build from the repository root:

```bash
docker build -f server/Dockerfile \
  --build-arg VERSION=0.0.0-alpha \
  --build-arg REVISION="$(git rev-parse HEAD)" \
  --build-arg CREATED="$(git show -s --format=%cI HEAD)" \
  -t cao-dashboard:test .
```

The official `.github/workflows/cao-package.yml` workflow publishes the same
image as `ghcr.io/githubnext/gh-aw-cao/cao-server`. Pushes to `main` receive an
immutable `sha-<full-commit>` identity; published releases receive their exact
Docker-safe semantic version tag. Use the resulting digest in downstream
Compose files. Multiple services can share that digest and select
`serve-hosted`, `collect`, `backfill`, or `doctor` through `command`.
Maintainers and administrators may also dispatch the workflow from current
protected `main` and provide an exact source branch through the required input;
these builds use a non-colliding `dispatch-<full-commit>` identity.
Publication is gated by Hadolint, actionlint, zizmor, Trivy, Grype, Dockle,
source tests, and protected-main ancestry. Syft produces an SPDX SBOM, and the
protected-main `.github/workflows/cao-package-publish.yml` reusable workflow
revalidates caller authority, source metadata, checksums, and OCI labels before
attesting both build provenance and the SBOM for the exact OCI digest.
Those package guarantees apply to consumers of the published image. The native
Coolify resource builds from repository source instead and does not use the
published package as its deployment input.

`server/coolify/compose.yml` expects:

- `CAO_ARTIFACT_VOLUME` as the name of an existing Coolify-managed volume;
- the public host and the exact private CIDR of Coolify's proxy network;
- OAuth, session, webhook, and Redis credentials supplied as Coolify secrets.

Configure the resource through the Coolify GitHub App, select protected `main`,
set the Compose file to `server/coolify/compose.yml`, enable automatic
deployments, and enable **Include Source Commit in Build**. Compose passes
Coolify's `SOURCE_COMMIT` to `server/Dockerfile` as the image version and
revision. The Dockerfile bakes `cao.json` and `cao.coolify.json` into the image,
so runtime policy bind mounts and **Preserve Repository During Deployment** are
not required.

The external artifact volume is authoritative input, not checked-in deployment
data. Before the first start, populate an unattached staging volume with a
complete `payload-hashes.json` and every referenced inventory, run, and record
file from a trusted dashboard build. Verify every manifest hash, then atomically
select that completed volume as `CAO_ARTIFACT_VOLUME` and deploy it; never copy
individual files into the volume attached to a running service. Apply updates
the same way with a newly staged volume.

The Compose file publishes no host port. Coolify's proxy is the only ingress
path. The app listens on the private service network, but accepts
`X-Forwarded-Host` and `X-Forwarded-Proto` only when the direct connection comes
from `CAO_TRUSTED_PROXY_CIDRS`; it still requires the forwarded protocol to be
`https` and the forwarded host to match `CAO_ALLOWED_HOSTS`. Startup fails when
the CIDR is absent, malformed, or public. Use the narrow subnet Coolify assigns,
not `0.0.0.0/0` or an entire RFC1918 range.

Use `rediss://` whenever Coolify or an external provider offers TLS. A
Coolify-managed Redis service may use plaintext only on the private service
network when `control-plane.web.host.redis.allow-private-plaintext` is `true`
and the endpoint uses a private service hostname or IP. This policy does not
affect Azure: Azure Functions continues to require `rediss://`.

The GitHub App webhook starts production delivery after a protected `main`
update. Coolify checks out that commit, builds the Compose service, and replaces
the running service after health evaluation. No GitHub deployment workflow,
Coolify API token, public Coolify API endpoint, Tailscale runner access,
registry credential, or mutable registry tag is required.

This simpler source-build path has a deliberate tradeoff: the deployed image
does not pass through the official package workflow's Trivy, Grype, Dockle,
SBOM, or GitHub provenance admission gates. Those checks and attestations still
protect the published `cao-server` package, but they are not production
delivery evidence for Coolify. Branch protection, restricted GitHub App
access, Coolify build isolation, and operator review of failed builds are the
source-deployment controls.

#### Rollback

Redeploy the last known-good entry from Coolify's deployment history, or revert
the responsible commit on `main` and let automatic deployment rebuild it.
Confirm `/api/readiness`, OAuth login and authorization, a bounded query,
webhook signature handling, and rate-limit behavior. Redis is disposable: if
the new binary wrote an unusable projection, clear only that deployment
namespace and rebuild from the retained trusted artifact. Rolling back source
does not roll back OAuth, webhook, or session secrets.

The hosted server exposes canonical repository/run APIs, verifies and
deduplicates webhook deliveries, and coordinates projection updates with a
Redis lease so multiple replicas do not rebuild concurrently. Webhooks trigger
authoritative re-ingestion; they are not treated as complete canonical records.
Validated webhook and rebuild requests return `202` before ingestion work
continues under a bounded, request-independent context. Only explicitly listed
administrators may call `POST /api/admin/rebuild`; it validates input and
atomically replaces current Postgres sources and state. A failed replacement
leaves the previous committed state intact.

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

### Request rate limiting

The HTTP server uses atomic Redis token buckets to enforce limits consistently
across replicas. Authenticated requests are keyed by a SHA-256 digest of the
GitHub login; OAuth login requests are keyed by a digest of the client IP, and
valid callbacks by a digest of their signed state. Forwarding headers are
considered only at the configured trusted-proxy boundary. Raw logins, client
addresses, and OAuth state are not stored in rate-limit keys.
Query requests reserve one cost unit before execution. Completed queries cost
the greatest of execution duration, measured operations and SQL input rows, peak
working rows, and estimated bytes. Structural complexity is bounded separately
and emitted as privacy-preserving telemetry. Cost is capped at the query bucket
capacity; the additional cost is charged atomically before the result is
returned.
Enterprise proxy boundaries may supply either `X-Forwarded-For` or RFC 7239
`Forwarded`; only the final value written by the trusted boundary is accepted.
Authenticated quotas are per GitHub login, and OAuth callbacks use their opaque
state cookie, so users sharing a corporate egress address do not share those
quotas. The normative contract is `specs/server-rate-limiting.md`.

| Request class | Capacity | Refill period |
| --- | ---: | ---: |
| Dashboard query (`POST /api/v1/query`) | 30 | 1 minute |
| OAuth entry and callback | 10 | 5 minutes |
| Other API and auth requests | 120 | 1 minute |
| Hosted pre-authentication edge | 1,200 per client IP | 1 minute |

Health/readiness probes are exempt. GitHub webhooks are exempt from user/API
quotas but use the high-capacity edge bucket before signature validation.
Hosted dashboard assets use that edge bucket so session loading remains bounded
without applying the tighter API quota to page loads.
Every limited response includes `RateLimit-Limit`,
`RateLimit-Remaining`, `RateLimit-Reset`, and `RateLimit-Policy`. An exhausted
bucket returns `429 Too Many Requests` with `Retry-After` in seconds. If Redis
cannot enforce a limit within two seconds, the request fails closed with
`503 Service Unavailable`. The edge bucket runs before session loading so
invalid, expired, and unauthenticated requests cannot bypass Redis enforcement.

### Hosted Azure architecture

> [!WARNING]
> The hosted Azure architecture is an experimental production-readiness profile,
> not a turnkey production certification. Treat the Bicep, OAuth policy, Redis
> topology, and Key Vault access model as a reviewed baseline that must be
> validated against your organization's Azure, GitHub, compliance, monitoring,
> incident-response, and data-retention requirements before live use.

The Azure Functions profile keeps the dashboard browser isolated from Postgres,
Redis, GitHub tokens, refresh tokens, database credentials, and Key Vault secret values.
The Function App is the only public application boundary and the only component
that talks to GitHub APIs, Key Vault references, Postgres, and Azure Managed Redis.

```mermaid
flowchart LR
  Browser["Authorized user's browser"]
  Edge["Azure HTTPS edge / App Service front end<br/>sets forwarded host + proto"]
  Function["Function App<br/>Go dashboard HTTP handler<br/>GitHub OAuth sessions + CSRF"]
  GitHubOAuth["GitHub OAuth + API<br/>login, refresh, org/team membership"]
  KeyVault["Azure Key Vault<br/>OAuth secret, session secret, Redis URL"]
  Postgres["Postgres<br/>current dashboard entities"]
  Redis["Azure Managed Redis<br/>TLS<br/>operational state"]
  Storage["Functions storage account<br/>runtime state only"]
  Insights["Application Insights<br/>non-secret operational telemetry"]
  Operators["Control-plane operators<br/>deploy Bicep + rotate secrets"]

  Browser -->|"HTTPS static assets + API + best-effort SSE"| Edge
  Edge -->|"trusted forwarded host/proto only when allow-listed"| Function
  Function -->|"OAuth code, refresh, membership checks"| GitHubOAuth
  Function -->|"Key Vault references resolved by managed identity"| KeyVault
  Function -->|"rediss:// operational commands"| Redis
  Function -->|"entity source reads/writes"| Postgres
  Function -->|"runtime binding state"| Storage
  Function -->|"no tokens, no Redis URL, no source records"| Insights
  Operators -->|"reviewed Bicep + secret rotation"| KeyVault
  Operators -->|"deploy package + app settings"| Function

  classDef boundary fill:#eef6ff,stroke:#0969da,stroke-width:2px;
  class Function,KeyVault,Postgres,Redis boundary;
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
- **Postgres**: stores the current dashboard entity sources and diagnostics;
  replacement is transactional, without generations or snapshots.
- **Redis**: stores operational queues, caches, and sessions, not
  dashboard entities.
- **Control-plane operator**: reviews Bicep/app settings, keeps Key Vault
  mandatory, rotates credentials, and validates compliance evidence.

Trust boundaries:

- Browser ↔ Function App: authenticated same-origin HTTPS with `Secure`,
  `HttpOnly`, `SameSite=Lax` session cookies and CSRF headers for mutation.
- Function App ↔ GitHub: server-side OAuth/token refresh/membership calls; no
  PATs and no GitHub tokens forwarded to the browser.
- Function App ↔ Key Vault: managed identity and RBAC only; no secret values in
  Bicep outputs, logs, checked-in parameters, or browser-readable state.
- Function App ↔ Redis: TLS-only `rediss://` and a deployment
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
   Issue, and Operational Value records through
   `dashboard/site/src/data/queries/database.json`.
6. Transactionally replace current Postgres logical sources, metadata,
   diagnostics, and revision state.

An ingestion with the same artifact revision can reuse current state.
Failure before commit leaves the previous Postgres state available.

The Postgres state also records an authoritative `evaluatedAt` timestamp
derived from the latest canonical row or source metadata timestamp. Relative
dashboard time windows use this value rather than browser wall-clock time.

### Ingestion profiles

Evidence reaches the server through exactly one of two profiles. They are
alternatives, not layers, because a canonical database has one writer.

| | Published snapshots (default) | Server collection (optional) |
|---|---|---|
| Evidence acquired by | `cao-activity.yml` in GitHub Actions | the server's collection workers |
| Server configuration | `CAO_SOURCE_DIRECTORY` | `CAO_COLLECT_APP_ID` and the other `CAO_COLLECT_*` settings |
| GitHub credentials | held by the workflow | a GitHub App held by the deployment |
| Event source | workflow schedule | webhook deliveries |
| Deployment | Function App only | Function App plus Container Apps workers |

The default profile is unchanged: with only `CAO_SOURCE_DIRECTORY` configured
the server behaves exactly as before and performs no GitHub collection.

Configuring both is rejected at startup rather than resolved silently, so a
deployment can never have two writers for one database.

To switch a deployment to the collection profile, unset `CAO_SOURCE_DIRECTORY`,
set the `CAO_COLLECT_*` settings, and deploy `collectorImage`. To switch back,
reverse both. Switching does not lose data: the canonical database is rebuilt
from whichever evidence the selected profile retains.

### Collection profile

Collection separates three concerns that fail differently:

1. **Admission.** The existing `POST /api/github/webhook` endpoint verifies the
   signature and atomically deduplicates the delivery, applies repository
   debounce, and appends one task to a Redis stream. A successful response
   therefore means durable admission. Admission is constant-time and takes no
   projection lease, so a delivery burst cannot block the endpoint.
   Signed `issues` lifecycle events for enrolled repositories enqueue
   repository collection rather than mutating stored issue entities directly.
2. **Collection.** Workers lease tasks and run the same
   `gh aw logs --audit` and `activity/cao.mjs` commands the Activity workflow
   runs, writing into the evidence lake. One repository is collected at a time,
   and GitHub budget is reserved per installation before each collection.
3. **Projection.** Collected evidence is projected by the existing
   `internal/ingest` package. Before finalizing the payload manifest, projection
   builds a temporary Activity database and runs the native Go
   operational-value orchestrator, whose output is equivalence-tested against
   `cao operational-value`. Campaign adapters remain shared JavaScript modules,
   invoked with one installation-scoped token per repository. Operational-value
   failure remains best-effort and does not block newer Activity evidence.
   Projection is coalesced behind a dirty flag and a minimum interval, so
   projection cost follows the collection rate rather than the event rate.

The evidence lake is laid out byte-compatibly with a snapshot published by the
Activity workflow:

```text
gh-aw-logs-shards/     collected, not yet compacted
gh-aw-logs-runs/*.jsonl
gh-aw-logs-records/*.jsonl
payload-hashes.json
inventory-sources.json
```

That is what makes the profiles interchangeable, and it is why cold start needs
no GitHub access: a retained lake is replayed directly.

Enrollment is derived from GitHub App installations. A delivery for a
repository outside the enrollment set is acknowledged and dropped rather than
collected, so credential reach never widens ingestion scope.

Rate limits are governed per installation. Each collection reserves budget
before it starts and passes the reserve to the collection subprocess, so the
subprocess stops before exhausting the installation. An installation that
receives a rate-limit response is parked with jitter; other installations keep
running.

Failed collections are retried with backoff and moved to a dead-letter stream
after the attempt limit, where they remain visible in collection status rather
than disappearing.

Collection is at-least-once. Retry, deferral, blocked-repository requeue, and
dead-letter transitions append their replacement before acknowledging the
leased entry in one Redis operation. Completed entries are acknowledged and
deleted atomically. The task stream is never `MAXLEN`-trimmed: its configured
limit applies admission backpressure, returning a retriable webhook failure
instead of discarding undelivered or pending work. The same configured limit
bounds the dead-letter stream by trimming its oldest diagnostic records.

### Collection roles

The same binary runs every role:

| Command | Role |
|---|---|
| `cao-dashboard serve-hosted` | serve the dashboard and admit webhook deliveries |
| `cao-dashboard collect` | lease tasks, collect repositories, and project |
| `cao-dashboard backfill` | cold start: replay the lake, enumerate installations, seed tasks |
| `cao-dashboard backfill --replay-only` | repopulate the database from retained evidence with no GitHub requests |
| `cao-dashboard doctor` | run a read-only, systematic check-up of Redis, canonical data, queries, and collection |
| `cao-dashboard otel-smoke` | verify that one live CAO request is indexed by OpenObserve without reporting credentials or trace identifiers |

`GET /api/admin/collection/status` reports enrollment coverage, shared collection queue
depth (including webhook and backfill tasks), in-flight tasks, cumulative
backfill run admissions, dead letters, cold-start phase,
and per-installation rate-limit headroom. Its `load` values (`webhook`,
`collection`, `failure`) are distributed event counts with a 60-second
half-life: one new event contributes 1, then its contribution halves each
minute without requiring periodic cleanup. They are estimates of recent
activity, not exact per-minute rates. The Ingestion dashboard compares
current outstanding work and cumulative backfill admissions as clearly labeled
horizontal bars and shows these loads to administrators. In the
default profile the endpoint reports `{"configured": false}` rather than
failing.
The existing Redis-backed ingestion counters remain available in the
administrator-only `collection-health` dashboard source; OTLP metrics do not
replace them.

### Diagnose a deployment

`cao-dashboard doctor` runs a read-only check-up of the current server
configuration. It does not contact GitHub, write to Redis or Postgres, repair data, or
report secret values. Every check has a stable identifier such as
`redis.memory` or `data.active`, a severity, observed facts, and an
operator remedy. The default text report is intended to be readable by both a
person and an agent:

```bash
go -C server run ./cmd/cao-dashboard doctor \
  --redis-url "$CAO_REDIS_URL" \
  --postgres-url "$CAO_POSTGRES_URL" \
  --redis-namespace production-dashboard
```

The standard check-up covers:

- build and runtime identity, external collection tooling, and profile
  exclusivity;
- Redis connectivity, latency, TLS posture, server state, clients,
  persistence, memory headroom, `noeviction`, and namespace contents;
- Postgres data age, schema compatibility, source counts, referential
  integrity, and duplicate identifiers;
- the canonical Dashboard Language query document;
- collection configuration without reading secrets, enrollment coverage,
  queue backlog, pending work, dead letters, cold-start state, rate-limit
  headroom, evidence-lake replayability, and projection activity.

Add `--deep` to read every current source through the production Postgres loading
path and confirm that rows decode, recorded counts match, and no source is
approaching the 200,000-row fail-closed limit. This can read every stored entity row, so it is deliberately opt-in.

```bash
go -C server run ./cmd/cao-dashboard doctor \
  --redis-url "$CAO_REDIS_URL" \
  --postgres-url "$CAO_POSTGRES_URL" \
  --redis-namespace production-dashboard \
  --deep
```

Use `--format json` for a versioned agent/automation contract. JSON and text
contain the same observations and stable check identifiers. The command exits
non-zero when any check fails; `--strict` also makes warnings non-zero, which
is useful as a deployment gate. Each check is bounded independently by
`--timeout` (10 seconds by default), so one unavailable diagnostic surface
cannot hang the whole report.

The report prints only a redacted Redis endpoint. It reports whether a webhook
secret or App private key is configured, never its value, and it only `stat`s a
private-key file rather than reading it.

### Verify OpenObserve ingestion

Run `cao-dashboard otel-smoke` inside the live CAO container after configuring
the standard `OTEL_*` variables. The command requests the local readiness
endpoint, confirms that the response carries valid trace and span identifiers,
checks the OpenObserve `/healthz` endpoint derived from the OTLP traces
endpoint, and polls the `default` trace stream for the emitted trace.

```bash
/app/cao-dashboard otel-smoke
```

Use `--trace-stream` when OpenObserve stores CAO traces outside `default`.
`--timeout` bounds the complete test and `--poll-interval` controls lookup
frequency. The command exits non-zero unless every stage succeeds. Its JSON
report contains only HTTP status codes and booleans; it never includes the
readiness URL, OTLP endpoint, authorization header, trace ID, or span ID.

### Collection settings

| Setting | Meaning |
|---|---|
| `CAO_COLLECT_APP_ID` | GitHub App identifier; unset selects the default profile |
| `CAO_COLLECT_PRIVATE_KEY` / `CAO_COLLECT_PRIVATE_KEY_FILE` | App private key in PEM form |
| `CAO_COLLECT_LAKE_DIRECTORY` | evidence lake directory, shared by workers |
| `CAO_COLLECT_CATALOG_ROOT` | directory containing `activity/cao.mjs` |
| `CAO_COLLECT_CONTROL_REPOSITORY` | control repository used for inventory discovery |
| `CAO_COLLECT_WORKERS` | in-process workers; zero when workers scale separately |
| `CAO_COLLECT_RATE_LIMIT_FLOOR` | requests reserved per installation |
| `CAO_COLLECT_PROJECTION_INTERVAL` | minimum interval between projections (default 5 minutes) |
| `CAO_COLLECT_INVENTORY_LIMIT` | optional cap on enrolled repositories; exceeding it fails the projection |
| `CAO_COLLECT_RECOVER_DELIVERIES` | replay failed webhook deliveries to close gaps |
| `CAO_COLLECT_QUEUE_MAX_LENGTH` | admission backpressure limit for outstanding collection tasks (default 200 000); tasks are never trimmed |
| `CAO_COLLECT_ADMIT_ONLY` | admit deliveries without collecting; requires no private key |

### Admission-only front ends

A process that only receives webhooks does not need collection credentials.
Setting `CAO_COLLECT_ADMIT_ONLY` verifies deliveries and enqueues work while
refusing an App private key, workers, and delivery replay, so the
internet-facing front end holds no credential it cannot use. The Azure Function
App is deployed this way; the collection workers hold the key.

Withdrawing scope still takes effect: an admission-only process queues erasure
for a worker that has the evidence lake, and administrative rebuild fails
closed with an instruction to run the `collect` or `backfill` role.

### Retention and erasure

The evidence lake is retained collected evidence, not a cache: cold start
replays it without contacting GitHub. Retention therefore has to be governed
deliberately.

Leaving ingestion scope erases evidence. When an installation is deleted or
suspended, or repositories are removed from it, the server deletes that
repository's shards from the lake and requests a projection, so the canonical
database stops reporting it. Uninstalling the GitHub App is the supported way
to withdraw consent, and it takes effect without operator action.

`specs/server-ingestion.md` is the normative contract, and
`adr/server-webhook-driven-ingestion.md` records why the design is shaped this
way.

### Cost and sizing

Steady-state ingestion cost scales with retained evidence; unchanged artifact
revisions may be skipped. Postgres stores only current entity sources and state,
not staging or rollback generations. Size Postgres for current source rows and
transactional replacement; size Redis separately for operational queues,
sessions, and caches.

The evidence lake is *many small per-repository shards*, so it is bound by file
metadata operations rather than throughput. The lake share therefore defaults
to a premium (provisioned SSD) file share; a Standard share's IOPS scale only
with provisioned size and become the projection bottleneck well before capacity
does. Set `collectorLakeStorageSku` to a `Standard_*` value only for small
deployments where cost matters more than projection latency.

Known limits, in the order they will be felt at scale:

- Every projection rehashes the whole lake twice before it can decide whether
  anything changed: once in `activity/cao.mjs hash-payloads` and once in the
  Go manifest validation. That is the structural ceiling on projection
  frequency, and it is why `CAO_COLLECT_PROJECTION_INTERVAL` defaults to five
  minutes rather than to seconds.
- Redis is still an always-on operational cost. Size it for queues, sessions,
  and caches. Size Postgres separately for current dashboard entity sources.
- The Elastic Premium Function plan is always-on. It is sized for webhook
  admission, which is constant-time, so the smallest plan that meets the
  tenant's network requirements is the right one.
- Collection workers do scale to zero: `minimumWorkers` defaults to zero and
  KEDA scales on stream backlog, so an idle deployment pays for storage, Redis,
  and the Function plan only.

## Entity and operational storage

Postgres stores the current dashboard entity sources as native typed fields,
alongside their metadata, canonical diagnostics, and one revision/evaluation
state. An ingestion replaces these atomically: failed transactions leave the
previous committed state untouched. There are no Postgres generations,
projections, or snapshots.
The editable representation is `spec/storage.tsp`; its emitter produces the
standalone `internal/postgresx/schema.sql` and matching Go bindings.
Eighteen entity tables retain query-consumed fields and identity/storage keys
only. Scalars use native SQL types; timestamps are returned as UTC RFC3339
strings. Nested scalar values are represented by generated columns in their
owning entity tables. No canonical JSON/JSONB or serialized documents are
stored, and canonical scalar rows are not copied into generic source/value
tables.
Startup only initializes this fresh schema. There is no old-layout detection,
conversion, backfill, or backward-compatible import. Use a new database and
re-ingest authoritative inputs when changing the physical contract.
Redis remains namespaced operational storage for caches, queues, sessions, and
it does not hold dashboard entity rows or query indexes.
Neither store grants control-plane authority. Credentials stay server-side.

## Query execution

The browser sends declarative query definitions and requested source names to
`POST /api/v1/query`. The server validates the query graph and resource limits
before loading data.
The validated query dependency graph is compiled to SQL and executed in
PostgreSQL. The Go server validates and binds the plan, enforces resource limits,
and serializes bounded results; it does not filter, join, aggregate, compute,
sort, or paginate rows. Missing/null, coercion, ordering, and resource semantics
are enforced by the SQL compiler and query engine. Unsupported definitions fail
closed rather than switching to another evaluator.
Execution fails closed when a requested plan exceeds 16 dependency levels, 256
derived queries, or 16 joins along one dependency path. Independent queries in a
batch do not consume one another's structural join allowance. Runtime guards cap
a query at 5 million row operations, 500,000 simultaneously referenced or
retained rows, 256 MiB of estimated working row data, and 512 MiB of estimated
retained row data. A retained-byte limit failure returns HTTP 422 with
`code: "query_plan_too_large"`, the failing `queryId`, and
`boundary: "retained_bytes"` alongside a readable `error` message. The response
does not expose the numeric boundary; other query limits remain independently enforced. Per-query
input, join, output, and operator limits remain independently enforced.
Expensive stages, including sorting, are charged against the operation budget
before they allocate or run.

The SQL engine reads current native entity tables from PostgreSQL and evaluates
Dashboard Language operators there. The Go server validates requests, binds
parameters, enforces resource limits, and serializes bounded results; Redis is
not a query backend.

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
<meta name="dashboard-data-backend" content="server-http">
```

into the dashboard HTML. The browser then uses the server API instead of
IndexedDB ingestion:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/health` | Public readiness reports database dependency and data availability; capability-authenticated requests can receive revision and source/row counts. |
| `GET /api/health` | Public health includes Redis and Postgres dependencies. |
| `GET /api/readiness` | Public readiness; returns 503 until current Postgres data is available. |
| `POST /api/v1/query` | Execute requested Dashboard Language queries and return bounded logical sources plus metrics. |
| `POST /api/v1/refresh` | Return the current revision and authoritative evaluation time without ingesting data. |
| `GET /api/v1/events` | Server-Sent Events stream that notifies active views when the data revision changes. |
| `GET /api/v1/diagnostics` | Canonical schema counts, relationship errors, and duplicate IDs from current Postgres data. |
| `GET /api/v1/github-quota/usage` | Administrator-only GitHub API quota usage for the last 24 hours: the peak observed usage of each bucket (App, installation, resource) and the limit-weighted aggregate per 15-minute slot. The same data is the `github-quota-usage` runtime source behind the Ingestion page chart. No credentials are included. |
| `GET /api/repositories` and `GET /api/repositories/:id` | Return canonical repository objects. |
| `GET /api/repositories/:id/runs` and `GET /api/workflows/:id/runs` | Return related canonical runs. |
| `GET /api/runs/:id/jobs`, `GET /api/runs/:id/sessions`, `GET /api/sessions/:id/events` | Return related canonical execution records when published. |
| `POST /api/github/webhook` | Verify, deduplicate, and reconcile a GitHub delivery. |
| `POST /api/admin/rebuild` | Force a staged full rebuild and atomic activation. |
| `GET /api/admin/rebuild/status` | Return shared rebuild state for all replicas. |

API responses use `Cache-Control: no-store`. The dashboard service worker
excludes `/api/` so query results and event streams are never placed in browser
caches.

### Cross-origin requests (CORS)

The dashboard is same-origin by default: the server emits no
`Access-Control-*` headers. The dashboard requests its web app manifest with
`crossorigin="use-credentials"` so the session cookie is sent, and the hosted
server answers unauthenticated subresource requests (any `Sec-Fetch-Mode`
other than `navigate`) with `401` instead of redirecting them to the
cross-origin GitHub authorize endpoint, which browsers block by CORS. Only
top-level navigations are redirected to `/auth/login`.

To let another reviewed origin read anonymous responses (such as the public
health endpoints), declare it in `control-plane.web.host.cors` in `cao.json` or
its host overlay:

```json
"cors": {
  "allowed-origins": ["https://tools.example.com"],
  "max-age": 600
}
```

CORS is credential-less by design. The server never sends
`Access-Control-Allow-Credentials`, so browsers refuse to expose any response
to a cross-origin request made with cookies. A listed origin therefore cannot
act as the signed-in user or read session data such as the CSRF token from
`/api/auth/session`. `allow-credentials` is not a supported field and is
rejected. Cross-origin integrations that need user data must use a
server-to-server path, not the browser session.

| Field | Default | Purpose |
| --- | --- | --- |
| `allowed-origins` | none | Exact origins echoed in `Access-Control-Allow-Origin`. Wildcards, `null`, paths, user info, and plaintext origins other than loopback are rejected; at most 32. |
| `max-age` | `600` | Preflight cache lifetime in seconds (1-86400). |

Preflights from listed origins are answered with `204` before authentication
and allow only `GET` and `HEAD` with the `Traceparent` header. Unlisted origins receive no CORS headers. CORS never
bypasses authentication, CSRF checks, or host validation. The normative contract
is `specs/server-cors.md`.

## OAuth sign-in troubleshooting

If the OAuth callback shows a sign-in error, select **Sign out and try again**.
This attempts the existing CSRF-protected logout (including server-side token
revocation). The signed-out page clears CAO session, CSRF and OAuth state
cookies and the dashboard IndexedDB cache, then offers an explicit sign-in
that requests GitHub's account chooser. Every CAO login requests account
selection, including login redirects after a failed session. CAO cannot clear
GitHub's own cookies: if GitHub shows only the existing account's permission
dialogue, use GitHub's profile menu to add or switch to another account,
then retry sign-in.

The older `{"error":"GitHub authorization failed"}` response corresponds to
an authorization failure; current versions show a help page instead. This
failure can mean the selected account is not an active member of an allowed
organization or team, or that GitHub membership could not be verified.
Try an authorized account, or ask your dashboard administrator to check the
allowed organizations and teams and your active membership. Do not send
OAuth callback URLs, codes, tokens, or cookies when requesting help.

If other open tabs block browser data deletion, close them and wait for the
signed-out page to finish before signing in. If logout cannot be confirmed,
the page keeps the error visible; clear this site's cookies before retrying,
or contact your dashboard administrator. Try a GitHub account that is an
active member of an organization or team permitted by the dashboard.
Signing in does not itself grant access.

The error page shows a request ID when tracing is enabled. Administrators can
search for that W3C trace ID in their OpenTelemetry backend and inspect the
`GET /auth/callback` span's fixed `error.type` classification. The same ID is
sent as `X-Trace-Id` on the response. Neither the page nor the span reveals
the OAuth code, state, credentials, account, membership details, or raw
provider errors. If no trace ID appears, configure an OTLP trace endpoint as
described below before expecting backend correlation; avoid sending callback
URLs, cookies, codes, or tokens when requesting support.

All generic server HTTP spans use a redacted copy of each request: the server
does not export peer/client IP addresses, user-agent strings, query strings,
arbitrary URL paths, W3C baggage, or client-provided tracestate. The original
request still reaches the authentication and rate-limiting code unchanged.
Raw user-agent strings may identify or fingerprint a browser, so they remain
excluded from telemetry rather than assuming their collection is GDPR compliant.
OAuth callbacks continue to use their own fixed-attribute span and extract
only W3C trace context, not baggage. Trace IDs are correlation identifiers,
not user identities. For GDPR-sensitive deployments, operators must also
limit collector/exporter access and retention, review any upstream proxy
logging and configured resource attributes, and avoid attaching identifiers
in custom instrumentation. This application-level minimization does not
certify the entire deployment's GDPR compliance.

## Telemetry

The server is instrumented with standard, vendor-neutral
[OpenTelemetry](https://opentelemetry.io/) tracing and metrics
(`internal/telemetry/`). HTTP requests other than `GET /auth/callback` are
wrapped with `otelhttp` using a redacted request, which supplies bounded
OpenTelemetry HTTP semantic-convention attributes and the standard
`http.server.request.duration`, `http.server.request.body.size`, and
`http.server.response.body.size` metrics. OAuth callbacks instead emit a
dedicated W3C-context-propagating server span named `GET /auth/callback` with
only fixed `http.route` and `http.request.method` attributes, plus
`cao_dashboard.auth.callback.count` (unit `{callback}`). Both the span and
counter use `cao_dashboard.auth.callback.outcome` (`success` or `failure`);
failures additionally use a fixed, bounded `error.type` (`invalid_state`,
`missing_code`, `provider_denied`, `exchange_failed`, `authorization_failed`,
`session_id_generation_failed`, `csrf_generation_failed`, or
`session_save_failed`). Only server-side failures mark the span as an error;
raw exceptions and provider error descriptions are never recorded. This
separate instrumentation avoids exposing callback request metadata. The callback
retains
`X-Trace-Id` and `X-Span-Id` correlation headers; no OAuth code, state, cookie,
token, login, provider message, query string, or other user identifier is
added to its telemetry. Authorization rechecks start a
`cao_dashboard.auth.revalidate` span before the protected request is served;
failed callbacks and rechecks emit `cao_dashboard.auth.decision` events and
`cao_dashboard.auth.decision.count` (unit `{decision}`). Only fixed
`cao_dashboard.auth.operation` (`callback_cleanup` or `session_revalidation`)
and `cao_dashboard.auth.outcome` values are recorded, distinguishing accepted,
rejected, concurrent, and failed rechecks from revoked, queued, or failed
callback credential cleanup. No account, membership, token, cookie, or provider
message is attached to these signals. The query engine and ingestion paths
start dedicated `cao_dashboard.query.execute` and `cao_dashboard.ingest.run`
spans. Every Postgres statement emits a child `cao_dashboard.postgres.query`
client span and `cao_dashboard.postgres.query.count` (unit `{query}`) and
`cao_dashboard.postgres.query.duration` (seconds) metrics. Duration measures
statement execution after acquiring a connection, not pool wait or row
decoding. Only fixed `db.operation.name` (`select`, `insert`, `update`,
`delete`, `copy`, or `other`) and `cao_dashboard.postgres.outcome` (`success`
or `error`) values are recorded; SQL, parameters, error messages, source
names, and database connection details are excluded. Existing pgx tracers
are preserved. The GitHub API quota service (`internal/githubquota/`) starts
`cao_githubquota.<operation>` spans (`observe`, `commit`, `reserve`, `release`,
`park`, `unpark`, `state`, `select`, `usage`) and records
`cao_githubquota.operation.count` and `cao_githubquota.operation.duration`
by operation, bucket App and resource, and a fixed `cao_githubquota.outcome`.
Per-bucket `cao_githubquota.bucket.remaining`, `.reserved`, `.available`, and
`.parked` gauges are keyed by App, installation, and resource. Reservation IDs,
tokens, and free-form parking reasons are never recorded. Its debug logs use the
`cao:githubquota` and `cao:redis:githubquota` namespaces. MCP requests use the OpenTelemetry MCP semantic conventions, including
`mcp.method.name`, `mcp.protocol.version`, `gen_ai.operation.name`, and
`gen_ai.tool.name`; tool arguments, results, session identifiers, untrusted
tracestate and baggage are never recorded. MCP methods are allowlisted and
protocol versions must have the standard date shape. Error spans use fixed descriptions
and bounded classifications rather than raw exception messages. Application
attributes are limited to non-secret aggregate counts, revisions, durations,
operation and row counts, rate-limit cost, and structural operator counts. Query
names, source names, fields, predicates, literals, route parameters, result
values, Redis URLs, credentials, GitHub tokens, and row contents are never
recorded. Identifiers follow the W3C Trace Context specification: the tracer
provider installs `propagation.TraceContext` so a client-sent HTTP `traceparent`
continues an existing transport trace. MCP spans use trace context from
`params._meta.traceparent` as their remote parent and link the ambient HTTP span. Every API
response also echoes the active request's ids as `X-Trace-Id` / `X-Span-Id`
headers for correlating a client-visible request with exported spans.
JSON error responses repeat those identifiers as `traceId` and `spanId`, and
the bounded server error log records the status plus the same identifiers.
Browser error views show only the trace ID as a request ID; they do not expose
span attributes, internal exceptions, query payloads, or storage details.

Telemetry uses standard OpenTelemetry SDK environment variables for exporters,
plus `CAO_OTEL_LOGS_ENABLED` for the additional log-export opt-in. Traces and
metrics are independently optional; logs additionally require that opt-in:

| Variable | Effect |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Enables trace and metric OTLP/HTTP exporters and sets their shared destination; also supplies the log destination when log export is enabled. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Enables the OTLP/HTTP trace exporter and sets its destination. Spans remain no-ops when neither this nor the shared endpoint is set. |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Enables the OTLP/HTTP metric exporter and sets its destination. |
| `CAO_OTEL_LOGS_ENABLED` | Set to `true` to export `DEBUG`-selected server log namespaces when a log endpoint is configured. Stderr behavior is unchanged. |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Log-specific OTLP/HTTP destination; takes priority over the shared endpoint and includes the complete `/v1/logs` path. |
| `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_TRACES_HEADERS`, `OTEL_EXPORTER_OTLP_METRICS_HEADERS`, `OTEL_EXPORTER_OTLP_LOGS_HEADERS` | Authentication headers read directly by the corresponding OTLP exporter. Supply them through the deployment platform's secret manager; never place values in command-line arguments, checked-in configuration, or logs. |
| `OTEL_SERVICE_NAME` | Overrides the default `cao-dashboard` `service.name` resource attribute. |
| `OTEL_RESOURCE_ATTRIBUTES` | Adds deployment-selected resource attributes; only configure reviewed, non-identifying values. Hostname detection is not enabled by default. |
| `OTEL_SDK_DISABLED` | Set to `true` to keep all providers as no-ops even when endpoints are configured. |

There is no Azure-specific exporter linked into the binary. To ship telemetry to
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
- Plaintext `redis://` URLs default to literal loopback IP addresses or
  `localhost`. Hosted mode additionally accepts a private IP or single-label
  service hostname only when the Redis module sets
  `allow-private-plaintext: true`.
- Every other remote Redis connection requires `rediss://`, standard
  certificate-chain and hostname verification, and TLS 1.2 or newer. Azure
  always requires this path. There is no insecure skip-verification option.
- Redis namespaces isolate this server's operational keys, but are not a
  substitute for dedicated Redis credentials with narrow ACL key patterns or a
  dedicated Redis database or instance.
- The HTTP(S) server sets content-type, frame, referrer, permissions, and
  cross-origin resource policy headers.
- Request bodies, query structures, row counts, output counts, and operation
  counts are bounded.
- Deployed artifact paths and SHA-256 hashes are validated before parsing.
- Static files are served only from the configured built-site directory, with
  SPA fallback to that directory's `index.html`.
- Missing Redis, Postgres data, manifests, shards, or diagnostics fail
  closed.

The local capability profile is not suitable for remote or multi-user
deployment. The capability authorizes its holder to read the full active
dashboard data; it provides no user identity or per-source authorization.

The Azure Functions profile is the experimental remote profile. It is enabled
by calling `NewAzureFunctionsHandlerFromEnv`; `serve` does not enable it. Azure
mode fails closed unless all of the following are configured:

- a readable `cao.json` with the `azure-functions` target and a Redis provider;
- the policy-selected Redis URL environment variable with a `rediss://` URL;
- the policy-selected Redis namespace environment variable;
- `CAO_AZURE_ALLOWED_HOSTS` and HTTPS forwarded-protocol enforcement;
- GitHub OAuth App client ID/secret and redirect URL;
- at least 32 characters of `CAO_SESSION_SECRET`;
- at least one explicit `CAO_GITHUB_ALLOWED_ORGS` or
  `CAO_GITHUB_ALLOWED_TEAMS` value.

For Linux-only local integration testing, the repository-owned harness starts
Azure Functions Core Tools, Azurite, and Redis and drives the Functions HTTP
surface without Azure credentials:

```bash
./scripts/azure-local/azure-local.sh run
```

See [`scripts/azure-local/README.md`](../scripts/azure-local/README.md) for
prerequisites, individual lifecycle commands, logs, process isolation, and the
local-vs-cloud test boundary. The harness sets the explicit
`CAO_AZURE_LOCAL_SIMULATION=1` seam, which permits only loopback plaintext Redis
and local HTTP. Without that setting, Azure mode continues to require
`rediss://` Redis and HTTPS exactly as production does.

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
from app settings and check Redis before serving requests.
Request cancellation propagates through `request.Context()` to Redis queries.

The Bicep deployment in `server/azure/main.bicep` provisions a Function App,
Key Vault, Application Insights, storage, and module-free Azure Managed Redis.
Every secret-bearing app setting—including Functions runtime storage—uses a
versionless Key Vault reference so ordinary credential rotation
does not require rewriting application configuration. Session-key rotation uses
the optional secure `previousSessionSecret` deployment parameter: deploy the old
key as previous and the new key as current, wait for active sessions and queued
revocations to drain, then remove the previous key. Encrypted records carry a
key identifier, and the server can read both keys during that window. The
template outputs only non-secret host names, redirect URI, Redis database name,
and Key Vault URI. Redis access keys
are an unavoidable path for Azure Managed Redis client authentication today;
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
- Treat the Postgres entity store as rebuildable from authoritative inputs. Compliance evidence
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
Colima, and the dashboard npm dependencies. Plain Redis runs only through
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

To inspect local traces and metrics, start the optional
[OpenObserve self-hosted instance](https://openobserve.ai/docs/getting-started/)
on `http://127.0.0.1:5080` via the separate `server/otel-compose.yml`.
It is not started by the Redis/Postgres Compose stack.
Set an email and a locally held password (8–128 characters with uppercase,
lowercase, digit, and special characters) before its first startup
(do not commit them or put them in command-line arguments):

```bash
read -rp 'OpenObserve email: ' CAO_LOCAL_OTEL_EMAIL
read -rsp 'OpenObserve password: ' CAO_LOCAL_OTEL_PASSWORD; echo
export CAO_LOCAL_OTEL_EMAIL CAO_LOCAL_OTEL_PASSWORD
npm run dashboard:server:otel-up
```

In the same shell, configure the Go server's OTLP/HTTP exporters before
running `serve` or `ingest`. OpenObserve requires Basic authentication and
uses signal-specific endpoints; the shared base OTLP endpoint would append
the wrong paths. The credentials are needed again after a restart to export
telemetry, even though OpenObserve only uses them for account creation on
first startup.

```bash
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:5080/api/default/v1/traces
export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://127.0.0.1:5080/api/default/v1/metrics
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic%20$(printf '%s' "$CAO_LOCAL_OTEL_EMAIL:$CAO_LOCAL_OTEL_PASSWORD" | base64 | tr -d '\n')"
export OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=local
go -C server run ./cmd/cao-dashboard serve
```

To exercise both exporters from the local Go server integration test (after
starting OpenObserve and setting the variables above in the same shell):

```bash
CAO_LOCAL_OTEL_INTEGRATION=1 go -C server test ./internal/telemetry -run '^TestLocalOpenObserveExport$' -count=1
```

The test skips during ordinary `go test ./...` runs; when enabled it fails if
either the trace or metric export is rejected or unreachable.

Sign in to OpenObserve with the same credentials and select the `default`
organization. The local instance stores data in the `openobserve-data` Docker
volume; `docker-compose -f server/otel-compose.yml down` stops it without
deleting that volume. Do not use `down -v` unless you intend to erase its data.
For hosted deployments, supply exporter authentication through the deployment
secret manager instead of exporting it from an interactive shell.

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

### Local MCP endpoint

The Go server can expose the dashboard's reviewed, read-only agent catalog and
named queries on the same listener:

```bash
go -C server run ./cmd/cao-dashboard serve --mcp-enabled
```

`/mcp` is not registered unless `--mcp-enabled` is present. Clients authenticate
with the same bearer capability as the local JSON APIs.

In GitHub Actions, `serve` also reads the standard `GITHUB_TOKEN` and
`GITHUB_ACTOR` environment variables. When both are available, an MCP client can
send the token in the bearer `Authorization` header and the actor in
`X-GitHub-Actor`.
The configured pair is accepted only at `/mcp`; it does not grant access to the
JSON APIs. Before enabling this gate, the server probes the current
`GITHUB_REPOSITORY` through `GITHUB_API_URL` and fails closed unless the token
can read Actions runs, contents, issues, and pull requests. Grant exactly these
permissions:

```yaml
permissions:
  actions: read
  contents: read
  issues: read
  pull-requests: read
```

Keep the token in the Actions environment rather than passing it on a command
line.

The endpoint exposes only `cao_catalog` and `cao_query`; it accepts no
SQL, arbitrary query definitions, refresh, rebuild, webhook, administration, or
repository mutation operations.

Hosted deployments can opt in with `serve-hosted --mcp-enabled`. This does not
expose the local bearer capability or grant access to other APIs. The hosted
`/mcp` endpoint accepts GitHub Actions callers with a bearer `GITHUB_TOKEN`
and a GitHub Actions OIDC token in `X-GitHub-OIDC-Token`. Mint the OIDC token
with `id-token: write` and the audience `https://cao.githubnext.com`; grant
the Actions token `actions: read`, `contents: read`, `issues: read`, and
`pull-requests: read`. The server queries the repository's default branch and
verifies the signed OIDC source ref and subject against it, along with repository
identity and the Actions token's repository read permissions, before
serving MCP requests. Keep both tokens in the Actions process environment,
never in a URL, commit, or log. Browser access continues to use the hosted
GitHub OAuth session.

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
the Runs, Workflows, and Repositories views render populated rows. It also
visits every declared dashboard page against the Go server and checks that
visible views and their Redis-backed HTTP queries resolve. CI uploads a
per-page report and posts the results to same-repository pull requests:

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
- **Redis dashboard integration** starts Redis, runs the Redis integration
  tests, builds the dashboard and server, ingests the deployed shard subset,
  launches the localhost HTTP server, and executes the Playwright view assertions.
