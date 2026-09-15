---
title: Persist global dashboard horizon and rollout-mode filters client-side
description: Record the client-side persistence and global sharing of dashboard horizon and rollout-mode filters decision.
---

# ADR 2715: Persist global dashboard horizon and rollout-mode filters client-side

## Status

Proposed

## Context

Dashboard horizon (time-range) and rollout-mode filter selections were previously authored per view in `.github/cao/dashboard/site/dashboard.json` (e.g. filter bars declaring `"mode:review"`, `"mode:live"`, `"mode:unknown"` tokens and `"time-range"` defaults). These settings were page-scoped: each view carried its own defaults, and there was no mechanism to share or persist a user's chosen horizon/mode across pages or sessions.

This PR changes that model. `.github/cao/dashboard/site/dashboard.json` had all per-view `"mode:*"` filter tokens and `"time-range"` defaults removed from filter-bar declarations, in several cases leaving `"filters": []`. `.github/cao/dashboard/site/src/filter-bar.js` gained a `HORIZON_FILTER_STORAGE_KEY` constant (`'central-agentic-ops.dashboard.horizon-filter-settings'`) along with code that writes settings via `globalThis.localStorage?.setItem(HORIZON_FILTER_STORAGE_KEY, JSON.stringify(settings))` and reads them back via `globalThis.localStorage?.getItem(HORIZON_FILTER_STORAGE_KEY)`. `.github/cao/dashboard/site/src/validator.js` was updated to reject filter tokens starting with `mode:` or `rollout-mode:` in page-level filter declarations. `docs/dashboard-language-specification.md` was updated (DLS-PAGE-017 and the filter-bar prose) to state that page `filter-bar` MUST NOT contain `mode` or `rollout-mode` filters, and that the presenter MUST provide time-horizon and rollout-mode controls whose values are "global client-side settings shared by all filter bars and persisted in local storage," with all rollout modes active by default.

## Decision

Horizon and rollout-mode filter state will be owned by the client, stored in `localStorage` under a single shared key, and applied globally across all dashboard filter bars, rather than being authored per view in `dashboard.json`.

Concretely:
- Views/pages may no longer declare `mode:*` or `rollout-mode:*` filter tokens or per-view time-range defaults in their `filter-bar.filters`; `validator.js` enforces this by rejecting those tokens in page filter declarations.
- Page `filter-bar.filters` may be an empty list when a page only needs the global horizon/mode controls (as seen in the updated `dashboard.json` entries).
- The `filter-bar` component (`filter-bar.js`) renders shared horizon and rollout-mode checkbox controls, persists the user's selections to `localStorage` (`HORIZON_FILTER_STORAGE_KEY`), and reads that value back to initialize state, so the selection is shared across filter bars on a page and across sessions.
- All rollout modes (`review`, `live`, `unknown`) are enabled by default, and a user may deselect all modes, which yields zero matching records rather than falling back to a default set.
- Non-mode, page-specific filters remain declarable per view and continue to be presenter-applied.

## Alternatives Considered

- **Continue authoring mode/time-range defaults per view in `dashboard.json`:** This was the prior approach. It required each view to redeclare the same `mode:review`/`mode:live` tokens (visible as repeated identical blocks removed across many pages in the diff) and gave users no way to change or persist a preference across pages or sessions.
- **Persist the setting server-side or per-user in some backend store:** Not evidenced by the diff — the implementation exclusively uses browser `localStorage` (`globalThis.localStorage`), with no server or backend persistence code changed.

## Consequences

**Positive:**
- Users get a single, consistent horizon/mode preference shared across all dashboard pages and filter bars, persisted across sessions via `localStorage`, without needing to re-select it per page.
- View authors no longer duplicate `mode:*`/`time-range` filter declarations across `dashboard.json` entries; several filter-bar declarations were simplified to `"filters": []`.
- The dashboard contract is now explicit (via `validator.js` and updated DLS-PAGE-017 documentation) that `mode`/`rollout-mode` are global, client-owned concerns and are disallowed in page-authored filter lists, preventing drift between page-declared and global filter semantics.
- Selecting no rollout modes is now a supported, explicit state (shows no matching records) rather than an unreachable or undefined configuration.

**Negative:**
- Filter state now depends on browser `localStorage`, which is scoped to the browser/device and cleared by private browsing, storage-clearing, or different devices — Not inferable from current pull request evidence whether any fallback or cross-device sync exists beyond the `globalThis.localStorage?.` optional-chaining guard.
- Existing dashboards or documentation/snapshots referencing per-view `mode:*` filter tokens must be migrated, since such tokens are now rejected by the validator (`validator.test.js` updated accordingly).
- Accessibility and test coverage surface area increased (new checkbox controls in `filter-bar.js`, expanded `filter-bar.test.js`, `smoke.spec.js`, and `validator.test.js`), representing added maintenance surface for the client-side settings model.
