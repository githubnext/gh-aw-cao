# ADR: Isolate dashboard call-table persistence behind a database boundary

## Status

Accepted

## Context

The Go dashboard server needs to ingest projected call-table data, validate
Dashboard Language queries, and execute queries against the currently available
data. Redis is the current persistence and query implementation, but its
generation identifiers, activation protocol, and indexes are backend mechanics,
not requirements of the server or ingestion contract.

Coupling ingestion and request handling directly to those mechanics would make
Redis part of the application contract. It would also make a future storage
implementation require changes throughout ingestion and server code rather
than implementing one defined boundary. At the same time, operational locks,
queues, state, and caches have different responsibilities and should not be
misrepresented as dashboard call-table records.

## Decision

The server uses `internal/dashboarddb.Database` as the boundary for dashboard
call-table ingestion and querying. The boundary accepts a set of `Transactions`
through `Ingest`, validates query definitions, and returns a `Reader` from
`Current`. A reader exposes the state of the data it selected and executes
queries against that same selected data, so a request can associate its
response with the revision it queried.

### Interface contract

The boundary consists of the following types and operations:

- `Transactions` is the complete input to one ingestion operation. It contains
  a content-derived `DataRevision`, its `EvaluatedAt` time, the named logical
  `Sources` and their rows, projection `Diagnostics`, and the
  `RepositoryMemory` manifest and `MemoryFiles`. These are application data;
  the interface does not prescribe how a backend stores or indexes them.
- `State` describes the selected database contents: `Revision` identifying the
  database version for query responses, content `DataRevision`, `EvaluatedAt`,
  per-source row `Counts`, and `Available` to indicate whether usable data has
  been ingested.
- `Database.Current(ctx)` selects a reader for the currently available data.
  It returns an error if the backend cannot select that data.
- `Database.Ingest(ctx, transactions)` ingests the supplied transaction set and
  returns the resulting `State`. It must make a complete ingestion visible
  atomically: concurrent readers must not observe partial transaction data.
- `Database.Validate(definitions)` validates Dashboard Language query
  definitions without performing a query or mutating stored data.
- `Reader.State()` returns the state associated with that reader.
  `Reader.Execute(ctx, definitions, requested, runtime)` executes the requested
  named query definitions against the same selected data and returns their
  named sources, query metrics, and any execution error. The reader remains
  pinned if a new ingestion becomes current while the query is running.
- `RuntimeSource` is an optional resolver for explicitly registered sources
  that are not stored in the database. Its return value includes the source,
  metrics, whether it handled the requested source, and an error. An unhandled
  source is resolved by the database backend.

These method contracts are intentionally expressed in terms of logical sources,
query definitions, and transaction data. Implementations own storage mechanics,
but must preserve atomic ingestion and the `Reader` state/query consistency
guarantee.

The contract describes the data and behavior required by ingestion and query
callers. It does not expose Redis keys, generation names, index definitions,
staging, activation, or reclamation operations. The current
`internal/redisx.DashboardDatabase` adapter implements the contract and owns
those Redis-specific mechanisms, including atomic activation and retention of
superseded generations.

The application constructs the database adapter and injects it into services
that use dashboard call tables. Redis operational stores and their locks,
queues, state, and caches remain separate from this database abstraction. This
decision does not add or promise a PostgreSQL implementation or a migration
path; any future backend must implement the same contract and its consistency
guarantees.

## Alternatives considered

### Keep ingestion and queries coupled to Redis

Rejected. This would spread Redis generation and index details into application
callers and make those implementation details harder to change independently.

### Expose Redis generations through a generic database interface

Rejected. Requiring callers to create, activate, or select generations would
preserve Redis's storage model in the purportedly backend-independent contract.

### Add a second database backend now

Rejected. The current need is to establish a clear boundary around existing
Redis behavior, not to introduce another persistence system or a speculative
cross-backend feature set.

## Consequences

- Ingestion and server query code depend on database behavior rather than Redis
  publication mechanics.
- The Redis adapter remains responsible for generation lifecycle, indexes, and
  atomic publication.
- A `Reader` provides a consistent data/revision view for queries using it;
  callers must use that reader for a request rather than combining results with
  a separately selected active generation.
- Operational Redis facilities remain owned by their existing services and
  are not part of the dashboard database contract.
- A future backend may be added behind the interface, but equivalence,
  consistency, and any migration behavior must be designed and validated for
  that backend rather than assumed by this decision.

## Validation

The contract and current adapter are exercised by the focused tests in
`server/internal/ingest`, `server/internal/redisx`, and
`server/internal/server`. The reader test verifies that a query uses the
selected snapshot rather than resolving active data again.
