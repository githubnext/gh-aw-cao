---
title: Central Agentic Ops Server Ingestion Specification
description: Normative requirements for the optional server-side, webhook-driven CAO evidence acquisition profile.
version: 1.0.0
status: Working Draft
editors:
  - GitHub Next
---

# Central Agentic Ops Server Ingestion Specification

**Version:** 1.0.0
**Status:** Working Draft
**Latest Version:** https://github.com/githubnext/gh-aw-cao/blob/main/specs/server-ingestion.md
**Editors:** GitHub Next

## Abstract

This specification defines an **optional** acquisition profile in which the CAO
server collects Activity evidence directly from a GitHub App, driven by
webhooks, instead of consuming a snapshot published by GitHub Actions.

It defines profile selection and exclusivity, enrollment, event admission,
collection, the evidence lake, projection, cold start, gap recovery, rate-limit
governance, authority, and failure behavior.

Its rate-limit governance applies to outbound GitHub API capacity. Inbound
dashboard request abuse protection is defined separately by
`specs/server-rate-limiting.md`.

It does not define dashboard presentation, workflow rollout policy, or durable
operational outcomes. It does not define the canonical data model, the shard
format, or the `gh aw` audit mapping: those remain owned by
`specs/activity.md` and `specs/dashboard-gh-aw-jsonl-mapping.md`.

This specification **conforms to** `specs/activity.md`. It supersedes nothing.
The implemented collection queue is specified in [Work Queue](work-queue.md);
that queue does not dispatch campaign workers.
Nothing in this document changes the obligations of the Actions profile.

## 1. Status and conformance

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT,
RECOMMENDED, MAY, and OPTIONAL are to be interpreted as described in RFC 2119.

A **conforming server ingestion implementation** satisfies every MUST in this
document. An implementation that does not implement this profile at all remains
conforming to CAO; this profile is OPTIONAL.

## 2. Profiles

CAO defines two acquisition profiles.

- The **Actions profile** is the default. Activity publishes an immutable
  snapshot directory, and the server ingests it. It is specified by
  `specs/activity.md` and is unaffected by this document.
- The **collector profile** is defined here. The server acquires evidence
  directly from a GitHub App.

### 2.1 Exclusivity

A deployment MUST select exactly one acquisition profile.

- An implementation MUST treat a configuration that selects both profiles as a
  fatal startup error.
- An implementation MUST NOT allow both profiles to write the same canonical
  dataset, concurrently or interleaved.
- When no collector configuration is present, the implementation MUST behave as
  the Actions profile, including its default reconciler.

### 2.2 Equivalence

Both profiles MUST produce identical canonical records for the same observation
window and the same underlying GitHub activity.

- The collector profile MUST acquire logs with the same `gh aw logs --audit`
  invocation and compact them with the same `activity/cao.mjs` commands the
  Actions profile uses.
- The collector profile MUST reconstruct retained operational-value observations
  with a native Go implementation conforming to
  `specs/operational-value-history.md`, using the same campaign adapter contract,
  retention window, historical campaign selection, and installation-scoped
  GitHub credentials as the Actions profile.
- An implementation MUST NOT maintain a second implementation of the canonical
  mapping, the shard format, or the payload-hash manifest.
- A conforming implementation MUST provide a profile equivalence test that
  asserts identical canonical records from an Actions-published directory and a
  server-collected evidence lake covering the same window.

### 2.3 HTTP host independence

The acquisition profile is independent of which process owns the HTTP
listener. When an external host serves CAO's handler, it MUST start the
selected ingestion profile before admitting requests and MUST allow CAO's
background work to stop only after the HTTP host has drained. The external
host MUST NOT bypass CAO's webhook verification or independently infer
collection scope from requests. The mutual-exclusion, enrollment, durable
admission, and recovery requirements in this document remain unchanged.

## 3. Enrollment

In the collector profile the ingestion scope is the set of repositories on which
the GitHub App is installed.

- The implementation MUST maintain a durable enrollment set of installations and
  their repositories.
- The enrollment set MUST be updated from `installation` and
  `installation_repositories` events and from cold-start enumeration.
- `cao.json` is rollout policy. An implementation MUST NOT derive ingestion
  scope from `cao.json` in this profile, and MUST NOT treat enrollment as
  authority to act on a repository.
- Enrollment coverage MUST be reported as source metadata so partial coverage is
  visible rather than rendered as a complete zero.

## 4. Event admission

The implementation MUST receive events on the existing CAO webhook endpoint.

- The endpoint MUST verify `X-Hub-Signature-256` in constant time, require
  `X-GitHub-Delivery` and `X-GitHub-Event`, bound the request body, deduplicate
  deliveries, and respond `202` before performing work. These obligations are
  unchanged by this profile.
- A delivery whose signature is invalid, whose installation is unknown, or whose
  repository is not enrolled MUST be rejected. An implementation MUST NOT infer
  enrollment from the payload.
- When the collector profile is selected, admission MUST enqueue a collection
  task and MUST NOT perform projection in the request path, and MUST NOT take a
  global projection lease.
- Tasks MUST be keyed by repository. An implementation MUST collapse multiple
  pending events for one repository into a single collection.
- Mutual exclusion MUST be per repository. Collection of one repository MUST NOT
  block or reject collection of another.

## 5. Collection

A collection task acquires evidence for exactly one repository.

- A worker MUST lease a task before collecting and MUST NOT collect a repository
  that another worker holds.
- A worker MUST bound each collection with a timeout, an output size cap, and a
  working directory it owns and removes.
- A worker MUST pass an explicit GitHub API rate-limit reserve to the collection
  subprocess so the subprocess fails closed rather than exhausting the
  installation.
- On failure a worker MUST retry with bounded attempts and jittered backoff, and
  MUST dead-letter a task that exhausts them. A failed task MUST NOT corrupt or
  partially replace a repository's existing evidence.
- A task whose retry time has not arrived MUST NOT be immediately reinserted and
  reclaimed in a hot loop. Workers MUST honor its not-before time or use an
  equivalent delayed-work mechanism; repository-lock contention MUST also be
  retried without consuming the collection attempt budget.

## 6. The evidence lake

Collected evidence MUST be persisted in a durable **evidence lake**.

- The lake MUST use the Activity snapshot directory layout: compacted run shards
  under `gh-aw-logs-runs/`, record shards under `gh-aw-logs-records/`, a
  `payload-hashes.json` manifest, and `inventory-sources.json`. A source-built
  collector MUST also retain the resolved `control-settings.json` and
  source-bound `control-plane-inventory.json` that produced those inventory
  sources.
- Shard writes MUST be atomic per repository: a reader MUST observe either the
  previous shard or the complete new shard.
- The manifest MUST be regenerated whenever shards change, and MUST list a
  SHA-256 hash for every shard it names.
- The lake MUST NOT contain prompts, tokens, secrets, or credentials.
- The lake MUST be sufficient to repopulate an empty canonical database with no
  GitHub requests.

## 7. Projection

Projection converts the evidence lake into the current canonical PostgreSQL
dataset.

- Projection MUST reuse the Actions profile's ingestion implementation over the
  evidence lake directory. An implementation MUST NOT define a second projector.
- Projection MUST be coalesced: an implementation MUST collapse collections that
  complete within a configured debounce window into one replacement.
- A replacement MUST commit all current sources, source documents, diagnostics,
  revision state, and evaluation time in one PostgreSQL transaction. A failed
  projection MUST leave the previously committed dataset serving.
- Relationship errors and duplicate record identities MUST fail the projection
  rather than commit a dataset known to be inconsistent.
- On successful activation the implementation MUST increment the revision and
  notify connected clients through the existing revision channel.
- Projection MUST short-circuit when the lake's content-addressed data revision
  already matches the current dataset. A collection re-enumerates a window and
  usually adds nothing, so rewriting an identical dataset would be the dominant
  steady-state cost. An explicit operator rebuild MAY bypass this short-circuit.
- PostgreSQL MUST be the only dashboard entity and query store. Redis MAY hold
  projection coordination and health state, but MUST NOT hold entity rows,
  canonical source documents, query indexes, persistent query projections, or
  execute dashboard data queries.
- Inventory discovery MUST NOT silently truncate the enrolled repository set. An
  implementation MAY enforce a configured bound, but exceeding it MUST fail the
  projection rather than publish a partial inventory.
- A source-built collector MUST generate its static control-plane inventory
  deterministically from the exact source revision during image build. Runtime
  inventory discovery MUST resolve the reviewed deployment policy, reject an
  unavailable policy resolution, replace only its repository scope with the
  exact Redis enrollment set, and enrich the source-bound inventory with a
  short-lived installation token for the control repository.
- The first canonical activation MUST fail when it cannot produce valid inventory evidence
  with at least one campaign. After one valid inventory has been retained, a
  transient policy, GitHub, or enrichment failure MAY reuse that previous
  inventory while projecting newer run evidence; an empty or malformed
  inventory seed MUST NOT qualify as a previous valid inventory.

## 8. Cold start

Cold start MUST be resumable and MUST report progress through the existing
administrative rebuild surface.

An implementation MUST support cold start in this order:

1. **Replay the evidence lake.** When a lake is present, the implementation MUST
   repopulate from it without issuing GitHub requests. This is the normal
   recovery path.
2. **Enumerate installations** and their repositories into the enrollment set,
   checkpointed per page cursor.
3. **Seed backfill tasks**, ordered so that recently active repositories become
   queryable first.
4. **Collect per repository** for the retention window, with a per-repository
   cursor, so an interruption loses at most one repository's in-flight work.

During cold start the implementation MUST continue to accept webhooks and MUST
apply them without loss or double application. Window completeness and
backfilled repository count MUST be published as source metadata.

An empty source-built lake MUST produce and retain valid inventory evidence
before its first canonical projection. A retained lake with valid inventory
evidence remains replayable without GitHub requests.

An explicitly configured historical backfill window MUST be sent as an
inclusive UTC `created=START..END` range to GitHub's run-list API; a provider
that cannot apply that range MUST fail closed. An unset window preserves
unbounded discovery. Windowed admission MUST NOT truncate retained lake replay.
Transient contention with a webhook-held enrollment mutation lease MUST wait
cancellation-safely rather than abort cold start. Enrollment ownership updates
MUST preserve transfer/withdrawal semantics when pipelined in bounded batches.
Checkpoint write failures MUST NOT be reported as successful backfill;
cancellation MUST persist a terminal failed state with bounded cleanup.

## 9. Gap recovery

An implementation MUST NOT rely on scheduled sweeps of the enrollment set as its
routine correctness backstop.

- After downtime or dead-lettered work, the implementation MUST recover missing
  events by listing App webhook deliveries from the last processed delivery and
  requesting redelivery of missing or failed deliveries.
- Recovery MUST persist pagination progress when a bounded pass cannot reach the
  prior delivery boundary, and MUST resume from that page before advancing its
  high-water mark. A failed redelivery request MUST NOT advance the mark beyond
  that delivery.
- Per-repository enumeration MUST remain available for cold start and for
  operator-triggered repair.
- When a gap cannot be recovered, the implementation MUST record the gap in
  completeness metadata rather than present the window as complete.

## 10. Rate-limit governance

GitHub meters App traffic per installation. An implementation MUST govern budget
per installation.

- Installation tokens MUST be minted per installation, cached no longer than
  shortly before expiry, and never logged or persisted to the evidence lake.
- Live inventory enrichment MUST use a short-lived token for the control
  repository installation and MUST pass the same explicit rate-limit reserve as
  other collector GitHub subprocesses.
- The implementation MUST maintain a per-installation budget corrected from
  `x-ratelimit-remaining` and `x-ratelimit-reset` on every response.
- A worker MUST reserve budget before starting a task and MUST stop at a
  configured floor rather than exhaust an installation.
- `Retry-After` and secondary rate-limit responses MUST park the installation and
  requeue with jittered exponential backoff.
- Enumeration SHOULD use conditional requests.

## 11. Authority and safety

- The GitHub App MUST be read-only. Ingestion MUST NOT write to any observed
  repository, and MUST NOT dispatch work.
- The App private key, webhook secret, and Redis URL MUST be resolved from a
  platform secret manager and MUST NOT appear in configuration files, workflow
  inputs, commits, logs, telemetry, or chat.
- A process that only admits deliveries MUST NOT be given the App private key.
  An implementation MUST support admitting deliveries without collection
  credentials, and MUST refuse a private key, workers, or delivery replay in
  that mode rather than accept an unusable credential.
- Prompts, tokens, and secrets MUST NOT be written to the evidence lake, the
  canonical database, or telemetry.
- Missing credentials, missing installation access, an exhausted rate limit, or a
  failed subprocess MUST fail closed. An implementation MUST NOT infer broader
  authority or present partial evidence as complete.
- A misconfigured collector MUST fail startup or degrade to the Actions profile.
  It MUST NOT degrade to a partial collector.

## 11b. Retention and erasure

The evidence lake is retained evidence rather than a cache, so retention is a
governed property and not an accident of disk usage.

- A signed `repository` delivery with action `created`, `deleted`, `archived`,
  or `unarchived` and a valid repository ID and installation MUST be admitted
  only for a repository already covered by that installation. Admission MUST
  durably queue an independent lifecycle update (without collapsing successive
  archive/unarchive transitions); the worker MUST serialize it with collection
  for that repository. The database MUST preserve the repository's immutable
  identity and lifecycle state across canonical projection replacements. A
  newly created enrolled repository MAY be inserted before its first snapshot.
  Deleted and archived repositories MUST be excluded from repository discovery
  while their retained historical rows remain queryable; unarchiving restores
  discovery. GitHub installation enumeration MUST skip archived repositories
  when scheduling historical collection without revoking their enrollment.
- Repository deletion or archiving is **not** withdrawal of the installation's
  authority. Retain evidence until its normal retention boundary. Maintenance
  MAY purge an inactive repository only after the configured retention window
  and after all referencing evidence and inventory rows have expired. Consent
  withdrawal (`installation.deleted`, `installation.suspend`, or
  `installation_repositories.removed`) still takes precedence and MUST erase
  evidence immediately under the rules below.
- Leaving ingestion scope MUST erase retained evidence. When an installation is
  deleted or suspended, or repositories are removed from it, an implementation
  MUST delete that repository's shards from the evidence lake and MUST request a
  projection so the canonical database stops reporting it.
- Erasure MUST be driven by the same webhook admission path as enrollment, so
  withdrawing consent takes effect without operator action. A process without an
  evidence lake MUST queue erasure rather than skip it.
- Removal MUST be scoped to the installation that currently covers a repository.
  A repository transferred between installations MUST keep its enrollment and
  its evidence when a later removal or deletion event arrives for the
  installation that no longer covers it; that event MUST clear only its own
  installation membership.
- The implementation MUST durably enqueue erasure work before removing
  enrollment, so a queue failure cannot make a withdrawal unrecoverable on
  delivery replay. Erasure work MUST be serialized with collection by the
  repository lease and MUST wait until the repository is no longer covered by
  the installation that requested removal. A worker MUST recheck current
  enrollment after acquiring the lease and MUST erase, rather than collect, an
  already-queued task for a repository that has left scope. Enrollment additions
  and removals MUST be serialized so the membership snapshot used to queue
  erasure is the same snapshot that is removed.
- A synchronous erasure failure MUST fail the delivery. A durably queued
  erasure MAY be acknowledged before completion, but MUST remain visible and
  recoverable until deletion and projection succeed; it MUST NOT be treated as
  completed merely because it was queued.
- Collection MUST be at-least-once. Retry, deferral, blocked-repository requeue,
  malformed-entry handling, and dead-letter transitions MUST persist the
  replacement before acknowledging the original in one atomic Redis operation.
- Future retry and deferral work MUST be durably scheduled outside the ready
  stream, promoted only when due, and included in queue capacity and depth.
  Workers MUST NOT wait synchronously on a future task while ready work remains
  available.
- A successful collection-webhook response MUST mean delivery deduplication and
  durable admission were committed atomically. Redis failures MUST return a
  retriable non-success response without consuming the delivery identity.
- A scope-withdrawal response MUST be sent only after each affected repository
  has either been erased or has a durable erasure task committed before its
  enrollment is removed. In the queued case the response confirms durable
  admission, not completed erasure; worker failures MUST remain retryable or
  durably dead-lettered and visible in health status.
- The task queue MUST apply bounded admission backpressure and MUST NOT trim
  undelivered or pending entries. Completed entries MAY be deleted after ACK;
  dead letters remain durably recorded under the configured bounded retention.

## 12. Observability

An implementation MUST expose collection status reporting at least enrollment
coverage, queue depth, processing lag, rate-limit headroom, and dead-letter
count.

- In the Actions profile the same surface MUST report that collection is not
  configured, and MUST NOT fail.
- Status MUST NOT include tokens, secrets, prompts, or payload contents.
- Collection acts unattended on customer repositories, so it MUST be traceable:
  enqueue, collection, dead-lettering, redelivery, and erasure MUST each record
  the repository or delivery they concern. A deployment MUST route these records
  and the process's telemetry to a durable sink.
- The server MUST provide a read-only check-up that reports the selected
  profile, Redis connectivity and safety posture, PostgreSQL readiness and
  revision state, canonical integrity, query-definition validity,
  and, when collection is configured, enrollment, queue, cold-start,
  rate-limit, evidence-lake, and tooling state.
- Each check MUST have a stable machine-readable identifier, severity,
  human-readable summary, observed facts, and a remedy for non-passing states.
  The same observations MUST be available in a versioned structured format.
- The check-up MUST NOT contact GitHub, mutate Redis, repair data, read secret
  contents unnecessarily, or report tokens, passwords, private keys, webhook
  secrets, payload contents, or prompts. Dependency checks MUST be bounded so
  an unavailable surface cannot hang the full report.
- Expensive checks that read every current PostgreSQL source MUST be explicit and
  MUST use the production source-loading path and its fail-closed row bounds.

## 13. Reliability simulator

The repository's `simulate-api` and `simulate-webhooks` commands are a local
validation tool for the collector profile. They MUST exercise the same GitHub
webhook endpoint, signature verification, delivery deduplication, durable queue
admission, worker coordination, collection runner, and projection code used in
production. The simulator MUST NOT add a bypass path to production handlers or
substitute an in-memory queue for Redis.

### 13.1 Scenario contract

Scenarios are strict JSON documents. Unknown fields MUST be rejected before
simulation starts. A scenario MUST have a name, a repository count between 1
and 50,000, and no more than 1,000,000 generated workflow/issue events combined. API windows
MUST have valid, increasing, non-overlapping `from` and `to` durations.

The supported scenario controls are:

- `seed` for repeatable event IDs, payloads, ordering, and distribution;
- `distribution`: `uniform`, `hot`, `long-tail`, or `synchronized`;
- `out_of_order`, `duplicate_every`, `drop_every`, `delay_every`, and `delay`
  for webhook delivery faults;
- `replay_count` to redeliver the most recent generated window using its
  original delivery IDs; and
- `remove_repositories` to emit a repository-removal event after workflow
  traffic; and
- `create_repositories`, `archive_repositories`, `unarchive_repositories`, and
  `delete_repositories` to emit signed lifecycle deliveries for the first
  synthetic repository. Unarchiving requires archiving. The fake GitHub API
  MUST represent the resulting archived/deleted state.

  An optional `history` object MAY generate 1-31 days with a positive
  `runs_per_day` and an explicit RFC3339 `as_of`. Historical generation MUST be
  bounded to five million run identities and generate API pages on demand.
  Installation, repository, and run pages MUST follow the production GitHub
  pagination contract, including the `created` time range.

  An optional `faults` list MAY configure the local reverse proxy by path, page,
  bounded request count, mode, and backoff. Faults MUST expire at their declared
  count. Supported proxy faults include 5xx, authorization, malformed JSON,
  connection loss, timeout, missing quota headers, and primary/secondary limits.
  `webhook_retry_limit` MAY enable bounded transient delivery retries; retries
  MUST reuse the signed delivery identity and be counted separately.

  All simulation HTTP transports MUST pin an exact numeric-loopback endpoint,
  disable environment proxies and DNS-based host selection, and reject redirects
  to other hosts/ports before dialing. Stress harnesses MUST create their own
  synthetic origins and ephemeral App keys, remove inherited GitHub credentials,
  and MUST NOT send simulated traffic to live GitHub APIs.

  The enterprise backfill workflow MUST exercise 1,000, 10,000, and
  50,000 repositories, at least one run per day, and a seven-day horizon.
  Signed webhook traffic MUST overlap backfill. Assertions MUST cover all durable
  run identities, exact counts, the time window, deduplication, and native
  Postgres queries; no in-memory queue or production-handler bypass is permitted.
  Diagnostic artifacts MUST retain bounded local OTEL traces, logs, and counters
  before teardown on success or failure. Aggregate backfill telemetry MUST carry
  fixed phase/count/window attributes, not credentials, prompts, source rows,
  or per-repository metric labels.

API windows select a behavior for elapsed scenario time. Supported modes are
`healthy`, `latency`, `timeout`, `connection-failure`, `rate-limited`,
`secondary-rate-limit`, `internal-error`, `bad-gateway`,
`service-unavailable`, `unavailable`, and `intermittent`. Intermittent windows
MAY set `failure_rate` or `fail_every`; rate-limit windows MAY set
`rate_limit_remaining` and `rate_limit_reset_after_seconds`. Outside a declared
window, the fake API MUST return healthy responses. `--time-scale` maps scenario
time to wall-clock time and MUST be positive and bounded.

`simulate-webhooks` MUST sign each request with the configured
`CAO_GITHUB_WEBHOOK_SECRET` and send it to the normal CAO webhook endpoint.
Installation and repository-add events MUST precede workflow events so the
normal enrollment checks apply. Duplicate and replay requests MUST reuse the
original delivery ID; explicitly dropped events MUST NOT be sent. Concurrent
request count and per-request timeout MUST be bounded.

### 13.2 API surface and operating limits

The fake GitHub API implements only the REST interactions needed by the
collector, including App validation, installation-token creation, rate-limit
inspection, repository lookup, and workflow-run/log requests. It MUST return
GitHub-shaped status codes and rate-limit headers for configured fault windows.
It is not a general GitHub API emulator, and passing a simulator scenario MUST
NOT be treated as proof of correctness against every GitHub API response.

The API URL MUST be routed through the normal collection runner into collection
subprocesses. A simulator run MUST use synthetic repositories, isolated test
credentials, and a test Redis instance; operators MUST NOT point it at live
repositories or expose the fake API listener to an untrusted network. The
simulator MUST NOT log webhook secrets, App credentials, or payload contents.

The simulator validates bounded-load admission, duplicate handling, selected
API fault responses, and recovery behavior through the real server path. It
does not establish production capacity or guarantee losslessness for failures
outside the exercised scenario; operators SHOULD measure queue depth, pending
work, dead letters, processing lag, and the collection-health status surface
during and after each run.

The Go server integration test MUST deliver signed scenario traffic through the
production webhook handler with a real Redis instance, then verify the health
API reports persisted webhook counters and queued recovery work. This test MUST
run in the Redis-backed server integration job; unit tests without Redis MAY
skip it.

## 14. Conformance checklist

A conforming implementation:

1. selects exactly one profile and fails startup when both are configured;
2. leaves the Actions profile's behavior unchanged when the collector is absent;
3. derives scope from App installations, never from `cao.json`;
4. admits and enqueues webhooks without projecting in the request path;
5. collects with the shared `gh aw logs --audit` and `activity/cao.mjs`
   implementations;
6. persists a snapshot-compatible evidence lake sufficient for cold start;
7. projects by reusing the Actions profile's ingestion implementation, coalesced
   and atomically activated;
8. recovers gaps by webhook delivery replay rather than routine sweeps;
9. governs GitHub budget per installation and fails closed;
10. passes a profile equivalence test against an Actions-published directory;
11. erases retained evidence for repositories that leave ingestion scope, and
    bounds its queues;
12. admits deliveries without collection credentials, and fails closed when an
    admission-only process is asked to collect or project;
13. short-circuits projection for an unchanged lake, transactionally replaces
    the current PostgreSQL dataset, and refuses to publish a truncated inventory.
