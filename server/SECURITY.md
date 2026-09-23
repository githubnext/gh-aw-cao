# Server security

The Go dashboard server is designed for local development and integration
testing. It processes private operational data and must not be exposed as an
internet service without an explicit remote-deployment security design.

## Supported security boundary

The supported deployment is:

- one trusted operator;
- one local checkout or worktree;
- an HTTP listener on loopback for debugging, or HTTPS with an
  operator-supplied certificate and key;
- a dedicated or access-controlled Redis database;
- dashboard artifacts obtained from a trusted local workflow or download;
- browser access through the capability URL printed by the server.

GitHub authentication, organization authorization, multi-user access, public
hosting, reverse proxies, tunnels, and webhook ingestion are not part of the
current security boundary.

## Dashboard access capability

The server protects every data API except the minimal health probe with a
bearer capability. Static application assets contain no dashboard records and
may be loaded without the capability.

- `serve` generates a cryptographically random access token unless an explicit
  token of at least 32 characters is provided with `--access-token`.
- The server prints an HTTP or explicitly configured HTTPS capability URL
  containing the token.
- Opening that URL writes the token to origin-scoped `localStorage` and removes
  it from the current address with `history.replaceState`, without navigation.
  This preserves access across ordinary page refreshes.
- Browser queries, diagnostics, refreshes, and the streamed revision request
  explicitly send `Authorization: Bearer <token>`.
- The server does not place the bearer capability in a cookie; loopback cookies
  are host-scoped rather than port-scoped and could leak to another local HTTPS
  service.
- Token comparisons use constant-time comparison.
- The unauthenticated health response contains only Redis connectivity and
  whether an active data generation exists. Counts, generation identity, and
  revision details require the capability cookie.

Treat the capability URL and browser session as credentials. Do not paste the URL into
issues, logs, screenshots, shell history shared with others, or browser
telemetry. Restart the server to rotate an automatically generated token.

## HTTP and TLS protections

- The listener must be `localhost` or a loopback IP address. Non-loopback bind
  addresses are rejected even when a certificate is configured.
- Requests with a non-loopback `Host` header are rejected, reducing DNS
  rebinding exposure.
- The server never generates certificates. HTTP is the localhost debugging
  default. When certificate and key files are supplied together, TLS 1.2 or
  newer is required.
- The HTTP server configures read-header, read, write, idle, and shutdown
  timeouts.
- API responses use `Cache-Control: no-store`, and the dashboard service worker
  excludes `/api/`.
- Responses set `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, `Permissions-Policy`, and
  `Cross-Origin-Resource-Policy`.
- Request methods and body sizes are bounded. Static files are constrained to
  the configured built-site directory.

The capability mechanism is local access control, not a replacement for
identity-aware authentication in a remote service.

## Redis transport and isolation

- Plaintext `redis://` connections are accepted only for `localhost` or a
  literal loopback IP address.
- Non-local Redis requires `rediss://` with normal certificate-chain and
  hostname verification. There is no insecure TLS mode.
- Redis usernames and passwords remain in the Go process and are never returned
  in HTML, browser configuration, API payloads, or query URLs.
- Every deployment uses a validated Redis namespace. The default is derived
  deterministically from the absolute checkout/worktree path, and
  `--redis-namespace` may supply an explicit deployment identifier.
- The namespace applies to active-generation pointers, revision counters,
  generation metadata, row sets, row hashes, and RediSearch indexes.

Namespace isolation prevents accidental collisions between local deployments.
It does not replace Redis ACLs. Use a dedicated Redis instance or database and
credentials restricted to the deployment namespace for separate trust
boundaries.

## Artifact ingestion protections

Ingestion accepts only the compacted deployed dashboard contract:

```text
payload-hashes.json
inventory-sources.json
gh-aw-logs-runs/*.jsonl
gh-aw-logs-records/*.jsonl
```

The ingester:

- rejects absolute paths, traversal paths, and raw Activity shard paths;
- validates every manifested SHA-256 hash;
- requires run-information shards before record shards;
- bounds JSONL scanner records;
- accepts only known canonical collections;
- validates and projects data before activation;
- stages an immutable generation and atomically changes the active pointer only
  after every source and diagnostic is written.

A failed ingestion leaves the previous active generation available.

Artifact hashes provide integrity relative to the manifest; they do not prove
the manifest's publisher identity. Obtain the artifact through a trusted
channel.

## Query protections

Dashboard Language queries are treated as untrusted structured input after the
capability check.

- The server validates query names, dependencies, join shape, operators,
  reducers, computed functions, and temporal-series definitions.
- Limits apply to definitions, joins, predicates, alternatives, aggregate
  values, source rows, output rows, body size, and total operations.
- Unsupported prediction queries fail closed.
- Invalid, cyclic, over-budget, stale-pagination, and unavailable-source
  requests return explicit errors rather than partial results.
- Compatible filtering, aggregation, sorting, and limiting are pushed into
  RediSearch; bounded Go execution handles residual operations.

The access capability authorizes the holder to query all data in the active
local dashboard generation. There is no per-source or per-row authorization.

## Secrets and logging

- Never place Redis credentials or the dashboard access token in committed
  files, dashboard documents, test fixtures intended for production, query
  payloads, or browser-readable metadata.
- Prefer environment variables or local command arguments supplied by a secret
  manager for Redis credentials.
- The server intentionally prints the local capability URL for the operator.
  Protect terminal logs accordingly.
- Error responses should describe request failures without including Redis
  credentials, raw RESP traffic, private keys, or complete source records.

## Validation

Security-relevant validation is included in:

- Go unit tests for listen and Host restrictions, capability bootstrap and
  authorization headers, unauthenticated API rejection, TLS certificates, Redis URL policy,
  namespace isolation, request bounds, ingestion integrity, and query budgets;
- golangci-lint with `gosec`, `bodyclose`, `contextcheck`, `errorlint`,
  `noctx`, and the standard correctness analyzers;
- the Redis-backed Playwright test in `.github/workflows/cgo.yml`.

Run:

```bash
npm run dashboard:server:lint
npm run dashboard:server:test
npm run test:e2e:dashboard-server
```

## Reporting a vulnerability

Report suspected vulnerabilities privately through a GitHub Security Advisory
for `githubnext/gh-aw-cao`. Do not include credentials, access tokens, private
dashboard data, or exploit details in a public issue.

Include the affected commit, deployment topology, reproduction steps, impact,
and whether the issue is reachable within the supported local-only boundary.
