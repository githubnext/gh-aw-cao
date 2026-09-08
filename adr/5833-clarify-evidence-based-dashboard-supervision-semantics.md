# ADR 5833: Clarify evidence-based dashboard supervision semantics

## Status

Draft

## Context

The dashboard's PR description states that it "conflated personal attention handling with operational resolution, exposed non-durable Work edits, and presented execution history as planning data." This affected multiple dashboard surfaces:

- **Home**: human-required items were not separated from automated ones, and "done" language implied durable resolution where only browser-local acknowledgement existed.
- **Work**: in-memory state, owner, and package editing controls allowed edits that were not durable, and observed lifecycle states were being translated into planning states.
- **Execution timeline** (formerly Roadmap): intervals were presented without distinguishing observed data from inferred/planned commitments.

At the data-source level (`dashboard/report/dashboard-language-sources.mjs`), work item rows previously computed a single `verification-state` field derived from `matchedOutcome?.["outcome-state"]`, and lifecycle state was exposed only as `lifecycle-state`, with no separate representation of rollout authority or interval provenance.

The PR is scoped to changes across 14 files, with the core logic change concentrated in `dashboard-language-sources.mjs` (158 core additions), plus corresponding UI components (`work-item-card.js`, `work-item-row.js`, `work-project-view.js`, `work-view-primitives.js`, `notifications-inbox.js`, `styles.js`) and tests.

## Decision

Introduce explicit, independently-named data dimensions on dashboard work item rows instead of conflating lifecycle and verification into a single planning-oriented status:

- Preserve the existing observed lifecycle computation but expose it under an additional explicit field `work-state` (set equal to `lifecycleState`), alongside the existing `lifecycle-state`.
- Compute `verificationState` once via `outcomeVerificationState(matchedOutcome?.["outcome-state"])` and expose it both as `verification-state` (existing) and as a new `trust-state` field (set equal to `verificationState`), so trust/verification is named distinctly from work lifecycle.
- Add a new `rollout-mode` field (`run?.["rollout-mode"] || workflow["rollout-mode"] || "unknown"`) and derive a new `authority-state` field from it via explicit mapping: `review` → `proposal-only`, `live` → `target-authority-required`, otherwise → `unknown`.
- Add a new `interval-provenance` field marking data as `"observed"` when a `run` is present and `"inferred"` otherwise, so timeline intervals are identified as observed or inferred rather than presented as planned commitments.
- Rename the "Roadmap" surface to "Execution timeline" on both desktop and mobile, consistent with treating intervals as observed/inferred history rather than planning data.
- At the UI layer, remove in-memory Work state/owner/package editing controls (per PR description), and display work and trust states independently, including rollout and authority context, in the affected components (`work-item-card.js`, `work-item-row.js`, `work-project-view.js`, `work-view-primitives.js`).

## Alternatives Considered

- **Keep a single conflated status field**: Continue deriving one planning-oriented status from lifecycle and verification data combined, as before this change exposed only `lifecycle-state` and `verification-state` without `work-state`, `trust-state`, `rollout-mode`, `authority-state`, or `interval-provenance`. This was the prior approach and is what the PR description identifies as conflating "personal attention handling with operational resolution" and presenting "execution history as planning data."
- **Retain in-memory Work editing controls**: Continue exposing state, owner, and package editing controls on the Work surface that do not persist durably. The PR description characterizes this as exposing "non-durable Work edits," which the change explicitly removes rather than retains.

## Consequences

**Positive:**

- Work lifecycle (`work-state`/`lifecycle-state`) and trust/authority (`trust-state`/`rollout-mode`/`authority-state`) become independently named and derivable fields rather than a single conflated status, per the PR description's goal to display "work and trust states independently, including rollout and authority context."
- Timeline intervals are explicitly labeled `observed` or `inferred` via `interval-provenance`, aligning with the rename of Roadmap to Execution timeline and the description's requirement to "identify intervals as observed or inferred—not planned commitments."
- Removing in-memory Work state/owner/package editing controls eliminates the previously exposed non-durable edits described in the PR.

**Negative:**

- Not inferable from current pull request evidence (no data provided on downstream consumers, migration cost of the added fields, or user-facing impact of removing Work editing controls beyond the stated rationale).
- Not inferable from current pull request evidence regarding the "Home," "Information architecture," and "Agents" changes described in the PR body's bullet points, since the provided diff excerpt and changed-file list evidence is limited to `dashboard-language-sources.mjs` core logic; other files listed (e.g., `notifications-inbox.js`, `dashboard.json`, various test files) are named but their specific content changes are not included in the supplied evidence.
