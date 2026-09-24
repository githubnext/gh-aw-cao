# Server security

The Go dashboard server has two security profiles:

- the default local profile used by `cao-dashboard serve`, for one trusted
  operator on loopback; and
- the explicit Azure Functions profile, for remote access through GitHub OAuth,
  server-side sessions, Azure trusted-proxy headers, and Redis Enterprise.

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
local profile. Do not expose `serve` through a tunnel or public reverse proxy.

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

## Azure Functions profile

> [!WARNING]
> Azure Functions mode is experimental. It defines a security baseline for
> review and staged evaluation, not a blanket production approval. Keep the
> profile disabled for live use until the target tenant has completed security,
> compliance, privacy, network, monitoring, incident-response, and rollback
> reviews.

Azure Functions mode is enabled only by constructing the app with
`HostingModeAzureFunctions` or by using `NewAzureFunctionsHandlerFromEnv`. It
does not start its own listener, does not accept `--access-token`, and does not
support PATs. Requests are handled by the Azure Functions HTTP runtime and the
same Go dashboard HTTP handler.

Azure mode fails closed unless configuration includes:

- `rediss://` Redis transport and a Redis namespace;
- an explicit trusted host allow-list from `CAO_AZURE_ALLOWED_HOSTS`;
- HTTPS forwarded-protocol enforcement;
- GitHub OAuth App client ID, client secret, redirect URL, and a session secret
  of at least 32 characters; and
- at least one allowed GitHub organization or `org/team-slug` value.

The trusted-proxy policy is intentionally separate from local `Host` checks.
Local requests must still use loopback hosts. Azure requests may use forwarded
host/protocol headers only when the forwarded host exactly matches the
configured allow-list and the forwarded protocol is HTTPS.

### GitHub OAuth and authorization

Azure mode implements the GitHub OAuth authorization-code flow. It requests the
minimum `read:org` scope needed for active organization or team membership
authorization. Successful GitHub authentication alone is insufficient: the
server must verify an allowed organization or team membership before creating a
session. Do not add PAT handling to Azure mode; PATs bypass the required
browser login, refresh-token rotation, revocation, and explicit membership
authorization controls.

Access tokens and refresh tokens remain server-side. They are encrypted with an
AES-GCM key derived from `CAO_SESSION_SECRET` before being stored in Redis under
the deployment namespace. Browser cookies contain only an opaque session ID and
a CSRF token; GitHub tokens are never placed in browser-readable storage,
URLs, API responses, logs, telemetry, or Bicep outputs.

Session cookies are `Secure`, `HttpOnly`, and `SameSite=Lax`. Mutating
endpoints require the session-bound `X-CSRF-Token` header. The injected
dashboard bootstrap adds this header for same-origin browser requests.

When an access token is near expiry, the server uses the refresh token, stores
rotated token values, and continues the request. If refresh fails or the
refresh token has expired, the session is deleted, cookies are cleared, and the
client must reauthenticate. Logout revokes both the current access token and
the current refresh token when GitHub accepts revocation, deletes the Redis
session, and clears cookies.

### Azure lifecycle and transport limits

Cold starts rebuild the app from environment configuration, validate Redis
connectivity, and check RediSearch with `FT._LIST` before serving. Request
cancellation is propagated through `request.Context()` to Redis calls.

Health checks remain at `GET /api/v1/health`. Unauthenticated health responses
only report Redis connectivity and data availability. Authenticated sessions
also receive revision and count metadata.

Server-Sent Events at `GET /api/v1/events` are best-effort in Azure Functions.
The endpoint works while the platform keeps the invocation alive, but scale-in,
cold starts, idle timeouts, proxies, and plan limits can terminate long-lived
connections. Clients must continue to use `/api/v1/refresh` as the reliable
revision check. WebSockets are not part of this profile.

### Threat model

The Azure Functions profile assumes the following actors:

| Actor | Capabilities | Security expectation |
| --- | --- | --- |
| Authorized dashboard user | Opens the hosted dashboard and makes browser API requests. | Must authenticate through GitHub OAuth, satisfy explicit org/team authorization, send CSRF headers for mutation, and receive no Redis credentials or GitHub tokens. |
| Unauthenticated or unauthorized user | Can reach the public Function App URL. | Can read only minimal health status; all static dashboard access redirects to login and all data APIs fail closed. |
| Browser attacker | Can attempt CSRF, stale session reuse, URL injection, or token exfiltration through browser storage. | Session authority is in `Secure`, `HttpOnly`, `SameSite=Lax` cookies; CSRF tokens are session-bound; GitHub tokens and Redis URLs are never browser-readable. |
| Network attacker | Can observe or interfere with traffic outside Azure/GitHub TLS channels. | HTTPS-only Function App, TLS Redis, verified Redis certificates, and no plaintext remote Redis are required. |
| Azure platform/operator | Can deploy Bicep, configure app settings, rotate keys, and view platform metadata. | Uses reviewed Bicep, managed identity, Key Vault RBAC, non-secret outputs, and secret rotation procedures; does not copy secret values into logs, tickets, or checked-in files. |
| GitHub OAuth/API | Issues tokens and reports membership. | OAuth client secret remains in Key Vault, tokens remain server-side, refresh failures clear sessions, and membership is rechecked before session creation. |
| Redis Enterprise | Stores disposable projection rows, indexes, encrypted OAuth session records, and active-generation pointers. | Is not authoritative; data can be rebuilt from trusted dashboard artifacts; access is TLS-only and namespace-scoped. |
| Telemetry/diagnostics reader | Can view Application Insights and operational logs. | Sees only structured, non-secret operational metadata; no tokens, cookies, Redis URLs, prompt contents, source records, or secret values are logged. |

Protected assets:

- GitHub OAuth client secret, access tokens, refresh tokens, and membership
  authorization decisions;
- `CAO_SESSION_SECRET`, encrypted session records, session cookies, and CSRF
  tokens;
- Redis Enterprise URL/access key and namespaced dashboard projection;
- compacted dashboard source artifacts, logical source rows, diagnostics, and
  query results;
- Bicep, app settings, Key Vault RBAC assignments, deployment history, and
  telemetry used as compliance evidence.

Primary threats and mitigations:

- **Credential disclosure**: mitigated by mandatory Key Vault references,
  managed identity/RBAC, non-secret Bicep outputs, server-side token storage,
  AES-GCM encryption before Redis persistence, and no secrets in telemetry or
  browser-readable state.
- **PAT or bearer bypass**: mitigated by rejecting local bearer capabilities in
  Azure mode and documenting PATs as unsupported. Only GitHub OAuth plus
  explicit org/team authorization can create a session.
- **CSRF and session fixation**: mitigated by signed OAuth state, opaque session
  IDs, `Secure`/`HttpOnly`/`SameSite=Lax` cookies, per-session CSRF tokens, and
  session deletion on refresh failure/logout.
- **Untrusted proxy headers**: mitigated by an explicit
  `CAO_AZURE_ALLOWED_HOSTS` allow-list and required HTTPS forwarded protocol.
  The local profile keeps separate loopback `Host` protections.
- **Redis compromise or data confusion**: mitigated by treating Redis as
  disposable derived state, using TLS-only Redis Enterprise with RediSearch,
  namespacing every key/index, disabling Redis public network access in Bicep,
  and rebuilding from trusted artifacts when needed.
- **Long-lived connection assumptions**: mitigated by treating SSE as
  best-effort in Functions and requiring `/api/v1/refresh` polling as the
  reliable revision check.
- **Over-broad observability**: mitigated by logging only structured
  operational metadata and excluding tokens, cookies, Redis URLs, source
  records, and prompt contents from Application Insights and diagnostics.
- **Deployment drift**: mitigated by using checked-in Bicep as the reviewed
  contract, focused Bicep contract tests for Key Vault and platform security
  controls, and compliance review of Azure activity logs and Function App
  configuration changes.

Open experimental risks that must be accepted or closed before live production
use:

- Azure Functions cold starts, scale-in, and platform timeouts may interrupt
  long-lived SSE even when query/refresh endpoints continue to work.
- The Bicep template is a baseline and does not by itself prove tenant-specific
  network isolation, private endpoint reachability, cost limits, backup
  posture, data residency, or regulatory compliance.
- Redis Enterprise stores derived dashboard data plus encrypted sessions; an
  organization must validate whether its data classification permits that
  projection and retention model.
- The profile has focused automated tests and Bicep contract checks, but it
  still requires staged deployment, OAuth callback validation, key rotation
  exercises, logging review, and rollback rehearsal with the actual Azure
  tenant and GitHub organization.

### Azure secure-computing and compliance controls

Key Vault is mandatory for every secret-bearing Azure setting. The deployment
contract must keep the GitHub OAuth client secret, session secret, and Redis
`rediss://` URL in Key Vault and wire the Function App through Key Vault
references. Do not emit these values from Bicep, commit them in parameter
files, copy them into app settings as literals, or log them during deployment.

Use a system-assigned managed identity and Key Vault RBAC for secret reads.
Review Key Vault access policies/role assignments, Azure activity logs, and
Function App configuration changes as part of compliance evidence. Secret
rotation should happen through GitHub OAuth settings, Azure Redis/storage key
rotation, and new Key Vault secret versions, followed by a Function App restart
to resolve current references.

Keep the Azure secure-computing baseline enabled:

- HTTPS-only Function App, TLS 1.2 or newer, disabled FTPS, and no local bearer
  capability in Azure mode;
- Redis Enterprise encrypted client protocol, RediSearch module, disabled Redis
  public network access, and no Redis credentials in browser payloads;
- storage HTTPS enforcement and no public blob access for Functions runtime
  state;
- Key Vault RBAC authorization, soft delete, and no secret values in Bicep
  outputs; and
- Application Insights/telemetry with structured operational metadata only,
  never GitHub tokens, Redis URLs, session secrets, cookies, authorization
  headers, source records, or prompt contents.

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

For Azure, use Redis Enterprise with the RediSearch module and encrypted client
protocol. `server/azure/main.bicep` sets Redis public network access to
disabled and expects the Redis URL to be delivered through Key Vault-backed app
settings. Redis Enterprise client authentication currently relies on access
keys; do not output them. To rotate, regenerate the Redis access key, update
the `cao-redis-url` Key Vault secret with the new `rediss://` URL, then restart
the Function App so Key Vault references resolve the latest secret version.

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

- Never place Redis credentials, GitHub OAuth secrets, GitHub access/refresh
  tokens, session secrets, or the local dashboard access token in committed
  files, dashboard documents, test fixtures intended for production, query
  payloads, or browser-readable metadata.
- Prefer environment variables or local command arguments supplied by a secret
  manager for Redis credentials.
- In Azure, prefer Key Vault references in app settings. Bicep outputs must not
  include secret values or secret-bearing connection strings.
- The server intentionally prints the local capability URL for the operator.
  Protect terminal logs accordingly.
- Error responses should describe request failures without including Redis
  credentials, GitHub tokens, raw RESP traffic, private keys, or complete
  source records.

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
