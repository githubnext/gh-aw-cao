# CAO Activity

CAO Activity is the shared, bounded `gh aw logs` collector for Central Agentic
Ops. It is deterministic GitHub Actions infrastructure: it has no agent,
rollout mode, safe-output, target-writing, indexing, or reporting authority.

The scheduled and manually dispatchable `CAO Activity` workflow checks out the
control repository, restores the latest compatible log cache, runs one bounded
`gh aw logs --audit --artifacts usage` command for its compiled workflows, and
ingests the refreshed JSONL through the canonical Node.js data pipeline. It
uploads the completed snapshot as a one-day artifact. A dependent job downloads
that artifact and publishes the source JSONL and its local SQLite projection to
the shared cache, keeping cache-write permission out of the collection job.

## Cache contract

The cache contains:

```text
$RUNNER_TEMP/cao-activity/gh-aw-logs.jsonl
$RUNNER_TEMP/cao-activity/gh-aw-logs.sqlite
$RUNNER_TEMP/cao-activity/payload-hashes.json
$RUNNER_TEMP/cao-activity/control-settings.json
$RUNNER_TEMP/cao-activity/inventory-sources.json
$RUNNER_TEMP/cao-gh-aw-logs/drain3_weights.json
```

`payload-hashes.json` maps the JSONL source and SQLite projection filenames to
their SHA-256 checksums. The dashboard publishes it beside both payloads so
clients can detect unchanged data without downloading either complete payload.
Dashboard ingestion checks this sidecar first, then falls back to ETag validation
and finally a downloaded-content hash when neither server-side identity is usable.

Snapshots use the immutable key
`cao-activity-v3-${github.run_id}-${github.run_attempt}` and restore prefix
`cao-activity-v3-`. Dispatching consumers wait for the exact Activity run and
reconstruct its immutable key from the returned run ID and attempt. Producers
and consumers use this complete path list because GitHub includes paths in the
cache version. The cache is an evictable transport optimization, not durable
historical authority.

The scheduled collector is intentionally rolling and bounded. It requests a
30-day run window and at most five matching enriched runs across all targets in
one invocation. Cached JSONL can contain repeated observations from later
refreshes; canonical ingestion deduplicates them by stable run identity. Use a
separate source and SQLite database when a complete historical archive is
required.

The `gh-aw-logs.mjs` resource provides the shared parser for consumers of the
JSONL format. The `cao.mjs` resource provides the `cao` SQLite CLI entry point.
Agent jobs can query the normalized projection without repeating log
acquisition. Consumers must still determine their own completeness, freshness,
and scope requirements.
