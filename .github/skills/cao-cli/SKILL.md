---
name: cao-cli
description: Use the cao CLI to query Central Agentic Ops activity data, both in local development and inside agentic workflow runs.
argument-hint: "[dashboard-data-url-or-owner/repo, or the agentic workflow you are editing]"
allowed-tools: bash jq
metadata:
  version: "1.0.0"
---

# Use the `cao` CLI

Use this skill whenever you need to query Central Agentic Ops activity data (repositories,
workflows, runs, jobs, sessions, events) with the `cao` CLI, whether you are working
locally in this repository or writing/debugging an agentic workflow that imports
`.github/workflows/shared/activity-cache.md`. `cao` is a thin SQLite-backed query
surface over the canonical dashboard data model described in
[the dashboard data model docs](../../docs/dashboard-data-model.md); this skill
covers only how and where to invoke it.

## Data contract

- Treat `cao`-queried data as derived, disposable evidence, not schema authority.
- Preserve the distinction between missing, stale, partial, zero, and complete evidence.
- Do not infer rollout authority, target-writing authority, operational value, or repository
  eligibility from activity data.
- Never print credentials, tokens, authorization headers, raw prompts, transcripts, or other
  secret values.
- Prefer `cao` over direct GitHub API or `gh` CLI calls whenever it can answer the question;
  repeated direct GitHub queries burn API rate limits that the cached snapshot already avoids.

## Two invocation contexts

`cao` is the same tool in both contexts; only how you locate it and which database it
queries differ.

## Configure a control repository

The latest Bash installer makes the canonical `./cao.sh` wrapper
executable. Run configuration commands through that repository-local CLI.

Create a minimal review-safe control-plane policy:

```bash
./cao.sh init
```

The command refuses to replace an existing `.github/workflows/cao.json`. Install an
operational campaign and merge its declared orchestrator and workers into that policy with:

```bash
./cao.sh add githubnext/gh-aw-cao/dependabot
```

`cao add` forwards remaining arguments to `gh aw add`, preserves operator-owned campaign
settings, and does not copy live mode or broader rollout into the policy. If the policy is
missing, `cao add` creates the same minimal policy as `cao init` after the campaign installs.
Upgrade `gh-aw` to the policy minimum, update every installed campaign, and refresh CAO
worker declarations with:

```bash
./cao.sh update
```

`cao update` forwards remaining arguments to `gh aw update`, preserves operator-owned
campaign settings, and does not enable live mode or broaden repository scope.

### 1. Local development mode

Use this when a human or agent is exploring activity data from this repository's
working copy, outside of a running agentic workflow.

1. Confirm dependencies are installed. If the `cao` binary is unavailable, use
   `npm run dashboard:data --` from the repository root instead of `cao`.
2. Download the current published snapshot (writes `.cao/payload-hashes.json`,
   `.cao/gh-aw-logs-shards/`, and `.cao/gh-aw-logs.sqlite` by default):

   ```bash
   cao download
   ```

   Pass `--url URL` (or set `DASHBOARD_DATA_URL`) for another deployment's
   `payload-hashes.json`, and `--output DIRECTORY` only when the user requests a
   non-default destination.
3. Optionally audit source coverage before treating the snapshot as complete:

   ```bash
   cao audit-jsonl
   ```
4. Query the default `.cao/gh-aw-logs.sqlite` projection (see "Querying" below).
   `--database FILE` is only needed for a non-default path.

### 2. Inside an agentic workflow run

Use this when a workflow imports `shared/activity-cache.md` and restores the shared
activity cache into `${{ runner.temp }}/cao-activity/`. There is no `.cao/` download
step here: the cache restore step already populated the database, and the CLI script
itself is not guaranteed to be at a fixed path.

1. Check whether the restore actually populated
   `$RUNNER_TEMP/cao-activity/gh-aw-logs.sqlite`. A missing or empty file is a cache
   miss and must be treated as a fallback condition, not an error — fall back to
   bounded read-only GitHub or `agentic-workflows` tool calls instead.
2. Resolve the CLI entry point from the canonical source-layout path used by both
   the catalog and installed campaigns:

   ```bash
   cao_script=activity/cao.mjs
   if [ ! -f "$cao_script" ]; then
     echo "cao CLI is unavailable; fall back to unbounded evidence gathering" >&2
     cao_script=""
   fi
   ```

   Treat an empty `cao_script` as a hard stop: skip every `cao` command and fall back
   instead of invoking `node` with no script path.
3. Invoke the resolved script with `node`, always passing `--database` explicitly
   since the default `.cao/gh-aw-logs.sqlite` path does not apply here:

   ```bash
   db="$RUNNER_TEMP/cao-activity/gh-aw-logs.sqlite"

   node "$cao_script" gh runs \
     --database "$db" \
     --repo OWNER/REPOSITORY --workflow WORKFLOW --status failure \
     --since YYYY-MM-DD --until YYYY-MM-DD
   ```

## Querying

Query the SQLite projection with canonical collection names, or the gh-like surface
for common run/issue/PR questions.

### Canonical collections

```bash
cao query --collection runs --limit 20
```

Add filters with repeated exact-match `--where FIELD=VALUE` options:

```bash
cao query \
  --collection runs \
  --where conclusion=failure \
  --limit 20
```

Query by ID when the user asks about one known record:

```bash
cao query --collection sessions --id SESSION_ID
```

For generated or complex queries, pass a raw Dashboard Language query object through
standard input (do not combine `--stdin` with `--collection`, `--id`, `--where`, or
`--limit`):

```bash
jq -n \
  --arg conclusion failure \
  '{
    name: "failed-runs",
    from: "runs",
    filter: {predicates: [{field: "conclusion", equals: $conclusion}]},
    limit: 20
  }' |
  cao query --stdin
```

The canonical query collections are `repositories`, `workflows`, `runs`, `jobs`,
`sessions`, `events`, and `transactions`. Run `cao help` (or `cao --help`) for the
current command syntax.

### Evaluate dashboard query complexity

Evaluate every generated or modified Dashboard Language query before accepting it:

```bash
cao dashboard-complexity \
  --input dashboard/site/dashboard.json \
  --database .cao/gh-aw-logs.sqlite
```

The command reports an upper-bound row-read estimate, database-table coefficients,
stage-level reads, parent queries and views that consume each query, and a ranking from
highest to lowest computation pressure. With `--database`, canonical tables are weighted by
their deployed row counts normalized to the largest table. Pressure includes the selected
query plus each unique transitive dependency materialized once, matching compiler reuse
within one execution batch.

Inspect one generated query directly by passing its query ID before the options:

```bash
cao dashboard-complexity QUERY_ID \
  --input dashboard/site/dashboard.json \
  --database .cao/gh-aw-logs.sqlite
```

Use `--format markdown` for a review-ready ranking and `--limit COUNT` to bound graph-wide
output. When generating or revising queries, compare the targeted query and full ranking
before and after the change. Question any massive increase in direct row reads, dependency
row reads, source coefficients, or pressure rank. Do not accept a large increase merely
because the query is declarative; look for an existing base query, a narrower source,
earlier filtering, fewer joins, or reusable intermediate aggregation. If the increase is
intentional, explain the evidence and tradeoff in the review.

Without `--database`, the normalized model gives every canonical database table weight one.
Both models assume no selectivity and exclude logical sources that are not backed by a
canonical database table.

### Prune and reuse dashboard queries

Before adding generated queries or views to a Dashboard Language document, analyze it for
reuse opportunities:

```bash
cao prune-dashboard --input dashboard.json
```

The JSON report lists exact/compatible queries that can be consolidated, similarity
suggestions against earlier queries, shared query chains, and unreferenced queries and
reusable views. Similarity is a weighted score from `0` to `1`: source, joins, filters,
computes, projections, ordering, and other query stages receive explicit weights; exact
stages receive full credit, the same structure modulo field names receives 85% credit, and
partial structural overlap receives up to 60% credit. Suggestions include the detected field
mapping and the stages that can form a shared chain.

The report also includes a complete final query inventory. Each query lists its source,
execution stages, direct dependencies and dependents, rendered consumers, dependency depth,
fan-in, fan-out, and every above-threshold similarity match. Aggregate statistics compare the
query graph before and after pruning, including stage counts, dependency edges, root and nested
query counts, maximum and average depth, pairs compared, similarity relation counts, and score
buckets.

Write the optimized document only after reviewing that report:

```bash
cao prune-dashboard \
  --input dashboard.json \
  --output dashboard.pruned.json
```

The optimizer preserves public query names where possible. It merges compatible projections,
rewrites query references, extracts repeated `from`/`union`/`time`/`joins`/`filter` prefixes
into a named base query, and rewrites the original declarations to chain from that base:

Base query names must describe the shared subject, not generation order. Prefer normalized
concepts shared by the child query names (`failure-run-base`, `event-base`). When the child
names share no useful concept, use the source and shared stage (`run-filter-base`,
`audit-union-base`). Never emit numeric placeholders such as `shared-query-1-base`.

```json
[
  {
    "name": "failure-run-base",
    "intent": "Reuse shared query stages for failed-run-cost",
    "from": "runs",
    "filter": {
      "predicates": [{ "field": "conclusion", "equals": "failure" }]
    }
  },
  {
    "name": "failed-run-cost",
    "from": "failure-run-base",
    "compute": [
      {
        "as": "cost",
        "function": "multiply",
        "args": [{ "field": "tokens" }, { "value": 2 }]
      }
    ]
  }
]
```

Reusable views referenced by a page or declaring drill, view-all, or navigation behavior are
retained. Queries are then retained transitively from pages, retained reusable views, callouts,
sections, and other queries. Page declarations remain unchanged because application code may
link to a page outside the dashboard document.

### gh-like surface

Use this when you need familiar GitHub CLI-shaped commands for runs and
safe-output-created issues or pull requests:

```bash
cao gh runs --repo OWNER/REPOSITORY --workflow WORKFLOW --status failure --since YYYY-MM-DD --until YYYY-MM-DD
cao gh issues --repo OWNER/REPOSITORY --since YYYY-MM-DD
cao gh prs --repo OWNER/REPOSITORY --workflow WORKFLOW --limit 10
```

`-R`, `-w`, `-s`, and `-L` are short aliases for `--repo`, `--workflow`, `--status`,
and `--limit`. For runs, `--status` matches either the workflow status or conclusion;
the default limit is 30. Issue and pull request results come from canonical
`safe_output.created` events, and their `--repo` filter refers to the output target
repository, not the executing repository.

### Diagnosing the database

```bash
cao doctor
```

Use `--ttl-days all` / `--run-ttl-days all` only for intentional historical backfills.
Run `cao doctor --database ...` before relying on query counts from a snapshot whose
health is in doubt.

## Analysis guidance

- Start broad with counts and recent records, then narrow with `--where` filters or
  record IDs.
- Attribute findings to the collection, record ID, workflow, run ID, and timestamp
  whenever available.
- Report uncertainty explicitly when evidence is unavailable, stale, partial, or
  outside the requested scope.
- Always validate cache scope, freshness, window, and completeness against the
  requested evidence before treating query results as authoritative.
- Keep downloaded `.cao/` files uncommitted.
