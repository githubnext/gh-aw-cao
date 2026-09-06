# ADR 3921: Extract Experiment Decision-Surface Composition into Reusable Subcomponents

## Status

Draft

## Context

The `experiments-evaluation` element rendered the overview, table, filters, deep-link behavior, empty states, and detail sections for the experiments dashboard view, but the composition logic that assembled these declarative sections was embedded directly in this page-specific renderer. This orchestration governed the `experiments-overview`, `experiments-table`, and `experiments-evaluation` declarative slices already declared in `dashboard/site/dashboard.json` (per prior ADR 2821), meaning the composition responsibilities were coupled to a single view rather than being reusable across dashboard views.

## Decision

Extract the decision-surface composition responsibilities out of `experiments-evaluation.js` into a new, domain-neutral primitive, `dashboard/site/src/components/experiment-decision-surface.js` (+436 lines). This primitive owns reusable helpers for: declarative section composition, model construction, filter rendering, filter application, deep-link synchronization, and empty-state rendering. `experiments-evaluation.js` becomes a thin element adapter that wires the existing experiment summary, table, and detail subcomponents into the shared surface, while `experiments-evaluation` continues to render the same overview, table, filters, deep-link behavior, empty states, and detail sections and preserves existing Dashboard Language bindings in `dashboard.json`. `experiments-view-shell.js` is restored as a compatibility shim exporting the new shared primitives so that repository-level contracts still referencing the historic module path continue to resolve. Focused unit coverage was added in `dashboard/site/test/unit/experiments-evaluation.test.js`, and typecheck, lint, test, validate:corpus, and test:e2e were reported as passing.

## Alternatives Considered

- **Keep composition logic embedded in `experiments-evaluation.js`**: This was the pre-existing approach and is what the PR replaces; it kept overview/table/filter/deep-link/empty-state orchestration coupled to the single page-specific renderer rather than reusable across views.
- **Remove/rename the historic `experiments-view-shell.js` module path outright**: Not chosen; the PR instead restores it as a compatibility shim exporting the new shared primitives specifically so existing repository-level contracts that reference the historic path keep working.

## Consequences

**Positive:**
- Composition helpers (section composition, model construction, filter rendering/application, deep-link sync, empty-state rendering) are now reusable and domain-neutral, decoupled from the page-specific `experiments-evaluation` renderer.
- Existing Dashboard Language bindings in `dashboard.json` and existing declarative slices (`experiments-overview`, `experiments-table`, `experiments-evaluation`) continue to work unchanged.
- Backward compatibility is preserved for repository-level contracts via the `experiments-view-shell.js` shim, avoiding breakage for consumers referencing the historic module path.
- Behavior parity is validated by focused unit tests plus passing typecheck, lint, test, validate:corpus, and test:e2e.

**Negative:**
- An additional module (`experiment-decision-surface.js`, +436 lines) and an additional compatibility shim (`experiments-view-shell.js`) increase the number of files involved in the experiments dashboard composition path.
- Not inferable from current pull request evidence: whether any other dashboard view currently consumes the new shared `experiment-decision-surface` primitive, or what future reuse is planned.
