---
name: analyze-cao
description: Download and query CAO activity data with the cao CLI.
allowed-tools: bash jq
metadata:
  argument-hint: "[dashboard-data-url-or-owner/repo]"
  version: "1.0.0"
---

# Analyze CAO Data

## Procedure

1. Choose shell access (`cao`) or MCP-only access (`cao_catalog`, then
   `cao_query`).
2. Establish snapshot freshness and completeness.
3. Prefer a reviewed named query; otherwise use a bounded canonical collection
   query.
4. Preserve availability and freshness metadata in the result.
5. Report source identifiers, timestamps, filters, and uncertainty.

Use this skill when a user asks to inspect, analyze, investigate, or summarize Central Agentic Ops activity data from the deployed dashboard snapshot or another published dashboard data URL.

## Data contract

- Treat downloaded data as local, disposable development evidence, not schema authority.
- Keep code and conclusions aligned with the dashboard data specifications and the activity shard schema.
- Preserve the distinction between missing, stale, partial, zero, and complete evidence.
- Do not infer rollout authority, target-writing authority, operational value, or repository eligibility from activity data.
- Never print credentials, tokens, authorization headers, raw prompts, transcripts, or other secret values.

## Shell procedure

Decide how you reach the data first:

```
Do you have shell access?
  YES           -> cao CLI, steps 1-10 below
  NO / MCP only -> cao_catalog to discover pages and queries, then cao_query
```

Without a shell, the workflow has already installed CAO, downloaded the snapshot,
and started the read-only MCP server; call `cao_catalog` and `cao_query` instead of
running commands. See [Agent analysis](../../docs/agent-analysis.md).

1. Confirm the repository has dependencies installed. If the `cao` binary is unavailable, use `npm run dashboard:data --` from the repository root.
2. Download the current published activity snapshot:

   ```bash
   cao download
   ```

   This writes `.cao/payload-hashes.json`, `.cao/gh-aw-logs-shards/`, and `.cao/gh-aw-logs.sqlite` by default.
3. For another deployment, prefer the explicit source requested by the user:

   ```bash
   cao download --url URL
   ```

   `DASHBOARD_DATA_URL=URL cao download` is equivalent. The URL must point at `payload-hashes.json`; the CLI derives sibling shard and `gh-aw-logs.sqlite` URLs. Pass `--output DIRECTORY` only when the user requests a non-default destination.
4. Check source coverage before treating the snapshot as complete:

   ```bash
   cao audit-jsonl
   ```

   Pass `--input FILE` only when auditing a non-default JSONL path.
5. Prefer the reviewed named queries the dashboard itself renders. Discover and run them with:

   ```bash
   cao pages
   cao queries
   cao query-info QUERY_ID
   cao query QUERY_ID --limit 50
   ```

   Add `--json` to any of these for machine-readable output, and `--param NAME=VALUE`
   to narrow a query by a declared parameter. Prefer a query whose `execution.local`
   is `true`, and preserve the `availability`, `completeness`, `freshness`, and
   `as-of` metadata each result carries.
6. When no named query answers the question, query the downloaded SQLite projection with canonical collection names:

   ```bash
   cao query --collection runs --limit 20
   ```

7. Add filters with repeated exact-match `--where FIELD=VALUE` options. Use dotted fields for nested values when needed:

   ```bash
   cao query \
     --collection runs \
     --where conclusion=failure \
     --limit 20
   ```

   Pass `--database FILE` only when querying a non-default SQLite path.
8. For generated or complex queries, pass a raw Dashboard Language query object through standard input:

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

   `--database FILE` may be combined with `--stdin`; do not combine `--collection`, `--id`, `--where`, or `--limit` with it.
9. Query by ID when the user asks about one known record:

   ```bash
   cao query --collection sessions --id SESSION_ID
   ```

10. If database health is in doubt, run:

   ```bash
   cao doctor
   ```

   Use `--ttl-days all` only for intentional historical backfills.

## Collections

Use `cao help` for the current command syntax and collection list. The canonical query collections are:

- `repositories`
- `workflows`
- `runs`
- `jobs`
- `sessions`
- `events`
- `transactions`

## Analysis guidance

- Start broad with counts and recent records, then narrow with `--where` filters or record IDs.
- Prefer the SQLite projection for summaries and joins performed outside the browser.
- Use JSONL audit results to explain source completeness and enrichment coverage.
- Attribute findings to the collection, record ID, workflow, run ID, and timestamp whenever available.
- Report uncertainty explicitly when evidence is unavailable, stale, partial, or outside the requested scope.
- Keep downloaded `.cao/` files uncommitted.
