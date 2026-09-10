# CAO Activity

CAO Activity is the shared, bounded `gh aw logs` collector for Central Agentic
Ops. It is deterministic GitHub Actions infrastructure: it has no agent,
rollout mode, safe-output, target-writing, indexing, or reporting authority.

The scheduled and manually dispatchable `CAO Activity` workflow checks out the
control repository, restores the latest compatible log cache, runs one bounded
`gh aw logs --audit --artifacts usage` command for its compiled workflows, and
saves only the refreshed JSONL file.

## Cache contract

The cache contains exactly:

```text
$RUNNER_TEMP/cao-activity/gh-aw-logs.jsonl
```

Snapshots use the immutable key
`cao-activity-v3-${github.run_id}-${github.run_attempt}` and restore prefix
`cao-activity-v3-`. Dispatching consumers wait for the exact Activity run and
reconstruct its immutable key from the returned run ID and attempt. The cache
is an evictable transport optimization, not durable historical authority.

The `gh-aw-logs.mjs` resource provides the shared parser for consumers of this
JSONL format. Consumers must determine their own completeness, freshness, and
scope requirements; Activity does not derive indexes, dashboard records, or
telemetry from the logs.
