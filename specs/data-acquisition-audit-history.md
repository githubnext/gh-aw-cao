---
title: Central Agentic Ops Data Acquisition Audit History
description: Compact dated refresh ledger for the data acquisition audit.
version: 1.0.0
status: Working Draft
editors:
  - GitHub Next
---

# Central Agentic Ops Data Acquisition Audit History

This ledger records material refreshes for [Central Agentic Ops Data Acquisition Audit](./data-acquisition-audit.md). It is intentionally compact so the audit document can focus on current acquisition paths, duplicate work, bottlenecks, and recommendations.

| Date | Refresh | Material acquisition delta | Non-material changes noted |
| --- | --- | --- | --- |
| 2026-09-06 | API-free activity index | The activity workflow now updates its cache with one `gh aw logs --json` call immediately after restore, requesting bounded evidence sets while excluding heavy agent artifacts. `activity/index.mjs` reads only checked-out metadata and that snapshot, performs no GitHub API operations, and records missing usage-artifact fields for follow-up in gh-aw. | Policy targets are no longer treated as repositories whose unrelated workflows should be scanned. |
| 2026-09-06 | Shared activity log cache | The activity workflow now invokes `gh aw logs --json` once, passing the workflow targets of every deployed workflow with recorded runs, and persists the returned logs plus requested artifacts. AIC, security, and operational-value collection process that shared snapshot; per-workflow operational-value reports and fallback artifact downloads were removed. | Core quota remaining is emitted alongside each telemetry observation without exposing credential values. |
| 2026-09-05 | Third material refresh | Added `.github/workflows/self-care-dashboard-review.md`: live prefetch reads the target default branch, lists up to 100 `central-agentic-ops-dashboard` artifacts, validates the selected run, downloads the dashboard artifact, and the agent separately queries workflow registry plus latest 100 runs from the last 24 hours. This duplicates artifact/run discovery already covered by `activity/index.mjs` and `dashboard/report/records.mjs`; see §3.2 and §5 item 11. | `route-composition.js` / `workflow-route-composition.js` extraction and `PLAYWRIGHT_BROWSERS_PATH` env scoping do not change collection, predownload, indexing, or caching behavior. |
| 2026-09-05 | Second material refresh | `activity/github-telemetry.mjs` adds bounded call-stack metadata to the existing per-phase `gh api rate_limit` ledger entries. The same eight per-run probes remain; this adds attribution metadata, not a new request. | `dashboard/local-server.mjs` WebSocket Copilot protocol and host allowlisting keep the same one artifact-list query plus one artifact download. `self-care-dashboard-performance.md` evidence-artifact path rename does not change GitHub API or `gh aw logs` behavior. |
| 2026-09-05 | Material refresh | Added `self-care-dashboard-performance.md`: Lighthouse/Playwright dashboard audits persist only `/tmp/gh-aw/cache-memory/dashboard-performance-rotation.json` and upload evidence; no `gh aw logs`, direct GitHub API, REST, or GraphQL acquisition path was added. | `max-daily-ai-credits: -1`, direct `shared/control.md` imports, and dashboard component/grader packaging refactors do not change inventoried acquisition behavior. |
| 2026-09-04 | Material refresh | Imported PR automation (`design-decision-gate.md`, `mattpocock-skills-reviewer.md`, `pr-sous-chef.md`) and `self-care-open-source-failures.md` added prefetch/N+1 paths now reflected in §3.3 and §5 items 9-10. | `ambient-context` consolidated into `AW Optimization`; `aw-maintenance.md` renamed to `aw-doctor.md`. These are path/dispatch topology renames, with existing N+1 and grader acquisition behavior unchanged. |
