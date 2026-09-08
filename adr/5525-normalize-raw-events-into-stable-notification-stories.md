# ADR 5525: Normalize raw events into stable notification stories keyed by object identity

## Status

Draft

## Context

Raw attention signals and operational events (attention/outcome/operational-value rows in the notifications inbox) lacked a durable, object-level identity. As a result, multiple raw events referring to the same underlying pull request, issue, workflow run, deployment, or security finding could appear as independent entries in the Catch Up view instead of being recognized as updates to the same object. The prior deduplication approach in `catchUpStories()` was based on matching titles, which does not reliably capture object identity when titles change, are reused, or are absent.

The changed files show this was addressed by introducing a new normalization module, `dashboard/site/src/notification-stories.js` (+211 lines), which parses each raw event for a repository (from explicit fields or `github.com` URLs), an object identity via `linkedObject()` (recognizing pull requests, issues, workflow runs, deployments, and namespaced security findings, with a fallback to `work-item`/`event`), and canonicalizes string and numeric identifiers. `dashboard/site/src/components/notifications-inbox.js` was refactored (+28/-20) to attach raw fields (`event-id`, `classification`, `objectType`, `objectId`, `deepLink`) onto rows and pipe them through the new `normalizeNotificationStories()` function instead of the prior ad hoc title-based dedup. Raw events are retained (not discarded) for evidence and debugging purposes. New unit tests (`dashboard/site/test/unit/notification-stories.test.js`, +138) validate the normalization behavior.

## Decision

Group raw notification events into stable "stories" by object-level identity rather than by title matching. Specifically:

- Derive, for each raw event, a raw event id (`rawEventId`), a repository (`eventRepository`), and an object identity (`eventObject`) — one of pull-request, issue, workflow-run, deployment, security-finding (namespaced), work-item, or event — via `linkedObject()` parsing of explicit fields or `github.com` URL paths.
- Canonicalize string and numeric identifiers for objects without merging unrelated objects.
- Group raw events into a story keyed by `JSON.stringify([repository, objectType, objectId])`, sorted by timestamp descending with a stable tiebreaker, producing exactly one story per group.
- Emit each story with a stable id of the form `notification-story:<repo>:<objectType>:<objectId>`, along with the latest classification, title, detail, timestamp, best available deep link, the minimum priority across contributing events, and a sorted, deduplicated list of contributing raw event ids.
- Replace the prior title-based highlight deduplication in Catch Up (`catchUpStories()`) with this normalized-story grouping, while preserving existing deep-link behavior and presentation (`renderCatchUpStory` now reads `story.classification`/`story.deepLink` instead of `story.origin`/`story.href`).
- Retain raw events unchanged for evidence and debugging; stories are a derived, additive layer.

## Alternatives Considered

- **Continue title-based deduplication**: The prior approach grouped/deduplicated highlights by matching titles. This was replaced because titles do not provide a durable object-level identity, causing related events (e.g., multiple updates to the same pull request or workflow run) to appear as independent entries. Any further rationale for why title matching was deemed insufficient beyond this is not inferable from current pull request evidence.
- **Discarding raw events after normalization**: Not inferable from current pull request evidence as an alternative that was actually considered; however, the PR explicitly retains raw events "for evidence and debugging" alongside the new normalized stories, indicating a deliberate choice to keep both representations rather than replacing raw events entirely with the story abstraction.

## Consequences

**Positive:**
- Related events about the same pull request, issue, workflow run, deployment, or security finding are now grouped into a single story instead of appearing as independent, possibly duplicated entries, improving the coherence of the Catch Up view.
- Object identity is derived from structured fields and URL parsing rather than free-text titles, making grouping robust to title changes or reuse.
- Raw events are preserved unchanged, retaining an evidence/debugging trail even after normalization.
- Existing deep-link behavior and presentation are preserved, minimizing disruption to the Catch Up user experience.
- New unit tests (`notification-stories.test.js`, +138 lines) validate the normalization logic.

**Negative:**
- Not inferable from current pull request evidence: no information is given about performance impact of grouping/sorting raw events, or behavior at scale with large volumes of raw events.
- Not inferable from current pull request evidence: no discussion of how events that cannot be matched to a recognized object type (falling back to `work-item`/`event`) are handled downstream, or whether this could still produce fragmented stories for unrecognized event sources.
- Not inferable from current pull request evidence: no migration or backward-compatibility concerns are documented regarding consumers that previously relied on `story.origin`/`story.href` fields now replaced by `story.classification`/`story.deepLink`.
