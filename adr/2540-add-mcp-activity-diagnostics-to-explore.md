---
title: Add MCP activity diagnostics to Explore
description: Record the dashboard MCP diagnostics view for reliability, payload size, and version telemetry across agentic workflow runs.
---

# ADR 2540: Add MCP activity diagnostics to Explore

## Status

Proposed

## Context

The dashboard did not previously expose an Explore view for diagnosing MCP (Model Context Protocol) server behavior across agentic workflow runs — operators had no in-dashboard way to see MCP call reliability, response payload sizes, or observed server/protocol versions.

This pull request extracts MCP telemetry from AW run summaries in `.github/cao/dashboard/report/aic-usage.mjs`: a new `telemetry.mcp` structure (`available`, `cliVersion`, `servers`, `calls`, `failures`) is populated from `summary.cli_version`, `summary.mcp_tool_usage.servers`, `summary.mcp_tool_usage.tool_calls`, and `summary.mcp_failures`. Fields are bounded and defensively coerced (e.g., `Math.max(0, Number(...) || 0)` for counts and sizes), and unavailable telemetry is represented explicitly via `available: false` rather than omitted, with corresponding `mcpAvailable`/`mcpComplete` run-summary flags. Server error details are not carried into the telemetry shape (only `serverName` and `status` are extracted for failures), consistent with excluding sensitive error details.

`.github/cao/dashboard/report/dashboard-language-sources.mjs` adds two new logical sources, `mcp-calls` and `mcp-servers`, registered in `sourceNames`. `mcpCallRows` emits one row per observed call (and one per failure), including `mcp-server`, `mcp-server-version`, `mcp-protocol-version`, `mcp-tool`, `mcp-status` (normalized to `success`/`failure`/`missing` via `mcpStatus`), and `response-bytes`, with a `mcp-observation` id preserving `repository:runId:...` attribution back to the workflow run (`mcpBase` also attaches `workflow`, `run`, `rollout-mode`, `gh-aw-version`, and a `run-link`). `mcpServerRows` aggregates per-server call counts, failure counts, and response byte totals/maxima, merging explicit `servers` metadata with any calls/failures not already reported.

`.github/cao/dashboard/site/dashboard.json` adds an `mcps` custom page ("MCP activity") with three views: a status-distribution pie/table (`mcp-servers`), a response-payload-size histogram (`mcp-calls`), and a server-inventory table (`mcp-servers`) showing server/protocol/gh-aw versions, call counts, failures, and response byte totals, ordered by failed calls then max response size. `.github/cao/dashboard/site/src/specification.js` is updated (+12/-1) to support the new source/view configuration, and unit tests are added/extended in `presenter.test.js`, `validator.test.js`, `dashboard-language-sources.test.mjs`, and `dashboard-security-telemetry.test.mjs`.

Not inferable from current pull request evidence: specific stakeholder requests, prior incidents motivating this feature, performance or scale considerations, or any explicit rejection of alternative designs.

## Decision

Add a dedicated "MCPs" Explore view to the dashboard that:

- Extracts bounded MCP telemetry (calls, servers, versions, payload sizes, failures) from existing AW run summaries in the report-generation pipeline (`aic-usage.mjs`), preserving unavailable telemetry as an explicit `available: false` state rather than silently omitting it, and excluding sensitive error details from the extracted shape.
- Introduces two new logical dashboard-language sources, `mcp-calls` and `mcp-servers`, each row carrying workflow-run attribution (`repository`, `workflow`, `run`, `run-link`) for drill-down.
- Renders three views on a new `mcps` dashboard page: success/failure/missing rate, response payload-size distribution, and an observed-server inventory (server name, server version, protocol version, gh-aw version, call/failure counts, response byte totals).
- Follows the existing pattern used elsewhere in the dashboard (e.g., `security-observations`, `usage`) of deriving flattened, per-observation rows from nested run telemetry rather than introducing a new storage or query layer.

This is additive to the dashboard's existing report/data-generation pipeline and site components; it does not introduce new write or execution capability, and does not change how MCP calls themselves are made or how run summaries are produced upstream.

## Alternatives Considered

Not inferable from current pull request evidence — the PR body and diff do not document alternative designs that were considered or rejected (e.g., whether MCP telemetry could have been folded into the existing `security-observations` source instead of two new sources, or whether a separate standalone diagnostics tool outside the dashboard was evaluated).

## Consequences

**Positive:**
- Operators can assess MCP reliability (success/failure/missing rates), spot outsized response payloads, and see observed server/protocol/gh-aw versions without leaving the dashboard.
- Per-row workflow-run attribution (`run-link`, `repository`, `workflow`, `run`) allows drill-down from aggregate diagnostics to the originating run.
- Explicit "missing" telemetry states (rather than silent omission) make gaps in MCP instrumentation visible instead of hidden.
- Sensitive error details are excluded from the extracted telemetry shape, limiting exposure of potentially sensitive failure information.
- The feature reuses the existing dashboard-language source/view pipeline, keeping the addition consistent with prior patterns (e.g., `security-observations`, `usage`).

**Negative:**
- Two additional logical sources (`mcp-calls`, `mcp-servers`) and associated row-building logic (`mcpBase`, `mcpStatus`, `mcpCallRows`, `mcpServerRows`) increase the size and maintenance surface of `dashboard-language-sources.mjs`.
- The `dashboard.json` configuration grows by 166 lines to describe the new page and its three views, increasing the size of the dashboard configuration bundle.
- Server/call telemetry is bounded and defensively coerced but still depends on the shape and availability of `summary.mcp_tool_usage` and `summary.mcp_failures` in AW run summaries; malformed or absent upstream data degrades to the explicit "missing" state.
- Not inferable from current pull request evidence: any performance, security review, or accessibility implications beyond what is described in the PR body.
