---
name: analyze-agentic-ops
description: Download and query Central Agentic Ops activity data with the cao CLI.
argument-hint: "[dashboard-data-url-or-owner/repo]"
allowed-tools: bash jq
metadata:
  version: "1.0.0"
---

# Analyze Agentic Ops Data

Use this skill when a user asks to inspect, analyze, investigate, or summarize Central Agentic Ops activity data from the deployed dashboard snapshot or another published dashboard data URL.

## Data contract

- Treat downloaded data as local, disposable development evidence, not schema authority.
- Keep code and conclusions aligned with the dashboard data specifications and the `gh-aw-logs.jsonl` schema.
- Preserve the distinction between missing, stale, partial, zero, and complete evidence.
- Do not infer rollout authority, target-writing authority, operational value, or repository eligibility from activity data.
- Never print credentials, tokens, authorization headers, raw prompts, transcripts, or other secret values.

## Procedure

1. Confirm the repository has dependencies installed. If the `cao` binary is unavailable, use `npm run dashboard:data --` from the repository root.
2. Download the current published activity snapshot:

   ```bash
   cao download
   ```

   This writes `_activity/gh-aw-logs.jsonl` and `_activity/gh-aw-logs.sqlite`.
3. For another deployment, prefer the explicit source requested by the user:

   ```bash
   cao download --url URL --output _activity
   ```

   `DASHBOARD_DATA_URL=URL cao download` is equivalent. The URL must point at `gh-aw-logs.jsonl`; the CLI derives the sibling `gh-aw-logs.sqlite` URL.
4. Check source coverage before treating the snapshot as complete:

   ```bash
   cao audit-jsonl --input _activity/gh-aw-logs.jsonl
   ```

5. Query the downloaded SQLite projection with canonical collection names:

   ```bash
   cao query --database _activity/gh-aw-logs.sqlite --collection runs --limit 20
   ```

6. Add filters with repeated exact-match `--where FIELD=VALUE` options. Use dotted fields for nested values when needed:

   ```bash
   cao query \
     --database _activity/gh-aw-logs.sqlite \
     --collection runs \
     --where conclusion=failure \
     --limit 20
   ```

7. Query by ID when the user asks about one known record:

   ```bash
   cao query --database _activity/gh-aw-logs.sqlite --collection sessions --id SESSION_ID
   ```

8. If database health is in doubt, run:

   ```bash
   cao doctor --database _activity/gh-aw-logs.sqlite
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
- Keep downloaded `_activity/` files uncommitted.
