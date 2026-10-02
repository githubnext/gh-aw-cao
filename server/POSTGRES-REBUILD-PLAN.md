# Postgres ingestion and query-engine rebuild

## Decision

Use `spec/storage.tsp` as the sole physical storage contract and its generated
`internal/postgresx/schema.sql` as the standalone representation. Rebuild hosted
ingestion and query execution around native relational tables, then delete the
generic canonical/source machinery. This is a new project with a fresh database:
**no old-database migration, backward compatibility, dual writes, alternate
readers, or old-format fallback.**

This document is a follow-on implementation plan, not a claim that the complete
SQL engine has already been built.

## Starting point

The current change establishes eighteen query-minimal entity tables, native
scalar types, compact missing/null presence bits, and entity-owned relational
children. SQL DDL and Go column bindings are generated from TypeSpec. Canonical
scalar rows are no longer duplicated in generic storage, and no canonical
JSON/JSONB or serialized row documents are persisted. Initialization is
fresh-only.

The work still to replace is concrete:

| Surface | Current implementation | Replacement |
| --- | --- | --- |
| Ingestion | `internal/ingest/ingest.go` accumulates canonical row maps and logical sources before `Store.Replace` | Streaming, typed ingestion into the generated tables |
| Structured evidence | Entity-owned `*_values` trees and `ChildValue` | Explicit TypeSpec child models, typed relationships, or query-required scalar columns |
| Auxiliary data and metadata | `cao_sources`, `cao_source_rows`, `cao_values`, generic source names and metadata trees | Explicit typed inputs and minimal typed publication metadata |
| State and diagnostics | Generic count/error tables and presence sentinels | Required state/quality fields and SQL-derived diagnostics only |
| Hosted queries | `internal/postgresx/plan.go` handles a small scalar slice; `internal/query/engine.go` evaluates other shapes in Go | Complete Dashboard Language-to-SQL compilation and bounded SQL execution |
| Read APIs | Generic `SourceReader`, `LoadSource`, and `LoadDocument` | Generated table bindings, typed lookup methods, and compiled SQL result reads |

## Target rules

- One authoritative Postgres representation per entity; no generic canonical
  row store, EAV/tree codec, JSON documents, or stored report-derived copies.
- Retain only fields consumed by declared queries, relationships required to
  produce them, and necessary identity/publication state. Any added column must
  have a query or lifecycle consumer.
- Keep schema ownership in TypeSpec. Generate DDL, Go input/result bindings,
  column registries, and relationship/index declarations together; fail the
  build if generated output drifts.
- Treat the database as disposable derived state. Recreate it and ingest
  authoritative deployed inputs after a physical contract change; do not
  introduce conversion code.
- Queries, joins, calculations, grouping, filtering, ordering, and pagination
  execute in Postgres. Go validates, binds parameters, coordinates transactions,
  enforces limits, and serializes bounded results; it does not evaluate row
  operations or reconstruct business relationships.
- Preserve explicit empty, unavailable, partial, stale, zero, absent, and null
  states. Do not infer outcomes, graders, or value from successful execution.
- Preserve namespace isolation, server-side credentials, authentication,
  read-only GitHub authority, and atomic publication. Redis remains operational
  state, not a second canonical entity store.

## 1. Finish the relational contract

Inventory every database/view query and each API lookup against the TypeSpec
tables. Extend the existing field-coverage test to resolve complete query
lineage, not just direct database-source projections.

Replace `unknown` structured fields and `ChildValue` with explicit TypeSpec
models. Links, evidence references, experiment provenance, diagnostics, and
ordered evidence lists need typed child rows keyed to their entity. Flatten
query-consumed scalar attributes when that avoids an unnecessary join. Keep
order only where the query or wire contract requires it.

For opaque fields such as `data` and `logsPayload`, identify the actual consumed
attributes. Update declarative queries and their contract fixtures to request
those typed attributes instead of requiring an entire arbitrary payload. Keep
unqueried raw artifacts outside the canonical database and retain a typed
reference only if a declared detail surface needs it. Do not replace a JSON
document with another generic property/tree store.

Generate relationship constraints from TypeSpec, including mandatory parents,
optional associations, uniqueness, namespace scope, and bounded list ordering.
Use deferred foreign keys only where atomic ingestion ordering requires them.
Add indexes for demonstrated joins, drilldowns, search, ordering, or pagination;
do not index every optional field.

**Exit:** all current query inputs have explicit relational models, required
structured evidence has no generic tree representation, and schema/query
coverage rejects both missing fields and unused columns.

## 2. Rebuild ingestion

Replace `map[string][]model.Row`, merged logical-source maps, and generic
replacement with a typed ingestion writer generated from the storage contract.

Stream the existing manifested run-information shards before record shards,
validate records and deterministic identities, and hash inputs while reading.
Do not buffer a whole shard or lake. Use bounded batches and `pgx.CopyFrom`
for typed tables; use transaction-local staging where batch validation or
dependency ordering needs it.

Admit inventory observations through explicit typed adapters. Do not trust
inventory/report projections as substitutes for canonical run or experiment
evidence. Model required noncanonical inventory and repository-memory surfaces
explicitly, or resolve them through their existing operational/artifact
boundary; never persist arbitrary named logical sources.

Validate all manifested hashes, required parent relationships, duplicate
identities, and required evidence before publication. Publish entity rows,
quality metadata, fingerprint, evaluation timestamp, and revision in one
transaction under the existing per-namespace writer lock. Failure preserves
the preceding committed data. Re-ingesting unchanged inputs is deterministic;
forced ingestion retains its explicit revision behavior.

Readers retain their repeatable-read snapshot while a new publication commits.
Temporary staging is transaction-local and cleaned up; there are no persistent
generations, publication copies, or dual-format tables.

**Exit:** ingestion memory is bounded by batch size; canonical rows are written
once; missing shards, bad hashes, malformed fields, duplicates, or orphaned
records cannot publish a revision.

## 3. Rebuild the hosted query engine

Keep the declarative Dashboard Language request and validation boundary.
Compile its validated dependency DAG to typed SQL relations/CTEs using generated
table/column registries. Bind every value and namespace; never accept client SQL
or unchecked identifiers.

Implement the actual operator corpus: source aliases and unions, joins,
predicates and search, computed expressions, aggregates, temporal-series
operations, prediction operators that appear in declared queries, projections,
ordering, and limits. Make unsupported definitions a structured validation
error, not a switch to the Go evaluator.

Specify and test the semantics that ordinary SQL does not reproduce
automatically: missing versus null, `unknown` and optional predicates, numeric
coercion, empty aggregates, stable ordering, alias collisions, and union
ordering. Joins must preserve the declared one-match-per-key contract; duplicate
right-side keys must fail rather than multiply output silently.

Perform pre-filter input checks and enforce the existing per-query, dependency,
join, operation, working-byte, retained-byte, and output bounds. Add cancellation
and SQL statement timeouts. Stream bounded result pages; do not materialize
complete sources or paginate already-decoded Go row arrays. Preserve current
revision-bound continuation behavior and structured limit errors.

Explicitly registered operational runtime sources need typed, bounded SQL input
relations when participating in a query. They must not become generic persisted
canonical sources or a hidden alternate evaluator.

**Exit:** every declared hosted dashboard query executes as SQL; metrics identify
actual SQL work; unsupported or over-budget plans fail closed; Go performs no
row filtering, joins, aggregation, computation, sorting, or pagination.

## 4. Wire consumers and delete superseded machinery

Route `/api/v1/query`, canonical entity/detail handlers, MCP query tools,
readiness, diagnostics, doctor, collection projection, rebuild commands, and
query-cost benchmarks through the typed writer and SQL executor.

Preserve active-view revision subscriptions, SSE publication after commit,
bounded API payloads, and the current security boundary. Keep the static
browser worker as its own deployment profile; it is not a hosted fallback.
Any changed view payload contract must update its declarative query,
declaration, fixture, and production-boundary tests together.

Delete, rather than retain behind a flag:

- `cao_sources`, `cao_source_rows`, `cao_values`, and arbitrary source-name
  persistence; remove generic count/diagnostic scaffolding that no longer has
  a required consumer.
- Entity `*_values` trees, `ChildValue`, `valueBatch`, `valueNode`, `decodeTree`,
  generic row-position batches, and generic normalization/read helpers.
- `Store.Replace` over logical-source maps, source merging/projection helpers,
  generic `LoadSource`/`LoadDocument`, and the source-only evaluator adapters.
- The small-plan admission/fallback split and hosted use of the Go row
  evaluator in `internal/query/engine.go`; retain only necessary request
  vocabulary, validation, limits, errors, and SQL compilation support.
- Tests, benchmarks, and documentation that require generic storage,
  auxiliary compatibility readers, duplicate formats, or fallback execution.

Make these reviewable implementation commits on a single cutover branch.
Do not ship an intermediate compatibility switch or dual-read/write mode.
Deploy against a fresh database and ingest existing authoritative artifacts.

## Verification and completion gates

Run TypeSpec generation/coverage checks, Go build/lint/tests, fresh-Postgres
ingestion and SQL-query integration tests, server API/blackbox contracts, and
the production browser/server query-parity harness. Use the browser production
query boundary as an independent semantics oracle, not copied test-only
source synthesis.

Exercise representative and maximum-size graphs, sparse optional evidence,
large identifiers, timestamps, explicit nulls, duplicate join keys, empty
sources, pagination, cancellation, concurrent publication, failed ingestion,
namespace isolation, and restart/rebuild from an empty database.

Use the deployed query-cost benchmark and handwritten SQL comparisons to record
ingestion wall time/peak heap, database and index bytes, SQL/HTTP p50 and p95,
rows examined/returned, retained bytes, and Go allocations. Require the
complete declared corpus to compile and execute natively and investigate any
regression against equivalent typed SQL. Synthetic corpus coverage is not
production traffic coverage.

The final gates are **zero** stored JSON documents, generic canonical/EAV
tables, duplicate row formats, compatibility paths, and hosted Go row-evaluator
fallbacks; **all** declared hosted queries use SQL; publication remains atomic
and bounded; and generated TypeSpec artifacts match the deployed fresh schema.
