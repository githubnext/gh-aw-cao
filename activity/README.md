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
workflows remain standalone and never become CAO package workers or rollout
authority. Per-repository registry failures are published as partial or
unavailable source evidence rather than complete empty inventories. It uploads
the completed snapshot as a one-day artifact.
A dependent job downloads
that artifact, verifies every snapshot file is present and non-empty, and
publishes the source JSONL and its local SQLite projection to the shared cache,
keeping cache-write permission out of the collection job. An incomplete
extraction fails that job instead of silently skipping the cache save, which
would strand consumers on a cache miss.

Each `gh aw logs` invocation uses `--cached-logs` with a repository-specific
trailing wildcard shard prefix instead of a single `--cached-jsonl` file. The wildcard shard
directory itself is part of the shared activity cache, so `gh aw logs`
recognizes previously discovered runs across job runs without re-seeding a
snapshot. After a successful collection, `cao compact-jsonl` consolidates that
repository's retained files into one shard without removing or reordering
records, so observation precedence and dependent-record association are
unchanged. Failed collections leave the prior files untouched. Shards containing only
out-of-range dated records are pruned by `gh aw logs --cache-before`. The
ingestion step passes the shard directory to `cao ingest-jsonl --input-dir`,
which tracks each compacted shard by content hash.

Collection is serial by repository so audits share refreshed Drain3 weights and
do not multiply concurrent GitHub API pressure. A cold collection must discover
the bounded run window for every repository. Later collections reuse each
repository's wildcard shard cache and canonical transaction hashes, making the
normal refresh incremental.

## Data ownership and joins

Activity has two source classes:

| Input | Authority | Canonical contribution |
| --- | --- | --- |
| `control-settings.json` and `inventory-sources.json` | Enrolled repository scope, package configuration, declared control workflows, paginated Actions workflow registries, and maintenance evidence | Package, Repository, declared control Workflow, and standalone repository Workflow observations |
| `gh-aw-logs-shards/*.jsonl` | Observed GitHub Actions execution and agentic audit evidence | Repository, Workflow, Run, Job, Session, and Event observations |

The SQLite database and browser IndexedDB are
independently reconstructable projections of these external inputs.

Runtime records join through canonical execution identities. A Repository uses
the normalized `OWNER/REPOSITORY` coordinate available in cached logs. A
Workflow belongs to that Repository and uses its workflow path when available,
falling back to a repository-scoped workflow name. A Run uses the GitHub run ID
plus attempt and references both the Repository where it executed and its
Workflow. Package targets and dispatch payloads never replace that execution
repository relationship.

Dashboard selection, grouping, aggregation, and joins remain declarative. The
Repositories view starts from repository inventory, aggregates Workflow and Run
records by `organization` and `repository`, and left-joins those query results
in the data Web Worker. Activity collection and browser components do not
reconstruct those relationships.

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
owning run identity. Empty phase shards are omitted, so the run and record directories can contain different
filename stems. The dashboard imports all run-information shards before event
record shards so clients can query runs while detailed ingestion continues.
Each phase filename retains the source shard's sortable prefix before its
content and normalization hashes, preserving observation precedence across
repeated records.
Dashboard ingestion checks this sidecar first, then falls back to ETag validation
and finally a downloaded-content hash when neither server-side identity is usable.

Workflow inventory discovery can be reproduced locally with:

```bash
cao discover-workflows \
  --control-settings /path/to/control-settings.json \
  --inventory /tmp/control-plane-inventory.json \
  --output /tmp/inventory-sources.json \
  --repo OWNER/REPOSITORY
```

The split improves time to first useful Run query rather than reducing the
total transfer required for a complete refresh. Run results exposed between
phases are partial snapshot state; event-dependent results become current only
after the event phase succeeds.

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
retained JSONL shard directory to generate non-empty run and event shards.
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
JSONL format. The `cao.mjs` resource provides the `cao` SQLite CLI entry point.
Agent jobs can query the normalized projection without repeating log
acquisition. Consumers must still determine their own completeness, freshness,
and scope requirements.
