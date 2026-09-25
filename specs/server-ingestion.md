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

It does not define dashboard presentation, workflow rollout policy, or durable
operational outcomes. It does not define the canonical data model, the shard
format, or the `gh aw` audit mapping: those remain owned by
`specs/activity.md` and `specs/dashboard-gh-aw-jsonl-mapping.md`.

This specification **conforms to** `specs/activity.md`. It supersedes nothing.
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
- An implementation MUST NOT maintain a second implementation of the canonical
  mapping, the shard format, or the payload-hash manifest.
- A conforming implementation MUST provide a profile equivalence test that
  asserts identical canonical records from an Actions-published directory and a
  server-collected evidence lake covering the same window.

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

## 6. The evidence lake

Collected evidence MUST be persisted in a durable **evidence lake**.

- The lake MUST use the Activity snapshot directory layout: compacted run shards
  under `gh-aw-logs-runs/`, record shards under `gh-aw-logs-records/`, a
  `payload-hashes.json` manifest, and `inventory-sources.json`.
- Shard writes MUST be atomic per repository: a reader MUST observe either the
  previous shard or the complete new shard.
- The manifest MUST be regenerated whenever shards change, and MUST list a
  SHA-256 hash for every shard it names.
- The lake MUST NOT contain prompts, tokens, secrets, or credentials.
- The lake MUST be sufficient to repopulate an empty canonical database with no
  GitHub requests.

## 7. Projection

Projection converts the evidence lake into an active canonical generation.

- Projection MUST reuse the Actions profile's ingestion implementation over the
  evidence lake directory. An implementation MUST NOT define a second projector.
- Projection MUST be coalesced: an implementation MUST collapse collections that
  complete within a configured debounce window into a single generation.
- A generation MUST be staged and then activated atomically. A failed projection
  MUST leave the previously active generation serving.
- Relationship errors and duplicate record identities MUST fail the projection
  rather than activate a generation known to be inconsistent.
- On successful activation the implementation MUST increment the revision and
  notify connected clients through the existing revision channel.
- Projection MUST short-circuit when the lake's content-addressed data revision
  already matches the active generation. A collection re-enumerates a window and
  usually adds nothing, so rewriting an identical dataset would be the dominant
  steady-state cost. An explicit operator rebuild MAY bypass this short-circuit.
- An implementation MUST reclaim superseded generations, retaining a bounded
  number for rollback and honouring a grace period so in-flight reads complete.
  Every projection writes a complete new generation; without reclamation a
  no-eviction store exhausts memory and every subsequent write fails.
- Inventory discovery MUST NOT silently truncate the enrolled repository set. An
  implementation MAY enforce a configured bound, but exceeding it MUST fail the
  projection rather than publish a partial inventory.

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

## 9. Gap recovery

An implementation MUST NOT rely on scheduled sweeps of the enrollment set as its
routine correctness backstop.

- After downtime or dead-lettered work, the implementation MUST recover missing
  events by listing App webhook deliveries from the last processed delivery and
  requesting redelivery of missing or failed deliveries.
- Per-repository enumeration MUST remain available for cold start and for
  operator-triggered repair.
- When a gap cannot be recovered, the implementation MUST record the gap in
  completeness metadata rather than present the window as complete.

## 10. Rate-limit governance

GitHub meters App traffic per installation. An implementation MUST govern budget
per installation.

- Installation tokens MUST be minted per installation, cached no longer than
  shortly before expiry, and never logged or persisted to the evidence lake.
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
- An erasure failure MUST fail the delivery rather than report it complete, so
  the delivery is retried instead of silently retaining evidence.
- The task and dead-letter queues MUST be bounded. Acknowledged entries persist
  until trimmed, so an unbounded queue grows with total event volume rather than
  with outstanding work.

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
  profile, Redis connectivity and safety posture, active-generation status,
  canonical integrity, query-definition validity, generation reclamation,
  and, when collection is configured, enrollment, queue, cold-start,
  rate-limit, evidence-lake, and tooling state.
- Each check MUST have a stable machine-readable identifier, severity,
  human-readable summary, observed facts, and a remedy for non-passing states.
  The same observations MUST be available in a versioned structured format.
- The check-up MUST NOT contact GitHub, mutate Redis, repair data, read secret
  contents unnecessarily, or report tokens, passwords, private keys, webhook
  secrets, payload contents, or prompts. Dependency checks MUST be bounded so
  an unavailable surface cannot hang the full report.
- Expensive checks that read the full active generation MUST be explicit and
  MUST use the production source-loading path and its fail-closed row bounds.

## 13. Conformance checklist

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
13. short-circuits projection for an unchanged lake, reclaims superseded
    generations, and refuses to publish a truncated inventory.
