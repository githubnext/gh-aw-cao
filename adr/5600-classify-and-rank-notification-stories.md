# ADR 5600: Classify notification stories into three relevance tiers and rank via composite deterministic sort key

## Status

Draft

## Context

The notification inbox previously ordered stories by `timestamp desc, then id asc` and exposed each story's raw source-provider classification directly to the UI (via `eventClassification()` in `dashboard/site/src/notification-stories.js`), meaning actionable items (mentions, review requests, failures, security findings) had no guaranteed precedence over passive updates, and users had no consistent signal for what required their attention versus what was merely informational. Per the PR body, "actionable items [must] precede passive updates," motivating a need for "consistent relevance labels and deterministic ordering."

The core change is in `dashboard/site/src/notification-stories.js` (+111/-19 lines): it renames the old `eventClassification()` to `eventSourceType()` (preserving the raw source-type string used for origin badges) and introduces a new `storyClassification(event, objectType, title)` function that derives exactly one of `needs_you`, `update`, or `fyi` per story via ordered regex/text matching over classification/signal-type/event-type/outcome-state/run-conclusion/lifecycle-state/type fields, action/next-action/title text, and expected-actor text. It also adds `STORY_CLASS_RANK` (needs_you=0, update=1, fyi=2) and `CONSEQUENCE_RANK` (critical=0, high=1, medium/moderate/warning=2, low=3, informational/info=4) maps, a `numericPriority()` null-safe helper, and a `consequenceRank(events)` function computing the minimum severity across several possible severity-bearing fields, falling back to numeric `priority`.

Two dependent files confirm the split between relevance classification and source identity: `dashboard/site/src/components/notifications-inbox.js` (+2/-2) now passes `story.sourceType` instead of `story.classification` into `notificationOrigin()` for the origin badge, since `classification` now carries the new relevance meaning. Test coverage was added in `dashboard/site/test/unit/notification-stories.test.js` (+88/-2): a parametrized test with 8 classification scenarios (mention, review request, assignment, unresolved failure, security finding, operator action, resolved update, passive information) and a ranking test asserting input-order independence of the final sort. The remaining two changed files (`dashboard/local-server.mjs`, +2/-10; `tests/unit/dashboard-local-server.test.mjs`, +7/-1) are incidental refactors (a shared `sendContent` helper and gzip-encoding assertions) unrelated to the classification/ranking decision.

## Decision

Normalize every notification story's heterogeneous, source-specific classification signals into exactly three user-relevance tiers — `needs_you`, `update`, `fyi` — using rule-based, ordered text/pattern matching in `storyClassification()`:

1. Security-finding object type, or "security finding/alert" text → `needs_you`.
2. Resolved-state patterns (accepted/closed/completed/passed/recovered/resolved/submitted/succeeded/success) → `update`.
3. Action-required/blocked/failure/failed/pending/timed-out patterns, or mention/review/assignment patterns, or human/maintainer/operator/owner/reviewer/user actor text → `needs_you`.
4. Lifecycle/status-update/workflow-run patterns, or changed/started/updated text → `update`.
5. Otherwise → `fyi`.

Rank stories for display using a four-level composite sort key: `STORY_CLASS_RANK` (relevance tier) ascending, then `consequenceRank` (severity/consequence, computed via `CONSEQUENCE_RANK` over consequence-tier/consequence/severity/finding-severity/smell-severity fields, or fallback to numeric `priority`, else `Number.MAX_SAFE_INTEGER`) ascending, then timestamp descending (recency), then stable ID ascending — replacing the prior `timestamp desc, then id asc` sort. The story's raw provider-specific classification is preserved separately as `story.sourceType` (via the renamed `eventSourceType()`) specifically so existing UI origin badges continue to render the original source type rather than the new relevance label. Additionally, the previous unsafe `Number(event.priority)` priority coercion (which could produce `0` or `NaN` for non-numeric/empty values) is replaced by a null-aware `numericPriority()` helper.

## Alternatives Considered

- **Keeping the raw per-source classification string as the sole classification field (no separate relevance tier)**: Not chosen — the PR explicitly renamed the original field-preserving function to `eventSourceType()` and introduced a new, distinct `story.classification` derived value, and updated `notifications-inbox.js` to source origin badges from `sourceType` instead. This confirms source identity and user-relevance were deliberately separated into two fields, though the rationale beyond preserving "existing origin badges" (per PR body) is not inferable from current pull request evidence.
- **A different number of relevance tiers (e.g., two-tier actionable/non-actionable, or a finer-grained set)**: Not inferable from current pull request evidence as an alternative actually considered; the PR settled on exactly three tiers (`needs_you`, `update`, `fyi`) with no discussion in the PR body or diff of why three tiers were chosen over more or fewer.
- **Sorting by timestamp/recency alone or by severity alone (without a combined multi-key sort)**: The prior behavior (`timestamp desc, then id asc`) is documented in the diff as the baseline being replaced; the PR body's stated ordering diagram (`needs_you → update → fyi` then `severity/consequence → recency → stable ID`) indicates relevance-tier-first, severity-second ordering was chosen deliberately so actionable items precede passive ones regardless of recency, but no alternative sort orderings that were evaluated and rejected are described in the evidence.

## Consequences

**Positive:**
- Stories are consistently labeled and deterministically ordered so actionable items (mentions, review requests, assignments, unresolved failures, security findings, operator actions) surface before passive updates and informational items, directly addressing the stated goal in the PR body.
- Origin badges continue to function correctly because `sourceType` preserves the original per-source classification separately from the new relevance label, avoiding a regression in `notifications-inbox.js`'s badge rendering (confirmed by the `+2/-2` change passing `story.sourceType` instead of `story.classification`).
- The null-safe `numericPriority()` helper fixes a documented pre-existing correctness issue where `Number(event.priority)` could coerce non-numeric/empty priority values to `0` or `NaN`, which the PR body notes could otherwise "incorrectly [promote] stories."
- Deterministic ordering is stable and input-order-independent, verified by a dedicated ranking test in `notification-stories.test.js` that asserts identical output order for both original and reversed input arrays, and by 8 parametrized classification scenario tests covering each actionable and passive category.

**Negative:**
- Classification relies on ordered regex/text pattern matching across many possible fields (classification/signal-type/event-type/outcome-state/run-conclusion/lifecycle-state/type, action/next-action/title text, expected-actor text); this is inherently sensitive to wording drift in upstream event sources, and the maintenance cost of keeping these patterns accurate as new source types or terminology are introduced is not inferable from current pull request evidence.
- Not inferable from current pull request evidence: no information is given about false-positive/false-negative rates of the classification heuristics, performance impact of the added regex/matching logic at scale, or whether any stakeholder or design-review process evaluated alternative tier counts or matching strategies.
- Not inferable from current pull request evidence: no migration or backward-compatibility concerns are documented for consumers that may have depended on the old `story.classification` field carrying the raw source-type value before this change repurposed it.
