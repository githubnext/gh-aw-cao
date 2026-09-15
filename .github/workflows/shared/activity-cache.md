---
jobs:
  activation:
    pre-steps:
      - name: Restore CAO activity cache
        uses: actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
        with:
          path: |
            ${{ runner.temp }}/cao-activity/gh-aw-logs.sqlite
            ${{ runner.temp }}/cao-activity/gh-aw-logs-shards
            ${{ runner.temp }}/cao-activity/payload-hashes.json
            ${{ runner.temp }}/cao-activity/control-settings.json
            ${{ runner.temp }}/cao-activity/inventory-sources.json
            ${{ runner.temp }}/cao-activity/drain3_weights.json
          key: cao-activity-v3-lookup-${{ github.run_id }}-${{ github.run_attempt }}-activation
          restore-keys: |
            cao-activity-v3-

  agent:
    pre-steps:
      - name: Restore CAO activity cache
        uses: actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
        with:
          path: |
            ${{ runner.temp }}/cao-activity/gh-aw-logs.sqlite
            ${{ runner.temp }}/cao-activity/gh-aw-logs-shards
            ${{ runner.temp }}/cao-activity/payload-hashes.json
            ${{ runner.temp }}/cao-activity/control-settings.json
            ${{ runner.temp }}/cao-activity/inventory-sources.json
            ${{ runner.temp }}/cao-activity/drain3_weights.json
          key: cao-activity-v3-lookup-${{ github.run_id }}-${{ github.run_attempt }}-agent
          restore-keys: |
            cao-activity-v3-
---

<!--
Restores the latest CAO activity snapshot for deterministic activation checks and
agent-side reuse. Consumers must treat cache misses and incomplete coverage as
fallback conditions and must never save or publish this shared cache.
-->

<cached-gh-data>

Query the restored snapshot with the `cao` CLI instead of parsing
`gh-aw-logs-shards/*.jsonl` shards by hand, and instead of querying GitHub
directly. Prefer this cached data over GitHub API or `gh` CLI calls whenever
it can answer the question, since repeated direct GitHub queries burn API
rate limits that the shared cache already avoids. First check whether the
restore populated `$RUNNER_TEMP/cao-activity/gh-aw-logs.sqlite`; a
missing or empty file is a cache miss and must be treated as a fallback
condition, not an error. Resolve the CLI entry point before running any
`cao` command, since it lives at a different path depending on whether
this is the source-managed control repository or an installed package:

```bash
if [ -f activity/cao.mjs ]; then
  cao_script=activity/cao.mjs
elif [ -f .github/aw/activity/cao.mjs ]; then
  cao_script=.github/aw/activity/cao.mjs
else
  echo "cao CLI is unavailable; fall back to unbounded evidence gathering" >&2
  cao_script=""
fi
```

Treat an empty `cao_script` as a hard stop: skip every `cao` command below
and fall back to bounded read-only GitHub or `agentic-workflows` calls instead
of invoking `node` with no script path.

Once resolved, pass the cached database explicitly with `--database`
(it defaults to `.cao/gh-aw-logs.sqlite`, not the cache path) and use the
gh-like query surface for common questions about runs, safe-output-created
issues, and safe-output-created pull requests:

```bash
db="$RUNNER_TEMP/cao-activity/gh-aw-logs.sqlite"

node "$cao_script" gh runs \
  --database "$db" \
  --repo OWNER/REPOSITORY --workflow WORKFLOW --status failure \
  --since YYYY-MM-DD --until YYYY-MM-DD

node "$cao_script" gh issues \
  --database "$db" \
  --repo OWNER/REPOSITORY --since YYYY-MM-DD

node "$cao_script" gh prs \
  --database "$db" \
  --repo OWNER/REPOSITORY --workflow WORKFLOW --limit 10
```

`-R`, `-w`, `-s`, and `-L` are short aliases for `--repo`, `--workflow`,
`--status`, and `--limit`. For runs, `--status` matches either the workflow
status or conclusion; the default limit is 30. Issue and pull request results
come from canonical `safe_output.created` events, and their `--repo` filter
refers to the output target repository, not the executing repository.

For collection-level access instead of the gh-shaped surface, use
`cao query --database ... --collection {repositories,workflows,runs,jobs,sessions,events,transactions} [--id ID] [--where FIELD=VALUE] [--limit COUNT]`,
or `cao doctor --database ...` to check snapshot integrity before relying on
its counts. Always validate cache scope, freshness, window, and completeness
against the requested evidence before treating query results as authoritative,
and fetch only missing evidence through read-only GitHub or `agentic-workflows`
tools rather than widening this shared cache's role.

</cached-gh-data>
