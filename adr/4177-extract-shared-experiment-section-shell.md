# ADR 4177: Extract shared experiment-section shell into renderExperimentSection

## Status

Draft

## Context

In `dashboard/site/src/components/experiment-detail-sections.js`, five section-rendering functions (`renderMetricComparisonSection`, `renderEvalOutcomesSection`, `renderGraderDiagnosticsSection`, `renderObservationQualitySection`, `renderRunEvidenceSection`) each independently constructed the identical `<section aria-labelledby>` shell: an `h('section', { className: 'experiment-section', 'aria-labelledby': ... }, renderExperimentSectionHeading(...), ...)` call, followed by either an empty/partial-state message or the section's real content. This shell was duplicated verbatim (with only id/title/description/content varying) across all five functions in the diff.

## Decision

Add a new exported helper, `renderExperimentSection({ id, title, description, className, emptyState, renderContent })`, to `dashboard/site/src/components/experiment-view-primitives.js`. It composes the shared `<section>` element, the heading (via the existing `renderExperimentSectionHeading`), and either the supplied `emptyState` or the result of calling `renderContent()`. All five section functions in `experiment-detail-sections.js` were updated to call this helper instead of duplicating the section shell inline, passing their existing id/title/description/empty-state/content as parameters. `renderExperimentSectionHeading` remains exported and is now used directly by the new helper. `renderObservationQualitySection` wraps its warning node and main content in a wrapper `div` inside `renderContent`, per the PR description, because it has an extra warning node alongside its main content.

## Alternatives Considered

- **Keep the duplicated shell in each of the five functions.** Rejected implicitly by making this change; the PR body identifies the five functions as repeating the identical shell, motivating consolidation into one helper.
- **Not inferable from current pull request evidence** — no other alternative designs (e.g., a class-based component, template composition, or partial refactors of only some sections) are discussed in the PR body or diff.

## Consequences

**Positive:**
- The `<section>` + heading + (empty-state-or-content) composition now exists in a single place (`renderExperimentSection`), eliminating the duplicated shell previously repeated across five functions.
- Per the PR body, this preserves the exact rendered DOM structure, class names, `aria-labelledby` wiring, and each section's existing empty-state text — confirmed by the diff showing structurally equivalent `h('section', ...)` output from the new helper.
- Validation reported in the PR body passed: `npm run typecheck`, `npm run lint`, `npm test` (54 test files / 476 tests), and `npm run test:e2e` (26/26 Playwright tests).

**Negative:**
- `renderObservationQualitySection` now wraps its warning node and main content in an additional wrapper `div` that did not exist before, a structural change the PR body characterizes as having no visible/behavioral change since the children were already siblings of the heading.
- Not inferable from current pull request evidence — no other negative consequences (e.g., performance impact, migration cost for future section additions) are discussed in the PR body or diff.
