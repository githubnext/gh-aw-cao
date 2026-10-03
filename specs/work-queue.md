---
title: Central Agentic Ops Work-Queue Specification
description: Current durable collection work-queue contract and its boundary with campaign dispatch.
version: 1.0.0
status: Working Draft
editors:
  - GitHub Next
---

# Central Agentic Ops Work-Queue Specification

**Version:** 1.0.0  
**Status:** Working Draft  
**Latest Version:** https://github.com/githubnext/gh-aw-cao/blob/main/specs/work-queue.md  
**Editors:** GitHub Next

## Abstract

This specification records the **implemented** work queue in the optional
server-side collector profile. Redis Streams hold repository collection tasks;
a consumer group, delayed sorted set, and per-repository lock coordinate
collection workers. It refines the queue requirements in
[Server Ingestion](server-ingestion.md), which remains authoritative for
enrollment, evidence, projection, and the acquisition profiles.

The installed campaign control plane is a separate execution path: it directly
dispatches GitHub Actions workers and has **no durable Work/Claim dispatch
queue**. This document supersedes the *proposed* ledger-backed Work/Claim
architecture in [the Work/Claim ADR](../adr/work-claim.md) as a description of
current behavior. It does not implement or adopt the future PostgreSQL
coordination architecture proposed in
[State-Mediated Coordination](state-mediated-coordination.md).

## 1. Scope and terminology

The key words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as
described in RFC 2119. Requirements in this document apply only when the
collector profile is selected. The Actions acquisition profile has no Redis
collection queue.

- **Repository task:** one request to collect or erase evidence for a
  repository, or to apply a repository lifecycle update. It is not an agent
  request or a GitHub Actions workflow dispatch.
- **Ready:** an undelivered entry in the `collect:tasks` Redis Stream.
- **Pending:** a delivered but unacknowledged entry in its consumer group.
- **Scheduled:** a future task in `collect:delayed-tasks`, outside the ready
  stream.
- **Dead letter:** a task recorded in `collect:dead-letters` after retry
  exhaustion or malformed-entry handling.
- **Run task:** a separately admitted historical run identity in
  `collect:run-tasks`; it is not a collection lease or proof that artifacts
  were processed.

## 2. Durable records and admission

A repository task carries a normalized repository name, installation ID,
reason, enqueue time, retry attempt, optional not-before time, erasure flag,
repository ID, and lifecycle action. The repository is the coalescing key for
ordinary collection, **not** a guarantee that only one task for that
repository can exist at a time.

The admission path MUST validate scope against current enrollment. A verified
GitHub delivery MUST be deduplicated and either appended or coalesced in the
same atomic Redis operation that records its delivery identity. A failed
admission, including a capacity failure, MUST NOT consume that identity.
Ordinary collection events within the repository debounce window MAY
coalesce. After a worker acquires the repository lock and before it collects,
it MUST clear the debounce marker so new events can schedule follow-up work.
Lifecycle transitions and erasure MUST NOT be discarded by ordinary
collection debounce; successive lifecycle updates remain independent tasks.

The queue MUST apply admission backpressure without trimming ready or pending
collection work. The configured capacity counts ready-stream entries
(including pending ones) and scheduled work. Admission failure is not
successful delivery; callers must be able to retry it. Historical run tasks
use a distinct stream and durable uniqueness marker derived from normalized
`(repository, run ID, run attempt)`; they MUST NOT be coalesced by repository.
That marker prevents repeated backfill enumeration from admitting the same run
identity, but does not establish that the run was collected.

## 3. Leasing and execution

Workers MUST read previously undelivered entries through the `collectors`
consumer group (or a configured group) and MAY reclaim abandoned pending
entries after a minimum idle period. A delivered entry remains recoverable
until acknowledged; delivery and collection are **at least once**, not
exactly once. A crash or uncertain final acknowledgement MAY cause repeated
collection. Workers MUST NOT drop a leased entry merely because shutdown was
requested.

Before processing, a worker MUST acquire the per-repository lock. The lock
serializes collection, erasure, and lifecycle updates for one repository
while allowing unrelated repositories to progress. Lock contention MUST
reschedule the task without consuming a collection retry. After acquiring
the lock, the worker MUST recheck enrollment. An out-of-scope repository
MUST NOT be collected; erasure MUST respect current installation ownership
so stale removal events cannot delete transferred evidence. The worker
releases its lock with its own token after processing.

A completed task MUST be acknowledged and deleted from the ready stream.
Collection may request a coalesced projection after evidence changes;
projection is not performed during webhook admission. Lifecycle updates
can update the repository's database state independently of a collection
projection.

## 4. Retry and recovery

On collection failure, the queue increments the task's retry attempt. The
default maximum is five attempts; an exhausted task is dead-lettered with
its failure reason. Non-exhausted tasks receive jittered exponential
backoff and a not-before time. Future work MUST be stored in the delayed
sorted set and promoted to the ready stream only when due; it MUST NOT hold
a worker or block other ready work. Deferral and repository-lock contention
do not spend the collection failure budget.

Replacing a pending entry with a ready retry, scheduling it for later, or
dead-lettering it MUST persist the replacement before acknowledging and
deleting the original in one Redis operation. On a failed transition the
original remains pending and recoverable. Malformed task entries MUST be
dead-lettered before acknowledgement. A successfully completed collection
whose final ACK is uncertain MAY be reclaimed and repeated. None of these
transitions grants exactly-once external effects.

## 5. Capacity and observation

Queue depth is the consumer-group backlog plus scheduled entries; it excludes
already leased work when lag is known. Pending count and oldest pending age
are separate processing-lag signals. When Redis cannot report group lag
exactly, the implementation falls back to pending count rather than
reporting a misleading zero; depth is then an estimate, not an exact census.
Dead-letter count is the retained length of the dead-letter stream. Health
reporting MUST distinguish these signals and MUST NOT expose credentials or
task payloads.

The queue is operational state in Redis, not canonical dashboard entity
storage. Collection results become dashboard evidence only through the
evidence lake and the existing projection path.

## 6. Campaign dispatch boundary

Campaign orchestrators currently select bounded targets under the control
policy and invoke the declared `dispatch-workflow` safe output. GitHub Actions
accepts those dispatches; same-scope orchestrator and worker runs use
`cancel-in-progress: true`, so a newer run can supersede earlier work.
There is no persistent Work record, immutable Claim ledger, deterministic
Work/Claim reducer, or `cao-dispatcher.yml` in this path. Dispatch failure
does not enter the collector queue for retry. Later scheduled or authorized
manual orchestration re-evaluates current evidence instead of resuming the
earlier attempt. The collector queue MUST NOT be treated as authorization to
run campaign workers or as a substitute for the control policy.

The [State-Mediated Coordination](state-mediated-coordination.md) Working
Draft describes a *future* transactional Work/Attempt architecture, not
current conformance. Its PostgreSQL leases and fencing tokens, and the
superseded ADR's repo-memory ledger and immutable Claims, MUST NOT be
inferred from the Redis collection task queue.

## 7. Evidence and model review

The implementation is in `server/internal/collect/queue.go` and
`server/internal/collect/worker.go`; Redis transition scripts live in
`server/internal/redisx/stream.go`. Unit and Redis integration tests under
`server/internal/collect/queue*_test.go` cover debounce follow-ups,
concurrent delivery admission, backpressure, retry and dead-letter
transitions, reclaim, lock exclusion, scope withdrawal, and ambiguous ACK
recovery. These tests establish behavior for the exercised cases, not a
formal proof of liveness or exactly-once delivery.

No TLA+ model or model-checker configuration for either the collector queue
or Work/Claim dispatch is present in this repository. The state transitions
above are based on the current Go and Redis implementations and their tests;
this specification does not claim model-checked safety or liveness.
