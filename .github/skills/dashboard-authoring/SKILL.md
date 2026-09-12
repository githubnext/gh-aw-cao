---
name: dashboard-authoring
description: Define one agentic-workflow dashboard intent and its operational-value contract.
---

# Dashboard Authoring

Create one dashboard that helps an operator decide whether a specific agentic workflow is running, producing accepted outcomes, and attaining its intended operational value.

## Procedure

1. Define one bounded workflow task and a concise, outcome-oriented intent.
2. Derive activation, required-effect, no-op, success, and uncertainty conditions.
3. Infer a design-time operational-value contract:
   - bind each run to one stable opportunity;
   - name accepted repository evidence and evidence repositories;
   - choose one direct attainment metric in `[0,1]`;
   - define maturation, zero, and missing-evidence rules;
   - use `attainment-only` unless immutable pre-adoption evidence supports a comparable baseline.
4. Define a compact dashboard intent with no more than four essential views per page. Every page must begin with a pie, line, histogram, or swimlane chart that serves as a visual executive summary of the most important signal, so an operator can understand it at a glance on a phone without scrolling. Prefer an operational summary, actionable findings, outcomes, and an operational-value trend.
   - Choose a pie chart for a current distribution, a line chart for a quantitative temporal trend, or a swimlane chart for categorical observations over time. Put supporting metrics, tables, and detail views after this chart.
   - Avoid nested chart boxes. Do not add a section solely to frame a chart; use sections only when their heading or grouping adds operator context.
5. Pass the intent and operational-value contract to `generate-dashboard-ir` with the provided Dashboard Language specification and validator.

## Graphical patterns

### Flat supplemental diagnostics

When a diagnostic page has one essential summary table and several supporting tables, render the summary first and make each supporting table a sibling `supplemental` disclosure. Omit layout sections so a table is not nested inside both a section and a disclosure.

## Data and database work

Before implementing a data-backed feature or modifying a database, write or update the normative requirements for both the SQL layer and the IndexedDB layer in [`specs/dashboard-data.md`](../../../specs/dashboard-data.md). Define the source contract, canonical mapping, identities and relationships, migration behavior, retention, failure handling, and SQL/IndexedDB parity before changing implementation code.

Follow the data-injection boundary documented in [`docs/dashboard-data-model.md`](../../../docs/dashboard-data-model.md): authoritative inputs pass through source adapters, canonical normalization, canonical storage, and the query layer before reaching a view. Views must not parse upstream logs or query storage directly. Treat browser IndexedDB and the local SQLite projection as disposable, reconstructable derived state.

Use the shared dashboard notification service only for brief, actionable runtime feedback. Keep durable findings, workflow outcomes, and operator attention items in Dashboard Language sources and views rather than transient notifications.

Use [`gh aw logs`](https://github.com/github/gh-aw/blob/main/docs/src/content/docs/troubleshooting/debugging.md) as the source of workflow-run evidence. The published `gh-aw-logs.jsonl` format is defined by the gh-aw [`logs-jsonl.schema.json`](https://github.com/github/gh-aw/blob/main/schemas/logs-jsonl.schema.json); consult that schema rather than inferring fields from fixtures or individual deployed records.

For live feature-development data, run `cao download`. It downloads the deployed Pages site's `gh-aw-logs.jsonl` and `gh-aw-logs.sqlite` unchanged into `.cao/` by default. Set `DASHBOARD_DATA_URL` or pass `--url URL` for another deployment, and pass `--output DIRECTORY` for another destination. Query the downloaded SQLite database with `cao query`, and use `cao help` for the supported collections and filters. Live data is development evidence, not a schema authority; keep code aligned with the specifications and JSONL schema.

Before treating a source as complete, run `cao audit-jsonl --input FILE`. Distinguish repeated source observations from duplicate canonical records, and distinguish run-summary coverage from enriched artifact coverage. Use a separate SQLite database plus `--retention-days all` and `doctor --ttl-days all` for historical backfills; do not turn browser IndexedDB into an archive.

## Package file convention

- Store an operation package's production Dashboard Language document at `<package>/dashboard.json`.
- Declare it in `<package>/aw.yml` as a resource whose destination is `.github/aw/dashboards/<package>.json`, where `<package>` is the package's canonical identifier.
- Keep each package dashboard independently valid. The dashboard package bundles installed `.github/aw/dashboards/*.json` documents into the single deployed `dashboard.json` that the browser loads.
- Do not add package pages directly to `dashboard/site/dashboard.json`; that file contains the built-in dashboard configuration.
