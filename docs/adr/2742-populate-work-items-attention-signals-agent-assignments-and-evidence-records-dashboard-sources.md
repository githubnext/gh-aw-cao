---
title: Populate Dashboard Work-Item Sources
description: Record the decision to populate work-item dashboard sources from telemetry.
---

# ADR 2742: Populate work-items, attention-signals, agent-assignments, and evidence-records dashboard sources

## Status

Proposed

## Context

The "Dashboard Next" pages (Home, Work, Agents, Evidence) always rendered "This view is not available." The four sources they depend on — `work-items`, `attention-signals`, `agent-assignments`, `evidence-records` — were registered in the schema and wired into the UI (per ADR 2572), but the report generator never computed real rows for them.

The root cause was in `.github/cao/dashboard/report/dashboard-language-sources.mjs`: every declared source name was initialized to an empty/unavailable placeholder via `Object.fromEntries(sourceNames.map((name) => [name, source(name, [], generatedAt, false, false)]))`, and only some sources (`runs`, `outcomes`, `workflows`, ...) were ever selectively overwritten with real computations. The four work-oriented sources were never given a computation path, so the placeholder remained the final answer regardless of underlying telemetry.

## Decision

Compute the four work-oriented dashboard sources by joining existing telemetry sources, keyed by `${organization}/${repository}:${workflow}`, and overwrite their placeholder entries with the computed rows and derived availability/completeness metadata:

- **`work-items`**: one row per workflow, joined with its latest run and latest matching outcome (keyed by `${organization}/${repository}:${workflow}`), deriving `lifecycle-state`, `phase`, `reason`, `next-action`/`next-actor`, `waiting-on`, `verification-state`, `consequence-tier`, etc.
- **`attention-signals`**: derived from work items in `blocked`/`waiting` lifecycle states, surfaced as unresolved conditions ordered by deterministic priority.
- **`agent-assignments`**: derived from the engine/model assigned to each work item's latest run, with derived `handoff-state`, `dependency-state`, and `conflict-state` (flagging contended work items with multiple active assignments).
- **`evidence-records`**: derived from outcomes and findings linked back to their originating work item, with `verification-state`/`provenance-state`.

Availability and completeness metadata for these sources now reflects actual workflow/run telemetry (e.g. `workItemsAvailable`, `workItemsComplete`, `usageComplete`, `evidenceAvailable`, `reportComplete`) instead of always being `false`, so downstream UI can distinguish genuinely unavailable data from computed-but-partial data.

This decision concerns only the row-computation/join logic added in this PR; the prior decision to register these four sources and wire them into the UI/home-page layout is recorded separately in ADR 2572.

## Alternatives Considered

Not inferable from current pull request evidence.

## Consequences

**Positive:**

- The Home, Work, Agents, and Evidence dashboard pages can now render real data instead of always showing "This view is not available," since the four sources are populated from actual workflow/run/outcome/finding telemetry.
- Availability/completeness flags for these sources are now derived from real computation state (e.g. `workItemsComplete && usageComplete`, `evidenceAvailable && workItemsComplete && reportComplete`), giving consumers a more accurate signal about data completeness than the previous always-`false` placeholder.
- Cross-source joins are keyed consistently by `${organization}/${repository}:${workflow}`, giving `work-items`, `attention-signals`, `agent-assignments`, and `evidence-records` a shared, traceable link back to the underlying workflow/run/outcome/finding records.

**Negative:**

- Not inferable from current pull request evidence (e.g., no migration, performance, or scaling impact is described in the PR evidence).
