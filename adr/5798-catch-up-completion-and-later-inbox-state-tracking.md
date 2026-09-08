# ADR 5798: Catch-up completion and Later inbox state tracking

## Status

Draft

## Context

The dashboard's Notifications inbox (`dashboard/site/src/components/notifications-inbox.js`) and the "Catch Up" home widget (`renderCatchUpContent`/`renderOperationalPulse`) previously tracked per-row read/saved/done state and a separate "queue" of catch-up stories using only a single identifier per row (`rowId`, derived from `attention-signal-id` or `scope:objective`). Notification rows in the inbox, however, can now be built by normalizing multiple distinct raw event sources (attention rows, outcome events, and matured operational-value events) into consolidated "stories" via `normalizeNotificationStories` (`dashboard/site/src/notification-stories.js`), and a single normalized story can be backed by several `contributingRawEventIds`. The prior single-ID state model could not reliably mark a normalized story as read/saved/done when the same underlying event surfaced under a different raw ID, and there was no persisted concept of deferring a catch-up story instead of completing it, nor a dedicated inbox view for deferred items. Additionally, the catch-up widget only supported a terminal "You're all caught up." message with no way to route the user back into the inbox to see items that had been deferred (PR #5798, fixes #5524).

## Decision

Introduce a `contributingRawEventIds`-aware state model and a persisted "Later" queue, backed by a dedicated `localStorage` key (`central-agentic-ops.dashboard.catch-up-queue`), reconciled with the story identity system, as follows:

- Add `rowStateIds(row)`, which returns the story's own `rowId` plus all of its `contributingRawEventIds`, and `hasRowState`/`setRowState` helpers that read and write state (`read`, `saved`, `done`) against that full set of IDs rather than a single ID. This lets any of a story's underlying raw events mark the consolidated story as read/saved/done.
- Add `markCatchUpStoriesDone(ids)`, which moves the given IDs from the catch-up queue's `later` set into its `done` set and removes them from the active `queue`, persisted via `readCatchUpQueueState`/`writeCatchUpQueueState` (existing functions extended, not replaced).
- Add an `is:later` search-filter token (alongside `is:read`/`is:unread`/`is:saved`/`is:done`) and a corresponding "Later" tab in the inbox's state-tabs UI, wired to the same search-query mechanism used for "Unread".
- Wire the "Mark as done" action and bulk-done action in the inbox to also call `markCatchUpStoriesDone`, and reconcile inbox visibility so stories in `catchUpState.done` are excluded from the rendered list.
- In the Catch Up home widget, replace the static "You're all caught up." text with `renderCaughtUp(laterCount, showNotifications)`, which renders a link that routes to the Notifications view pre-filtered to `is:later` (via a new `showNotifications` callback passed down through `renderOperationalPulse`/`renderCatchUpContent`) when deferred ("later") items exist, or back to a clear inbox otherwise.
- Introduce `inboxStories`/`outcomeStoryEvents`/`operationalValueStoryEvents` in the inbox component to build the same normalized story list (via `normalizeNotificationStories`) used elsewhere, so the inbox, search, grouping, and catch-up widget all reason about the same story identities and contributing raw event IDs.

## Alternatives Considered

- **Continue keying all read/saved/done/queue state by a single `rowId`.** This is the pre-existing approach in the codebase before this PR. It was evidently insufficient once a normalized story could be produced from multiple contributing raw events with different IDs, since marking one raw event's ID as done/read would not affect the story when it was later re-identified by a different contributing raw event ID.
- **Add a "Later" concept without a persisted queue, e.g., a purely in-memory/session-only deferred set.** The diff shows the `later`/`done` sets are read from and written to `localStorage` via `readCatchUpQueueState`/`writeCatchUpQueueState` and are asserted to survive across reloads in the added e2e test (`smoke.spec.js`), indicating persistence across sessions was a requirement rather than an in-memory-only alternative.

## Consequences

**Positive:**
- Marking a story read/saved/done or done via the catch-up flow now correctly applies to the consolidated story regardless of which contributing raw event ID triggered the action, per `rowStateIds`/`hasRowState`/`setRowState`.
- Users have a discoverable, persisted "Later" queue and inbox filter (`is:later`) for catch-up items they deferred rather than completed, with a direct deep link from the caught-up completion message into the pre-filtered Notifications view.
- The inbox, search/grouping, bulk actions, and the Catch Up widget now share the same story-normalization pipeline (`normalizeNotificationStories`), reducing divergence between how stories are identified in different parts of the dashboard.

**Negative:**
- The state model is more complex: every read/saved/done check and mutation must now iterate `rowStateIds` (a story ID plus all contributing raw event IDs) instead of checking a single key, increasing the surface area for state-consistency bugs.
- Two related but distinct persisted stores now exist (the existing read/saved/done `state` object and the new catch-up `later`/`done`/`queue` state in `central-agentic-ops.dashboard.catch-up-queue`), with `markCatchUpStoriesDone` and the inbox's "Mark as done" action both needing to be kept in sync to avoid a story appearing done in one store but not the other.
- Not inferable from current pull request evidence: any explicit rationale for choosing `localStorage` over another persistence mechanism, or performance/scale considerations for larger raw-event sets, since the PR description marks final validation (dashboard tests, lint, typecheck, secret scan, security review) as not yet complete (checkbox unchecked, title marked "[WIP]").
