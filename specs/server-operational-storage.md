# Server operational storage

`server/internal/operational/` owns the provider-neutral operational contracts.
PostgreSQL is the default implementation, providing deployment-scoped
restart-persistent operational services without requiring Redis.
Redis and bounded volatile single-process memory remain explicit alternatives.
Its operational adapter MUST remain separate from the canonical dashboard
entity/query adapter, tables, namespace, schema generation, and lifecycle.

## Contracts and composition

`Store` exposes immutable per-feature capabilities, typed services, read-only
health, one bounded cancellation-aware maintenance pass, and close. The
application owns maintenance scheduling and MUST stop owned work before close.
`OperationalServices` separates backend lifecycle, cache, request limiting,
sessions, atomic session invalidation, revocations, leases, state, delivery
deduplication, task queue, atomic delivery admission, collection metadata,
GitHub quota, rate-limit state, health, and ingestion metrics. One backend MAY
implement multiple services; the split does not relax atomic transitions.
Only composition boundaries MAY consume `Store` and its
`OperationalServices()` bundle. Runtime consumers MUST retain the focused
contracts they actually use: OAuth separates sessions, atomic invalidation,
and revocations; collection separates metadata, leases, state, task queues,
delivery admission, deduplication, and metrics; the legacy rate-limit governor
separates rate-limit state from attribute reads. The obsolete `Services()`
bundle and aggregate OAuth, collection, quota, coordination, and diagnostic
interfaces MUST NOT be reintroduced as compatibility paths.
Shared adapter conformance MUST execute through these same focused services,
including transitions that span sessions and revocations or queues and delivery
admission. Raw Redis commands, physical keys,
streams, scripts, adapter assertions, and backend-name decisions MUST remain
inside adapters and construction/configuration code.

Each capability identifies unsupported, process-scoped, or deployment-scoped
coordination and volatile or restart-persistent state. Composition MUST reject
missing or typed-nil services and incompatible enabled requirements before
serving. Atomicity, compare-and-swap, owner-checked leases, isolation, context
cancellation, and explicit errors are required semantics, not optional flags.
A future backend MUST implement these contracts and their conformance tests;
it MUST NOT add backend branches to request, OAuth, quota, or collection logic.

### PostgreSQL operational adapter

`server/internal/operational/postgres/` implements every typed service. It owns
only `cao_operational_*` tables, not canonical entities or query execution.
Reviewed `operational-store.backend: "postgres"` selects it explicitly, and a
reviewed host with neither a selector nor legacy Redis configuration defaults
to PostgreSQL. An existing explicit Redis configuration MUST remain Redis;
credentials alone MUST NOT change selection.
`postgres.url-env` MAY reference a server-side connection secret; omission uses
`CAO_POSTGRES_URL`. Redis configuration and volatile-memory options MUST NOT
be combined with this backend. Non-loopback PostgreSQL TCP transport and all
fallbacks MUST use TLS. Selection MUST NOT change scope, enable collection,
move the canonical namespace, migrate existing operational state, provide
automatic fallback, or dual-write.

Transactions MUST use database time and serialize multi-record transitions and
accounting through the namespace row. Protected records and disposable caches
MUST have independent byte/entry bounds. Replica capacity configurations MUST
match the existing namespace; mismatch MUST fail startup. Session admission
MUST reserve capacity for atomic invalidation/revocation staging. Capacity
failures MUST roll back delivery identity, task append, and replacement
together. Expired sessions and leases MUST never grant authority. Accepted work,
enrollment, checkpoints, and pending revocations MUST NOT be evicted by cache
pressure or maintenance.

Blocking queue reads MUST release their transaction between bounded polling
attempts and honor cancellation. Maintenance MUST be application-owned and
bounded to at most 512 expired protected records and 512 expired cache records
per pass. Operational durability depends on the database's persistence
configuration; it does not reconstruct every external GitHub delivery.
Diagnostics MUST open existing state without creating tables or namespaces.
The shared conformance suite and real PostgreSQL cross-connection tests MUST
cover atomicity, isolation, capacity rollback, restart, and cancellation.

OAuth logout MUST remove active authority and stage encrypted credentials
atomically. Refresh MUST compare the encrypted session version and MUST NOT
resurrect a session superseded by logout. Conditional revocation completion MUST
not remove a newer record. Redis preserves its existing namespace, TTL, and
stable pending-revocation prefix contracts, including the Upstash restrictions.

Collection admission MUST atomically reserve capacity, consume delivery
identity, and enqueue or coalesce work. Full capacity MUST NOT consume the
delivery. Ready, leased, delayed, and dead-letter state MUST be bounded without
trimming accepted work. Replacement or delayed retry MUST commit before removing
the original lease, in one atomic transition. Delay MUST NOT block unrelated
ready work. Enrollment changes MUST serialize and preserve current ownership
when repositories transfer between installations.

## Volatile memory exception

Memory requires explicit `single-process` and `allow-volatile` acknowledgements
in reviewed host configuration. HTTP, OAuth, quota, collection workers,
projection, and backfill MUST share one instance in one process. Multiple
goroutines MAY process work, and enabled collection MUST configure at least one
co-resident worker. Multiple replicas, platform-owned listeners,
separate collector/backfill processes, and admission-only memory topology MUST
be rejected. OAuth, HTTPS, trusted-host/proxy validation, organization/team
authorization, explicit administrators, secure cookies, CSRF, signatures, and
quota governance remain mandatory.

All operational state is lost on restart: sessions, pending login state,
revocations, limits, enrollment, delivery deduplication, accepted unfinished
tasks, leases, quota reservations, and checkpoints. Old session/CSRF cookies
and OAuth callbacks MUST NOT restore authority. This invalidates CAO sessions;
it does **not** expire or revoke GitHub-issued tokens. GitHub revocation is
best-effort while the process lives and pending retries are lost on restart.

This is an explicit exception to restart durability and deployment-wide
coordination requirements in the durable ingestion and rate-limit
contracts. At-least-once admission/processing applies only within one process
lifetime. It is not a distributed or durable deployment. The evidence lake
remains persistent authoritative evidence, not an operational journal.

The adapter MUST bound cache accounting bytes and entries independently of
protected-state accounting bytes and entries. These are accounting budgets,
not allocator/RSS measurements. Disposable-cache pressure MUST NOT evict
protected state. Active limiter buckets MUST NOT be evicted to reset limits.
Session admission MUST preserve capacity for its atomic revocation transition.
Exhausted capacity MUST fail explicitly rather than silently discard work.

## Local launcher modes

`dashboard/local-server.mjs` has three explicit modes:

| Invocation | Runtime | Operational authority |
| --- | --- | --- |
| No `--operational-store` | Existing Node.js static/browser preview | No operational adapter, OAuth session store, collection worker, or server-owned canonical database |
| `--operational-store redis` | Process-owned Go `serve-hosted` | Resolved reviewed host policy selecting Redis |
| `--operational-store memory` | Process-owned Go `serve-hosted` | Resolved reviewed host policy selecting memory with every volatile-memory guard above |
| `--operational-store postgres` | Process-owned Go `serve-hosted` | Resolved reviewed host policy selecting the durable PostgreSQL operational adapter |

The selector MUST NOT rewrite, synthesize, or override rollout policy. The
requested backend MUST match the backend resolved by the production Go policy
loader, including deployment-profile imports. A mismatch, invalid backend,
missing policy, invalid topology, or missing required credentials MUST fail
closed. Legacy `host.redis` remains an explicit Redis selection;
neither Redis nor memory may become an
automatic fallback. PostgreSQL is the default for selector-free reviewed hosts.

`--policy PATH` selects an existing reviewed policy/profile and takes precedence
over `CAO_POLICY_PATH`, then `CAO_MARKETPLACE_POLICY_PATH`; the default is the
catalog's `.github/workflows/cao.json`. Relative paths MUST resolve against the
invoking working directory, not the Go module's directory. The selected path is
passed as `CAO_POLICY_PATH` to the child without mutating the parent's
environment. The Go loader remains the sole authority for profile composition
and configuration validation.

All Go modes require PostgreSQL for canonical entities and query execution,
the built dashboard, and the ordinary hosted OAuth and HTTPS/proxy protections.
The launcher MUST NOT substitute the legacy local bearer-capability profile
for hosted authentication. `--site`, `--host`, `--port`, and paired
`--cert`/`--key` MAY configure the built site and listener without relaxing those
protections. A direct TLS listener MUST use its actual TLS transport without
requiring forwarded headers unless trusted proxy CIDRs are explicitly
configured. A loopback listener without direct TLS retains the existing
trusted-proxy profile; an HTTPS-looking header from an untrusted peer MUST NOT
authorize access. Browser-preview-only canvas, artifact-download, replacement, and
trace flags MUST be rejected in Go mode; Go-only flags MUST be rejected in
browser mode.

The launcher builds into a temporary directory and launches the binary
directly, rather than leaving a detached `go run` child. Interrupt and
termination signals MUST reach the owned child. The launcher MUST await child
closure before removing its temporary executable, propagate unexpected build
or service failures, and remove its signal handlers on every exit path.
The Go application MUST cancel and join owned workers before store close.

## Restart and manual recovery

Before volatile collection can acknowledge scope-dependent deliveries or start
workers, it MUST reconstruct current scope from fresh GitHub App enumeration.
Enumeration MUST serialize with webhook enrollment mutations. Partial or failed
enumeration MUST keep admission retryable; absence from partial evidence MUST
NOT authorize erasure or an ignored out-of-scope response.

Complete enumeration MAY repair missed scope withdrawals by comparing prior
enrollment and identities read from retained raw shard contents. Filenames and
browser IndexedDB MUST NOT establish repository identity or authority. Erasure
MUST fail closed if raw shard identities conflict with each other or their
layout, or if current and retained identities collide under the lake's lossy
filename prefix, before scope mutation or destructive deletion. Erasure
MUST take the same owner-checked repository lease as collection. Retained
evidence is replayed through the existing projector and canonical ingestion.
Unknown quota MUST require fresh GitHub observations before spending capacity.

The ordinary protected administrative rebuild action MUST rerun full scope
reconstruction and backfill for a volatile collector even when its lake is
populated. Existing signatures, administrator checks, CSRF, and bounded
asynchronous execution remain unchanged. Backfill checkpoints advance only
after a page is admitted; capacity exhaustion or unavailable history MUST
report incomplete work, never successful truncation.

Recovery repairs current observable state and available workflow-run history.
It cannot recreate every historical webhook ordering, expired artifact,
lost revocation, or unavailable GitHub observation. Operators accepting memory
MUST accept these limitations. Memory has no disk journal, Azure orchestration,
automatic fallback, dual writing, or hidden PostgreSQL persistence.

Public health/readiness MAY expose provider-neutral capabilities and bootstrap
readiness, never keys, record values, credentials, or endpoints. The legacy
`redis.connected` response is retained as a deprecated compatibility alias for
the selected operational dependency; `operational` is the neutral health field.

## Formal model

[`tla/ServerOperationalStorage.tla`](tla/ServerOperationalStorage.tla) models
browser/Redis/memory selection, immutable policy matching, memory topology
guards, bootstrap-gated admission, bounded atomic delivery/task admission,
owner-checked work, admitted backfill checkpoints, session epochs, drain/close,
and restart. The Redis and memory configurations check safety and conditional
bootstrap/shutdown progress separately. The model preserves evidence across
both modes but deliberately permits loss of acknowledged unfinished work and
session authority when memory closes or restarts.

The bounded model is an abstraction, not a proof of the implementation or of
external GitHub availability, signature verification, encryption, TLS, storage
durability, complete historical replay, or retained-shard identity validation.
The PostgreSQL adapter is covered by implementation/conformance tests, not by
the Redis/memory selection model.
See [`tla/README.md`](tla/README.md) for bounds, assumptions, commands, and the
implementation/test correspondence.
