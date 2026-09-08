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

## Package file convention

- Store an operation package's production Dashboard Language document at `<package>/dashboard.json`.
- Declare it in `<package>/aw.yml` as a resource whose destination is `.github/aw/dashboards/<package>.json`, where `<package>` is the package's canonical identifier.
- Keep each package dashboard independently valid. The dashboard package bundles installed `.github/aw/dashboards/*.json` documents into the single deployed `dashboard.json` that the browser loads.
- Do not add package pages directly to `dashboard/site/dashboard.json`; that file contains the built-in dashboard configuration.
