---
title: Data ingestion
description: Understand how Central Agentic Ops collects, normalizes, retains, and projects dashboard data.
---

Data ingestion moves operational evidence from GitHub Actions into the browser
dashboard and local tools. Read this page to understand collection boundaries,
retention, failure behavior, and the available `cao` commands. For entity
identities and relationships, use the [Data model](dashboard-data-model.md).

## Data flow

Agentic workflows produce Actions logs. The Activity workflow collects a bounded snapshot into published JSONL. Consumers apply the shared model rules to build two separate projections: SQLite supports agents and command-line tools, while IndexedDB supports the browser dashboard.

<div class="docs-theme-diagram">
  <img class="docs-theme-diagram-light" alt="Agentic workflow logs are collected by Activity into JSONL, then the shared data model produces SQLite for agents and CLI tools or IndexedDB for dashboard views" src="/gh-aw-cao/assets/dashboard-data-flow-light.svg">
  <img class="docs-theme-diagram-dark" alt="Agentic workflow logs are collected by Activity into JSONL, then the shared data model produces SQLite for agents and CLI tools or IndexedDB for dashboard views" src="/gh-aw-cao/assets/dashboard-data-flow-dark.svg">
</div>

SQLite and IndexedDB are rebuildable projections. Neither is the source for the
other. The local SQLite adapter implements the same logical object stores,
indexes, records, conversion rules, and queries as browser IndexedDB. It is not
a separate relational canonical schema. Both keep all run summaries available
in the published JSONL. Detailed Domain, Tool, Audit, and Issue records remain
bounded to 30 days unless a separate full-detail SQLite archive is requested.

See [Data model](/gh-aw-cao/dashboard-data-model/) for the canonical entities, identities, and relationships produced by ingestion.

## Completeness and duplicates

The scheduled Activity workflow is a rolling operational snapshot, not a full historical archive. Data can be incomplete at these boundaries:

| Boundary | What can be missing |
| --- | --- |
| Collection | Runs outside the configured 30-day window. |
| Enrichment | The scheduled command downloads at most five matching usage artifacts across all workflow targets per Activity invocation. |
| GitHub retention | Expired or unavailable artifacts cannot provide agent, usage, job, or audit detail. The run summary may still exist. |
| Mapping | GitHub API rate-limit records without collection context are intentionally not attached to a run. |
| Browser storage | IndexedDB keeps all published run summaries and expires detailed Domain, Tool, Audit, and Issue records after 30 days. |

Cached JSONL can repeat the same run in later snapshots. These are repeated observations, not duplicate database records. Raw runs are deduplicated by GitHub run ID and attempt. Enriched runs are deduplicated by run ID and attempt, with the newest observation winning.

Audit a JSONL source without changing a database:

```bash
cao audit-jsonl
```

The report separates raw observations, unique raw runs, enriched observations, unique enriched runs, repeated observations, unenriched runs, and the canonical record counts that ingestion will produce.

## Create a historical archive

For a full-detail local archive, collect into `_activity/gh-aw-history.jsonl`, then audit and ingest it with unbounded retention:

```bash
cao audit-jsonl \
  --input _activity/gh-aw-history.jsonl

cao ingest-jsonl \
  --database _activity/gh-aw-history.sqlite \
  --input _activity/gh-aw-history.jsonl \
  --retention-days all

cao doctor \
  --database _activity/gh-aw-history.sqlite \
  --ttl-days all
```

"Full" means all run summaries discoverable in the selected range plus every artifact still available from GitHub. Expired artifacts remain visible as unenriched runs rather than being silently counted as complete.

## Browser data pipeline

The activity shard manifest is the dashboard's published operational input. The worker downloads and processes each listed schema-v2 JSONL shard independently through a versioned ingestion expression. Raw `workflow_runs` payload rows create Repository, Workflow, and Run observations. Enriched `run` envelopes update the same Run identities and create deterministic Domain, Tool, Audit, and Issue records owned directly by those Runs. `github_api_rate_limit` envelopes create Audits only when explicit collection context identifies their owning run; browser ingestion does not fabricate that ownership. Unknown kinds and unsupported non-empty schema versions fail explicitly.

The complete normative [cached gh-aw JSONL mapping](https://github.com/githubnext/gh-aw-cao/blob/main/specs/dashboard-gh-aw-jsonl-mapping.md) describes source fields, canonical entities, identity, ownership, and accounting.

The canonical model is version 17. The browser database is
`gh-aw-cao-dashboard-data`, IndexedDB version 25. Its canonical stores are
`campaigns`, `repositories`, `workflows`, `runs`, `domains`, `tools`, `audits`,
and `issues`, and `operationalValues`; all use `id` as the key. The `transactions` store records
ingestion outcomes and is indexed by `createdAt`. The disposable
`dailyOverviewAggregates` and `overviewAggregateMetadata` stores implement the
Overview fast path. Because the database is derived state, physical schema
upgrades rebuild every store from authoritative dashboard inputs.

For each ingestion, the worker reads the existing canonical batch, merges incoming records, expires time-bounded records outside the 30-day retention window, and prunes orphaned descendants and unreferenced structural parents. The effective retention horizon is the later of the browser clock and the newest incoming observation, so a browser with a slow clock cannot prune current producer data. The worker then replaces each canonical collection, deleting records absent from the retained batch and writing every retained record.

Every merged batch must satisfy these relationships:

- Workflow to Repository
- Run to Repository and Workflow
- Domain, Tool, Audit, and Issue to Run

Work items and findings are projected from Issue and Audit records rather than stored in separate canonical tables. Independent logical sources, such as usage, outcomes, admissions, security, and MCP evidence, retain their published schemas in worker memory and are selected only when a page requests them.

Source download, adaptation, normalization, IndexedDB writes, and page queries
run in a dedicated Web Worker. Successful inputs write content-addressed
receipts containing the ingestion version, payload identity, and retained or
committed record counts. A failure writes a diagnostic receipt when possible.
Bounded writes that committed before a later failure may remain in the
disposable database, but no successful receipt is written and the shard remains
retryable.

Worker errors abort the update instead of rerunning ingestion through an older path. There is no shadow, dual-read, alias, or fallback route. Views render only after the worker returns that page's query projection.

Before ingestion, the browser inspects its storage estimate and requests persistent storage when the API is available. Either request may be denied or fail without affecting correctness. Diagnostics use stable categories such as `NORMALIZATION_FAILED`, `TRANSACTION_ABORTED`, and `QUOTA_EXCEEDED`.

IndexedDB is disposable derived state. Clearing browser storage reconstructs it from authorized published inputs; it does not delete authoritative information.

## SQL interchange

SQL uses the versioned `gh-aw-cao.dashboard-sql-export` interchange contract. Database owners map their schema to the contract and export static JSON before deployment. Local and deployed environments use the same contract, validator, adapter, and canonical queries; the static dashboard never opens a database connection.

## Use local SQLite

Node.js 24 can run the same ingestion and query layer against a persistent
SQLite file. The local adapter stores IndexedDB metadata and JSON records in
`__idb_databases`, `__idb_stores`, `__idb_indexes`, and `__idb_records`; those
tables are an emulation detail, not canonical entity tables. The browser
continues to use native IndexedDB.

Ingest an extracted gh-aw log directory with its run context:

```bash
cao ingest \
  --database /tmp/cao-dashboard.sqlite \
  --context dashboard/site/test/fixtures/gh-aw-logs/context.json \
  --logs dashboard/site/test/fixtures/gh-aw-logs/run-303
```

Alternatively, ingest schema-v2 JSONL produced by `gh aw logs`:

```bash
cao ingest-jsonl \
  --database /tmp/cao-dashboard.sqlite \
  --input-dir .cao/gh-aw-logs-shards
```

Pass `--context CONTEXT_JSON` when JSONL `github_api_rate_limit` records should become canonical Audits. Without an owning collection Repository, Workflow, and Run, those records remain unmapped.

Download the JSONL and SQLite projection published by the deployed CAO Pages site:

```bash
cao download
```

This writes `.cao/payload-hashes.json`, the published compacted
`.cao/gh-aw-logs-runs/` and `.cao/gh-aw-logs-records/` shards, and
`.cao/gh-aw-logs.sqlite` by default. Set `DASHBOARD_DATA_URL`, pass `--url URL`,
or pass `--output DIRECTORY` to change the source or destination. The command
downloads the published files unchanged; it does not run ingestion locally.

Query a canonical collection:

```bash
cao query \
  --collection runs \
  --where conclusion=failure \
  --limit 20
```

Use the gh-like query surface for familiar GitHub CLI-shaped commands:

```bash
cao gh runs --repo OWNER/REPOSITORY --workflow WORKFLOW --status failure --since 2026-09-01 --until 2026-09-15
cao gh issues --repo OWNER/REPOSITORY --workflow WORKFLOW --since 2026-09-01 --until 2026-09-15
cao gh prs --repo OWNER/REPOSITORY --workflow WORKFLOW --since 2026-09-01 --until 2026-09-15
```

`-R`, `-w`, `-s`, and `-L` alias `--repo`, `--workflow`, `--status`, and `--limit`. The default limit is 30. Date-only `--until` values include the entire date. Issue and pull request results come from canonical Issue records created by `safe_output.created` observations.

Diagnose and repair the local database:

```bash
cao doctor \
  --database /tmp/cao-dashboard.sqlite
```

The doctor reports SQLite integrity, foreign-key and schema health, table and transaction counts, malformed records, and relationship errors. It applies retention, removes malformed and orphaned derived records, repairs metadata, and runs SQLite maintenance. Before changing data, it creates a timestamped `.doctor-backup-*.sqlite` backup next to the database.

Run `cao help` for the collection list and full command syntax. The SQLite file remains local derived state and does not change the static dashboard's deployment boundary.

For normative requirements and failure behavior, see the [Dashboard Data Architecture Specification](https://github.com/githubnext/gh-aw-cao/blob/main/specs/dashboard-data.md).
