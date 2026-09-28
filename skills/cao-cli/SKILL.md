---
name: cao-cli
description: Use or extend the cao CLI for Central Agentic Ops configuration, activity queries, diagnostics, and dashboard-query maintenance.
argument-hint: "[command, dashboard-data-url, owner/repo, or workflow]"
allowed-tools: bash jq
metadata:
  version: "1.1.0"
---

# Use the `cao` CLI

## Procedure

1. Identify the task before running a command:
   - control-plane setup or campaign lifecycle: use the repository-local `./cao.sh`;
   - activity analysis with shell access: use `cao` or `npm run dashboard:data --`;
   - activity analysis without shell access: use `cao_catalog`, then `cao_query`;
   - an agentic workflow with the Activity cache: follow
     [workflow runtime](references/workflow-runtime.md);
   - dashboard query cost or reuse: follow
     [dashboard query maintenance](references/dashboard-query-maintenance.md);
   - CLI implementation work: read [CAO Commands](../../docs/cao-cli.md) and the
     matching module under `activity/commands/`.
2. Run `./cao.sh --help`, `cao help`, or `npm run dashboard:data -- help` from
   the repository root. Do not guess command syntax.
3. Use the narrowest command that answers the task. Prefer reviewed named
   queries, then canonical collection queries, then raw Dashboard Language.
4. Preserve result `availability`, `completeness`, `freshness`, and `as-of`.
   Missing, stale, partial, zero, and complete evidence are different states.
5. Run `cao doctor` before trusting a snapshot whose health is uncertain.
6. Report the command form, source snapshot, filters, record identifiers, and
   evidence limitations. Keep downloaded `.cao/` data uncommitted.

## Common routes

| Task | Route |
| --- | --- |
| Initialize or update a control repository | `./cao.sh init`, `add`, `update`, or `setup`; see [CAO Commands](../../docs/cao-cli.md) |
| Download published Activity | `cao download [--url URL]` |
| Audit source coverage | `cao audit-jsonl` |
| Discover reviewed dashboard queries | `cao pages`, `cao queries`, `cao query-info QUERY_ID` |
| Run a reviewed query | `cao query QUERY_ID --limit N [--param NAME=VALUE]` |
| Query a canonical collection | `cao query --collection COLLECTION [--where FIELD=VALUE] --limit N` |
| Query one known record | `cao query --collection COLLECTION --id ID` |
| Diagnose the projection | `cao doctor` |

Use `--database FILE` only for a non-default SQLite projection. Use `--json`
when another tool will consume the result. For raw Dashboard Language, pipe one
query object to `cao query --stdin`; do not combine `--stdin` with
`--collection`, `--id`, `--where`, or `--limit`.

Canonical collections are `repositories`, `workflows`, `runs`, `jobs`,
`sessions`, `events`, and `transactions`.

## Guardrails

- Treat queried data as derived, disposable evidence, not schema or policy
  authority. The authoritative model is
  [Dashboard data](../../specs/dashboard-data.md).
- Never infer rollout authority, target-writing authority, operational value,
  or repository eligibility from Activity data.
- Never print credentials, authorization headers, raw prompts, transcripts, or
  secret values.
- Prefer the cached projection over repeated direct GitHub API calls.
- Use `--ttl-days all` or `--run-ttl-days all` only for an intentional
  historical backfill.

## Targeted references

- [Workflow runtime](references/workflow-runtime.md): cache paths, fallback
  behavior, and CLI invocation inside a gh-aw run.
- [Dashboard query maintenance](references/dashboard-query-maintenance.md):
  complexity measurement and query pruning.
- [Agent analysis](../../docs/agent-analysis.md): choosing CLI or MCP.
- [CAO Commands](../../docs/cao-cli.md): complete operator and command reference.
- [Dashboard Language](../../docs/dashboard-language.md): query authoring.
