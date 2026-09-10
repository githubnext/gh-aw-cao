# CAO Activity

CAO Activity is the shared, bounded `gh aw logs` collector for Central Agentic
Ops. It is deterministic GitHub Actions infrastructure: it has no agent,
rollout mode, safe-output, target-writing, indexing, or reporting authority.

The scheduled and manually dispatchable `CAO Activity` workflow checks out the
control repository, restores the latest compatible log cache, runs one bounded
`gh aw logs --audit --artifacts usage` command for its compiled workflows, and
ingests the refreshed JSONL through the canonical Node.js data pipeline. It
caches both the source JSONL and its local SQLite projection.

## Cache contract

The cache contains:

```text
$RUNNER_TEMP/cao-activity/gh-aw-logs.jsonl
$RUNNER_TEMP/cao-activity/gh-aw-logs.sqlite
```

Snapshots use the immutable key
`cao-activity-v3-${github.run_id}-${github.run_attempt}` and restore prefix
`cao-activity-v3-`. Dispatching consumers wait for the exact Activity run and
reconstruct its immutable key from the returned run ID and attempt. The cache
is an evictable transport optimization, not durable historical authority.

The `gh-aw-logs.mjs` resource provides the shared parser for consumers of the
JSONL format. Agent jobs restore the same cache and install the SQLite CLI so
they can query the normalized projection without repeating log acquisition.
Consumers must still determine their own completeness, freshness, and scope
requirements.
