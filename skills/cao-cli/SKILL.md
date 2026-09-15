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

Create a minimal review-safe control-plane policy:

```bash
cao init
```

The command refuses to replace an existing `.github/workflows/cao.json`. Install an
operational package and merge its declared orchestrator and workers into that policy with:

```bash
cao add githubnext/gh-aw-cao/dependabot
```

`cao add` forwards remaining arguments to `gh aw add`, preserves operator-owned package
settings, and does not copy live mode or broader rollout into the policy. If the policy is
missing, `cao add` creates the same minimal policy as `cao init` after the package installs.

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
2. Resolve the CLI entry point. It lives at a different path depending on whether this
   is the source-managed control repository or an installed package:

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
