# CAO Activity

CAO Activity is the shared, bounded `gh aw logs` collector for Central Agentic
Ops. It is deterministic GitHub Actions infrastructure: it has no agent,
rollout mode, safe-output, target-writing, indexing, or reporting authority.

The scheduled and manually dispatchable `CAO Activity` workflow checks out the
control repository, restores the latest compatible log cache, and runs one
bounded `gh aw logs --audit --artifacts usage --repo OWNER/REPOSITORY` command
for each repository in the distinct union of the control repository and the
allowed repositories resolved from `cao.json`. `cao.json` bounds collection; it
does not declare runtime workflow or run identities. The collector then ingests
the JSONL shards through the canonical Node.js data pipeline and consolidates
them for publication. Before log collection, it also enumerates each resolved
repository's paginated GitHub Actions workflow registry. Those registry rows
provide workflow paths, names, active or disabled state, and links; target-owned
workflows remain standalone and never become CAO campaign workers or rollout
authority. Per-repository registry failures are published as partial or
unavailable source evidence rather than complete empty inventories. It uploads
the completed snapshot as a one-day artifact.
A dependent job downloads
that artifact, verifies every snapshot file is present and non-empty (Drain3
weights only when the run shards contain records), and
publishes the source JSONL and its local SQLite projection to the shared cache,
keeping cache-write permission out of the collection job. An incomplete
extraction fails that job instead of silently skipping the cache save, which
would strand consumers on a cache miss.

For a fresh installation whose exact `allowed-repositories` scope contains
only the control repository, Activity uses the job's `GITHUB_TOKEN` without
any additional secrets or variables. An unset `GH_AW_GITHUB_AUTH_MODE` or an
explicit `workflow-token` selects this repository-local path. It reserves
100 core API requests for both log and operational-value collection, fitting
the standard workflow-token quota. A repository with no agentic runs still
publishes an explicit empty snapshot. Broader repository or owner-wide scopes
require explicit `app` or `pat` authentication; missing credentials in those
modes fail closed rather than falling back to the workflow token.

For a bounded manual smoke run, dispatch `cao-activity.yml` with `fast=true`.
It keeps the same resolved repository scope, credentials, 30-day raw retention,
and cache byte budgets, but requests at most 10 runs per repository, limits
downloads to 100 MB and the timeout to 5 (instead of 1200 MB and 15), and collects
detailed evidence for only the newest day. It preserves retained operational-value
history without computing new measurements. Scheduled runs and dispatches without
this input retain normal collection behavior. Fast mode still performs inventory,
visibility checks, ingestion, normalization, snapshot verification, and cache
publication; it is not a full-history refresh.

The independent `force-recycle=true` dispatch input adds a maintenance pass over
restored raw shards before collection and before index fragment download. It uses
the normal 30-day/byte limits and clears only disposable normalization `.payloads`
caches, which are rebuilt on demand. It does not erase retained run evidence or
change collection authority. For example:

```sh
gh workflow run cao-activity.yml --ref BRANCH -f fast=true -f force-recycle=true
```

For maintenance without any repository collection, use `recycle-only=true`:

```sh
gh workflow run cao-activity.yml --ref BRANCH -f recycle-only=true
```

This takes precedence over `fast` and `force-recycle`. It requires an existing
compatible snapshot whose repository scope matches the current resolved policy;
a cache miss, unavailable policy, or scope change fails closed. It skips the
authentication plan, collector jobs, fragment download, issue enrichment,
operational-value collection, and repository-memory fetches. No GitHub API
evidence requests or failure-issue writes are made. Checkout and Actions cache/artifact transport still
use GitHub services.

Maintenance expires and bounds raw evidence, clears disposable normalization
payloads, and rebuilds the SQLite database and both normalized phases from the
retained raw shards rather than keeping rows for evicted runs. Cached inventory
and repository memory keep their original observation timestamps; missing legacy
memory is represented by an empty manifest, not a fresh collection. The workflow
then validates the database, recomputes payload hashes, and verifies the complete
snapshot before saving a new cache. Invalid or unsupported raw evidence prevents
publication. An empty retained run set is represented explicitly. Branch
dispatches save branch-scoped Actions caches; they do not replace main's cache.
Recycle-only runs on non-default branches therefore use a branch-specific
concurrency group instead of competing with production's pending run slot.
Normal/fast collection and maintenance on the default branch retain the shared,
serialized Activity concurrency group.

Each `gh aw logs` invocation uses `--cached-jsonl` with a repository-specific
trailing wildcard shard prefix instead of a single growing file. The wildcard shard
directory itself is part of the shared activity cache, so `gh aw logs`
recognizes previously discovered runs across job runs without re-seeding a
snapshot. After a successful collection, `cao compact-jsonl` consolidates that
repository's retained files into bounded shards, retaining only runs whose
workflow path ends in `.lock.yml` and their associated records. This excludes
non-agentic Actions workflows while preserving observation precedence and
dependent-record association. The bounded files limit peak browser parsing
memory. Failed collections never replace the published cache. Shards containing only
out-of-range dated records are pruned by `gh aw logs --cache-before`. CAO also
runs `cao recycle-cache` before compaction, between repository downloads, and
before index normalization. It expires completed runs older than 30 days across
mixed-date shards and removes their safe outputs and token-efficiency evidence
as a group. Newer observations refresh a run's expiry; active runs and runs
without usable timestamps are not age-expired. Under byte pressure, whole run
groups are evicted oldest first (undated runs last), with explicit expired and
evicted counts in the command output. Operational-value history has its own
365-day retention and is not evicted to satisfy the run-cache budget. Unknown
records are preserved; if these protected records alone exceed the byte limit,
maintenance fails before changing any shards rather than silently dropping them.
Each rewritten shard is streamed to a temporary file and atomically replaced;
fully expired shards are deleted. The
ingestion step passes the shard directory to `cao ingest-jsonl --input-dir`,
which tracks each compacted shard by content hash.

CAO's Node.js shard readers use the MIT-licensed streaming JSONL helpers from
`github/gh-aw`, vendored without changes under `activity/vendor/gh-aw/` so installed
runtimes need no network access or additional packages. `source.json` records the
immutable upstream revision and file hashes; `node scripts/vendor-gh-aw-jsonl.mjs`
refreshes these files from the revision pinned in that script. The shared
`activity/jsonl.mjs` reader lazily parses bounded file chunks, skips blank lines,
and fails on malformed or truncated records with a file/line diagnostic that
omits record contents. Compaction, recycling, normalized-payload consolidation,
issue-status enrichment, session enrichment, and run-log reads share this reader.
Raw-line callers retain whitespace and record text without allocating a full
file's line array. Browser ingestion remains independent of Node.js filesystem
helpers.

Activity and hosted collection prefer gh-aw's version-1 unified
`usage/aw_session.jsonl` timeline (published by gh-aw v0.92.0). After download,
`activity/session-evidence.mjs` associates each session with the execution
repository, run ID, and attempt from `aw_info.json`, then stores only a safe
metadata projection in the cached Run's `cao_unified_session` field. This
projection survives compaction, SQLite ingestion, and normalized publication;
raw prompts, messages, tool arguments, results, and error bodies are not retained.
Schema-v5 cached logs are accepted alongside legacy v2/v4 shards.

The canonical adapter prefers the unified timeline for agent, MCP, firewall,
and skill events, without adding duplicate legacy events for those categories.
Experiment assignments, grader measurements and manifests, and binary eval
answers also come from the unified session first. `experiment.state` contributes
only the producing run's explicit assignments, never cumulative counts;
`grader.result` and `eval.result` populate separate canonical evidence tables.
Untimed evaluation records remain evidence without invented session timeline
events. Missing session evidence falls back by category to the enriched run;
evals can additionally be projected from an already-downloaded `evals.jsonl`,
after repository, run, and attempt verification using `aw_info.json`. No extra
GitHub download is introduced. Only allowlisted metadata is retained, never
evaluation prompts, error bodies, or native payload copies.
Other run metadata, audit findings, and safe outputs still come from the enriched
run. Runs without a published session retain the
existing cached-audit parser; `cao ingest --logs` likewise retains its raw
agent/gateway/firewall parsers when `aw_session.jsonl` is absent. During Activity
collection, invalid, unsupported, ambiguous, or incorrectly identified optional
sessions are skipped with a warning containing only the run ID. Their cached
records remain unchanged and other runs continue enrichment; filesystem and
shard errors still fail collection. Direct `cao ingest --logs` session parsing
remains strict. Untimed session observations are not assigned invented event
timestamps.

The raw cache defaults to **1 GiB** across all repositories in a job, not per
shard. Set the repository variable `CAO_ACTIVITY_MAX_RAW_CACHE_BYTES` to override
it in both Activity and dashboard preparation, or use
`cao recycle-cache --input-dir DIRECTORY --retention-days 30 --max-bytes BYTES`
locally. The collector also accepts `REPORT_MAX_CACHE_BYTES`.
These limits deliberately make the cache a bounded working set, not an archive:
byte pressure may shorten the available run history below 30 days.
Indexing treats successful owner fragments as the complete retained snapshot,
removes superseded restored shards, and moves incoming files instead of keeping
a second full fragment copy. Empty owner snapshots remain explicitly empty.

After compaction, `cao issue-status` reads the canonical Issue records from the
refreshed local SQLite projection, batches issue lookups by repository through
GitHub GraphQL, and enriches matching safe-output records with authoritative
closed state, state reason, and closure time. The command has independent
GraphQL point-budget and remaining-capacity-floor controls. Pull requests are
excluded, inaccessible issues remain unchanged, and the enriched source records
flow through the same normalized dashboard shard pipeline.

Collection is serial by repository so audits share refreshed Drain3 weights and
do not multiply concurrent GitHub API pressure. A cold collection must discover
the bounded run window for every repository. Later collections reuse each
repository's wildcard shard cache and canonical transaction hashes, making the
normal refresh incremental.

Collection and snapshot consumers restore the same ordered cache paths as
publication, including the normalized phases, inventory, and repository memory.
Actions includes the path list in its cache version; restoring only the raw
shards and database cannot reuse the published snapshot. Each collection job
rebuilds a separate `collection.sqlite` projection from its owner-scoped shards
for issue-status and operational-value queries. It does not query the restored
cross-owner database, which is reused only by indexing and snapshot consumers.

Owner-scoped PAT collection jobs run serially because different PATs belonging
to the same user share a core API quota. App installation jobs can run in
parallel. Before inventory discovery and each repository log invocation,
Activity checks the selected credential's current core capacity against the
same request reserve used by log collection (100 requests for workflow-token
mode, 4000 for App/PAT mode). Missing capacity evidence or capacity at or below
the reserve stops collection, reports the reset time when available, and leaves
the published snapshot unchanged; it never waits for replenishment or borrows
another credential.

Dispatch reconciliation treats an activation-skipped orchestrator as a
no-dispatch cycle only when the run succeeded, its pre-activation job succeeded,
its activation, agent, and safe-output jobs were skipped, and its validated
`cao-admission` artifact identifies the same repository, run, and attempt.
This includes admission denial and precompute capacity deferral after admission
was granted: neither executes dispatch-producing jobs. Missing output from an
activated or failed run remains incomplete evidence.

## Data ownership and joins

Activity has two source classes:

| Input | Authority | Canonical contribution |
| --- | --- | --- |
| `control-settings.json` and `inventory-sources.json` | Enrolled repository scope, campaign configuration, declared control workflows, paginated Actions workflow registries, and maintenance evidence | Campaign, Repository, declared control Workflow, and standalone repository Workflow observations |
| `agent-summary.json` | Bounded counts and disabled-campaign identities derived from `inventory-sources.json`, with source freshness preserved | Cheap agent discovery questions without downloading the full inventory |
| `gh-aw-logs-shards/*.jsonl` | Observed GitHub Actions execution and agentic audit evidence | Repository, Workflow, Run, Domain, Tool, Audit, and Issue observations |

The SQLite database and browser IndexedDB are
independently reconstructable projections of these external inputs.

Runtime records join through canonical execution identities. A Repository uses
the normalized `OWNER/REPOSITORY` coordinate available in cached logs. A
Workflow belongs to that Repository and uses its workflow path when available,
falling back to a repository-scoped workflow name. A Run uses the GitHub run ID
plus attempt and references both the Repository where it executed and its
Workflow. Campaign targets and dispatch payloads never replace that execution
repository relationship.

Dashboard selection, grouping, aggregation, and joins remain declarative. The
Repositories view starts from repository inventory, aggregates Workflow and Run
records by `organization` and `repository`, and left-joins those query results
in the data Web Worker. Activity collection and browser components do not
reconstruct those relationships.

## Campaign problem clustering

After canonical ingestion and operational-value collection, Activity runs
`cao cluster-problems`. The command discovers one optional
`<campaign>/problem-clustering.mjs` file in each installed top-level campaign.
This lets campaigns contribute deterministic problem computations without
adding campaign-specific branches to the Activity workflow.

Each script receives one JSON request on standard input:

```json
{
  "schemaVersion": 1,
  "timestamp": "2026-09-24T23:05:09.441Z",
  "database": "/tmp/cao-problem-clustering-…/activity.sqlite"
}
```

The same isolated snapshot path is available as `CAO_DATABASE`. Scripts emit a
JSONL sequence containing zero or more problem objects, one object per line,
with required `id`, `title`, and `fixPrompt` fields. `fixPrompt` is a bounded,
actionable prompt that an agent can follow to resolve the reported problem.
Optional fields are `observedAt`, `severity`, `summary`, `campaign`,
`repository`, `workflow`, `targetRepository`, and an object-valued `evidence`. Severity is one of
`critical`, `high`, `medium`, `low`, or `info`.

Activity validates and bounds the output, then atomically replaces only that
campaign's rows in the `cao_problems` SQLite table. A failing script leaves its
previous rows intact and does not prevent other campaigns from contributing.
Scripts receive a private database snapshot and cannot mutate the canonical
Activity projection directly. Rows from campaigns that no longer contribute a
clustering script are removed during the next run. Each script runs in a
separate process with bounded output and a two-minute timeout. Worker failures
and timeouts are isolated per campaign; cancellation terminates the active worker
and stops further campaign processing while retaining rows committed by workers
that already completed.

Set `NODE_DEBUG=cao:problem-clustering` to trace discovery, snapshot creation,
worker lifecycle and duration, bounded output size, persistence counts, failure
retention, cleanup, and cancellation. Debug events contain campaign names and
aggregate metadata only; they do not include problem records, evidence, worker
output, database contents, or credentials.

Run the same discovery locally with:

```bash
cao cluster-problems --database .cao/gh-aw-logs.sqlite --root .
```

## Cache contract

The cache contains:

```text
$RUNNER_TEMP/cao-activity/gh-aw-logs.sqlite
$RUNNER_TEMP/cao-activity/gh-aw-logs-shards/
$RUNNER_TEMP/cao-activity/gh-aw-logs-runs/
$RUNNER_TEMP/cao-activity/gh-aw-logs-records/
$RUNNER_TEMP/cao-activity/payload-hashes.json
$RUNNER_TEMP/cao-activity/control-settings.json
$RUNNER_TEMP/cao-activity/inventory-sources.json
$RUNNER_TEMP/cao-activity/drain3_weights.json
```

`payload-hashes.json` maps the SQLite projection, retained source JSONL,
`gh-aw-logs-runs/` run-information shards, and `gh-aw-logs-records/` run-linked
shards to their SHA-256 checksums. Run-information shards contain immutable
agent/model identity and duration, firewall, MCP, operational-value, and audit
priority aggregates. Every domain, tool, audit, and issue record includes its
owning run identity. Normalized phase shards use JSONL so browser consumers can
stream and commit bounded record batches without retaining a complete file in
memory. Empty per-source phase payloads are omitted, so the run and record directories can contain different
filename stems. A phase with no records at all publishes exactly one header-only shard, so a collection
that observed no agentic runs is explicit rather than indistinguishable from missing output. The dashboard imports all run-information shards before record
shards so clients can query runs while detailed ingestion continues.
Published phase shards are deduplicated across source files, ordered by
collection and canonical ID within stable day buckets, and capped at 1 MiB
including their metadata header. This is separate from the 4 MiB raw-source
compaction limit. A single canonical record larger than the budget is preserved
intact in its own shard; evidence is never truncated to fit. Override the
published size with `cao hash-payloads --max-bytes BYTES`.
The separate disposable normalization caches under each phase's `.payloads/`
directory share a **256 MiB** retained-byte budget. Override it with repository
variable `CAO_ACTIVITY_MAX_NORMALIZED_CACHE_BYTES`, or
`cao hash-payloads --max-cache-bytes BYTES` (`0` disables reuse).
Obsolete source-hash/context payloads and interrupted temporary files are removed
before replacement normalization; oldest reusable payloads are evicted to meet
the budget after consolidation. Eviction never changes published shards or their
hashes, and missing cache entries are regenerated on demand.
The raw and reusable-cache limits do not cap the SQLite projection, published
evidence, or temporary active normalization output; allow runner headroom for
those files and one temporary rewritten source shard.
Observation precedence is resolved before sorting, so reordered source records
with unchanged winning values retain their content hashes. Structural records
sort before dated records, and each filename includes its day, part index, and
content hash.
Dashboard ingestion checks this sidecar first, then falls back to ETag validation
and finally a downloaded-content hash when neither server-side identity is usable.

The Activity cache retains raw source shards for audits and rebuilds. The
deployed dashboard artifact filters its manifest and files to the SQLite
projection plus compacted `gh-aw-logs-runs/*.jsonl` and
`gh-aw-logs-records/*.jsonl`; browser ingestion never downloads raw source
shards.

Workflow inventory discovery can be reproduced locally with:

```bash
cao discover-workflows \
  --control-settings /path/to/control-settings.json \
  --inventory /tmp/control-plane-inventory.json \
  --output /tmp/inventory-sources.json \
  --repo OWNER/REPOSITORY
```

Add `--offline` to use only checked-in workflow metadata and explicitly scoped
repositories without calling GitHub. Offline sources are marked partial, and
workflow activation remains unknown rather than inferred from local files.
Activity uses this mode when its API capacity check reaches the reserved quota.
Credential selection and the repository visibility boundary still fail closed.

When collection reaches its reserved quota or receives a confirmed primary or
secondary GitHub API rate-limit error, Activity stops further repository downloads
but compacts and indexes the retained shards and completed partial downloads.
The collector records status `75`, emits a warning and a partial-collection job
summary, and marks affected repositories in the inventory's coverage metadata.
The workflow accepts only this limited-capacity status for partial publication;
authentication, permission, malformed-data, and other collection failures remain
hard failures. It skips issue-status enrichment and new operational-value API work
while retaining previously collected operational-value evidence. A later run can
resume from the published cache after API capacity recovers.
Manual runs on non-default branches use a branch-specific concurrency group,
so preview collections cannot displace pending production collections. They
retain the same credential scope and quota reserve.

The split improves time to first useful Run query rather than reducing the
total transfer required for a complete refresh. Run results exposed between
phases are partial snapshot state; record-dependent results become current only
after the record phase succeeds.

## Runtime-health computation

The CLI exposes computations through an extensible namespace. After downloading a query-ready snapshot, which includes both Activity SQLite
and `inventory-sources.json`, compute runtime health for the full
portfolio or one campaign:

```bash
cao computation runtime-health
cao computation runtime-health --campaign dependabot
cao computation runtime-health --campaign dependabot --diagnose
```

`runtime-health@1.0.0` selects canonical Campaign and Workflow relationships,
orders Run attempts, and isolates worker targets with Dashboard Language
queries before applying the versioned measure. Orchestrators are queried and
evaluated first; worker Runs are queried only for campaigns whose orchestrator
gate is eligible. The result reports runtime facts only and does not imply that
a successful Run produced, verified, or delivered value.

Use `--diagnose` with one `--campaign` to drill into current failure groups.
The bounded diagnostic result compares current failed Runs with the latest
successful boundary and queries run-linked Audit, tool, firewall, and safe-output
evidence. When canonical evidence cannot establish an exact cause, it says so
and links to the GitHub Actions Run where job logs and stderr can be inspected.

Set `NODE_DEBUG=cao:computation:runtime-health` to inspect optional computation
timing. The production test suite enforces a warmed median below 20 ms on a
representative 20-campaign, 400-worker-Run corpus; timing is diagnostic and is
not part of the computation result contract.

`activity/cao.mjs` logs shard skip/ingest decisions and per-file hash results
through Node's built-in `util.debuglog` (see `activity/debug.mjs`), scoped
under the `cao:*` namespace (for example `cao:ingest`, `cao:hash-payloads`).
Logging is a no-op by default; set `NODE_DEBUG=cao:*` (or a specific category)
to see it.

Snapshots use the immutable key
`cao-activity-v5-${github.run_id}-${github.run_attempt}` and restore prefix
`cao-activity-v5-`. Dispatching consumers wait for the exact Activity run and
reconstruct its immutable key from the returned run ID and attempt. Producers
and consumers use this complete path list because GitHub includes paths in the
cache version. When the current layout misses, Activity restores the preceding
layout containing `gh-aw-logs-normalized/`; `hash-payloads` processes its
retained JSONL shard directory to generate run and record shards.
The cache is an evictable transport optimization, not durable
historical authority.

The Drain3 weights are restored outside the `gh aw logs` output directory and
passed back with `--drain3-weights`. After each audit, the newly trained weights
are moved from the logs output directory into the activity snapshot so storage
accounting does not mistake them for a cached log file.

The scheduled collector is intentionally rolling and bounded. It requests a
30-day run window and at most 1,000 matching enriched runs from each resolved
repository. The compacted JSONL can contain non-identical observations of the same run;
canonical ingestion merges those observations by stable run identity. Use a
separate source and SQLite database when a complete historical archive is
required.

The `gh-aw-logs.mjs` resource provides the shared parser for consumers of the
JSONL format. The `cao.mjs` resource provides the `cao` SQLite CLI entry point,
including the `computation` namespace.
Agent jobs can query the normalized projection without repeating log
acquisition. Consumers must still determine their own completeness, freshness,
and scope requirements.
