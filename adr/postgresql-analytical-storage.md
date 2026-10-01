# ADR: PostgreSQL analytical storage and Redis operational state

## Status

Accepted; migration is staged and PostgreSQL is not a hosted default.

## Context

The hosted Go server currently uses Redis for both the canonical dashboard
projection and operational coordination. Dashboard Language has a normalized
logical plan and a canonical Go engine, while Redis-specific query execution
continues to accumulate physical query behavior. Replacing Redis wholesale
would also move sessions, quota reservations, rate limits, webhook deduplication,
leases, queues, and other short-lived coordination state that Redis already
handles.

The browser's IndexedDB and the local Activity SQLite projection are independent
rebuildable stores and are outside this migration.

## Decision

- PostgreSQL is the target durable store for canonical analytical snapshots and
  hosted Dashboard Language query execution.
- Redis remains the operational store for sessions, OAuth state, distributed
  rate limiting, GitHub quota reservation, webhook deduplication, leases,
  streams, caches, and coordination.
- `query.Normalize` remains the logical planner and semantic boundary. Physical
  SQL compilation must consume that normalized plan and preserve the Go engine
  as the reference and exact fallback.
- A snapshot is fully staged and validated before a transaction changes the
  active pointer. Failed writes or activation leave the previous snapshot
  readable. Reclamation retains older snapshots for rollback and in-flight
  readers.
- Source rows retain their complete JSONB document so omitted `select` results
  preserve unknown and future fields. SQL identifiers and values must never be
  constructed from unchecked query text; runtime values use parameters.
- The PostgreSQL backend may not serve hosted query responses until query
  coverage, differential parity, resource bounds, operational deployment,
  shadow comparison, and rollback have been implemented and validated.
- Existing Redis analytical storage is retained during the migration and remains
  the active hosted backend until those gates pass. No Redis operational
  primitive is removed as part of this decision.

## Current implementation boundary

The repository currently contains backend-neutral analytical interfaces and a
PostgreSQL snapshot store with versioned schema initialization, bulk row `COPY`,
validation, transactional activation, and cleanup. The SQL executor supports
only an unmodified source read. Ingestion dual-write, hosted backend selection,
full SQL compilation, differential parity, deployment provisioning, and
benchmarks remain follow-up work; the present implementation is a foundation,
not a completed cutover.

## Consequences

- A PostgreSQL connection failure cannot be hidden by silently switching
  databases; callers must treat it as a backend failure.
- Redis availability remains required by current hosted deployments because the
  active server and its operational state still depend on Redis.
- The migration proceeds through dual-write and shadow validation before any
  production read switch. The rollback backend remains available until the
  production migration is explicitly completed.
- PostgreSQL's standard connection string, pool limits, and TLS options are
  owned by deployment configuration, not hard-coded to a provider.
