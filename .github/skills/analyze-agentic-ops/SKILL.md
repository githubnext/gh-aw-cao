---
name: analyze-agentic-ops
description: Analyze CAO dashboard data with the Sallie dashboard CLI and express findings as Dashboard Language JSON queries and views.
argument-hint: Operational question, scope, and desired visualization
---

# Analyze Agentic Ops

Use the Sallie dashboard CLI to inspect deployed Central Agentic Ops evidence, then express the analysis as declarative Dashboard Language JSON. Keep data retrieval, analysis, and visualization separate.

## Locate the installed tools

Prefer the paths installed by the CAO package:

- Sallie CLI: `.github/aw/dashboard/site/scripts/ingest-gh-aw-logs.mjs`
- Dashboard Language specification: `.github/aw/specs/dashboard-language-specification.md`
- built-in dashboard examples: `.github/aw/dashboard/site/dashboard.json`
- local preview: `.github/aw/dashboard/local-server.mjs`

In the CAO catalog source checkout, use `dashboard/site/scripts/ingest-gh-aw-logs.mjs`, `docs/dashboard-language-specification.md`, `dashboard/site/dashboard.json`, and `dashboard/local-server.mjs` instead.

Read the specification and relevant built-in queries and views before authoring JSON. The specification is authoritative; the built-in dashboard demonstrates established combinations of queries, marks, encodings, links, controls, and data-state behavior.

## Acquire evidence

1. Set the CLI paths for the current checkout, using the catalog alternatives above when the installed paths are absent:

   ```bash
   SALLIE_CLI=.github/aw/dashboard/site/scripts/ingest-gh-aw-logs.mjs
   SALLIE_PREVIEW=.github/aw/dashboard/local-server.mjs
   ```

   Run `node "$SALLIE_CLI" help` before relying on remembered options.
2. Download into a disposable directory:

   ```bash
   node "$SALLIE_CLI" download --output /tmp/cao-dashboard-data
   ```

   The default deployment supplies `gh-aw-logs.jsonl` and its sibling `gh-aw-logs.sqlite`. To inspect another deployment, pass the direct HTTPS URL of its `gh-aw-logs.jsonl` with `--url`. Never put credentials in the URL.
3. Audit source coverage before drawing conclusions:

   ```bash
   node "$SALLIE_CLI" audit-jsonl --input /tmp/cao-dashboard-data/gh-aw-logs.jsonl
   node "$SALLIE_CLI" doctor --database /tmp/cao-dashboard-data/gh-aw-logs.sqlite
   ```

4. Treat stale, partial, unavailable, or unenriched evidence explicitly. Do not convert missing evidence into zero, healthy, successful, or complete.

## Query canonical data

Use `query` for bounded inspection of the canonical database:

```bash
node "$SALLIE_CLI" query \
  --database /tmp/cao-dashboard-data/gh-aw-logs.sqlite \
  --collection runs \
  --where repository=OWNER/REPOSITORY \
  --limit 100
```

The CLI supports the collections listed by `help`, exact `--id` lookup, repeated exact-match `--where FIELD=VALUE` filters, and a positive `--limit`. Start with a small limit, inspect returned field names and values, then narrow further. Preserve the output as evidence; do not invent fields that are absent.

The CLI collection query is an evidence-inspection operation, not raw SQL and not a Dashboard Language query executor. Use it to understand canonical records. Put reusable joins, computed fields, filters, aggregation, projection, ordering, and limits in `dashboard.queries`, where the dashboard data worker evaluates them under the specification.

## Turn the analysis into a view

1. State the operational question and identify the source grain that can answer it.
2. Reuse a built-in query or view when it already answers the question. Do not modify a view marked `locked: true`.
3. If shaping is required, add one named query under `dashboard.queries`:
   - include a concise `intent`;
   - read a canonical source or an earlier query;
   - keep dependencies acyclic and declaration-ordered;
   - use only specified joins, predicates, computed functions, reducers, projections, ordering, and limits;
   - preserve unique output names and fail closed when evidence is unavailable.
4. Add a custom page view whose `data.source` names the canonical or derived source:
   - use `metric` for one aggregate;
   - use `table` for actionable or record-level evidence;
   - use `chart` for a comparison, distribution, or trend;
   - define only the mark-specific encoding channels allowed by the specification;
   - include links to repository, workflow, run, issue, pull request, or evidence records when the selected source provides them.
5. Keep the document strict JSON with the exact Dashboard Language vocabulary and `"language-version": "0.1.0"`. Do not add SQL, scripts, templates, arbitrary expressions, presenter-specific transforms, or invented source fields.
6. Keep unavailable and empty states honest. Include enough visible context to identify scope, time range, filters, and evidence freshness.

## Validate and preview

Write or update the appropriate `.github/aw/dashboards/<package>.json` document. Validate it with the repository's dashboard validator when available, then preview the composed dashboard:

```bash
node "$SALLIE_PREVIEW" --repo OWNER/CONTROL-REPOSITORY
```

The preview composes the built-in dashboard with installed package dashboards and rejects invalid updates while retaining the last valid document. Resolve every validation error before reporting completion. Report the evidence source, effective scope and horizon, query and view IDs, data-health limitations, and the operational conclusion.
