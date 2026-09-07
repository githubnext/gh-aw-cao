# ADR 4853: Normalize agentic workflow smells into four classifications surfaced as unified Home attention signals

## Status

Draft

## Context

The dashboard needed a consistent way to represent evidence-backed warnings about agentic workflows — signals that a workflow "may be harder to control, secure, operate, or justify than necessary" without being proof of a defect. Prior to this PR, the specification and UI lacked a defined taxonomy for these observations, and the sources of such warnings were heterogeneous: `gh aw audit` produces five behavioral assessments (Agentic overkill, Resource heavy for domain, Poor agentic control, Partially reducible, Model downgrade available), while other detectors examine static workflow configuration/supply-chain posture, observed unsafe or untrusted behavior, and policy/package/governance posture.

Per `docs/agentic-workflow-smells.md`, findings must be classified "by what the evidence describes" and reviewers must not infer a security finding from high cost, long duration, or broad tool use — implying a need for explicit, evidence-typed classification rather than ad hoc or inferred severity labeling.

The changed files show this classification was implemented across the specification (`docs/dashboard-language-specification.md`, +42 lines), the telemetry/report layer (`dashboard/report/dashboard-language-sources.mjs`, +151 lines; `dashboard/report/aic-usage.mjs`, +28 lines), and the UI (`agent-marketplace-view.js`, `ui-elements.js`, `specification.js`, `dashboard.json`, `index.html`), along with new documentation and tests validating rendering of the new smell observations.

## Decision

Classify all agentic workflow smell observations into exactly four normalized classifications, as defined in the Dashboard Language specification and documented in `docs/agentic-workflow-smells.md`:

| Classification | What it describes | Example |
|---|---|---|
| Agent smell | Execution behavior, control quality, reducibility, or resource choice | A deterministic pre-step could replace most agent turns |
| Workflow smell | Static workflow configuration or supply-chain posture | Strict validation is disabled |
| Security finding | Observed unsafe or untrusted behavior | Threat detection identifies prompt injection |
| Control-plane smell | Policy, package inventory, rollout, or governance | Declared worker inventory is incomplete |

The dashboard normalizes all four classifications into Home attention signals, giving users a single unified place to see warnings regardless of source. Agent smells additionally surface on matching cards in the Agents view (per `agent-marketplace-view.js` changes).

Sourcing is dual: `gh aw audit` supplies the five behavioral assessments listed above, and the dashboard preserves their severity and supporting evidence when emitting them as agent smells; separately, the dashboard's own detectors (implemented in `dashboard/report/dashboard-language-sources.mjs` and `dashboard/report/aic-usage.mjs`, and referenced by telemetry tests in `tests/unit/dashboard-security-telemetry.test.mjs`) detect workflow, security, and control-plane smells against canonical IDs, meanings, categories, and severities defined normatively in the Dashboard Language specification.

Each observation retains its evidence, severity, expected actor, and recommended action, and observations are treated as "a reason to investigate, not proof of a defect."

## Alternatives Considered

- **Single undifferentiated "smell" or "warning" type**: Not inferable from current pull request evidence as an alternative that was actually considered; however, the documentation's explicit instruction to "classify findings by what the evidence describes" and its warning against inferring a security finding from cost/duration/tool-use signals implies the four-way split was chosen specifically to prevent conflating categories with differing evidence types and actors — a single flat classification would not distinguish behavioral (agent), static/supply-chain (workflow), unsafe-behavior (security), and governance (control-plane) evidence.
- **Keeping `gh aw audit` behavioral assessments separate from dashboard-detected smells (no unification)**: The PR instead chose to fold audit assessments into the "agent smell" classification and surface them alongside dashboard-native workflow/security/control-plane detectors as unified Home attention signals. The rationale for unification versus keeping them in separate surfaces is not inferable from current pull request evidence beyond the stated goal of normalizing all four classifications into Home attention signals.

## Consequences

**Positive:**
- Provides a consistent, documented taxonomy (`docs/agentic-workflow-smells.md`, 231 new lines) that reviewers and the UI can rely on to distinguish evidence types, reducing the risk of misclassifying findings (e.g., inferring a security finding from cost or duration alone).
- Unifies previously heterogeneous sources (`gh aw audit` behavioral assessments and dashboard-native detectors) into a single Home attention-signal surface, giving users one place to review warnings.
- Preserves evidence, severity, expected actor, and recommended action per observation, supporting the stated principle that a smell is "a reason to investigate, not proof of a defect."
- Backed by new automated tests validating rendering and functionality (`live-data.test.js` +59, `ui-elements.test.js` +88/-4, `dashboard-security-telemetry.test.mjs` +18) and an updated normative specification (`docs/dashboard-language-specification.md` +42), reducing ambiguity for future detector additions.

**Negative:**
- Not inferable from current pull request evidence: no information is given about maintenance cost, performance impact, or the effort required to keep the four classifications and their canonical IDs consistent between the specification, telemetry sources, and UI as new detectors are added.
- Not inferable from current pull request evidence: no rejected alternative designs, stakeholder constraints, or long-term migration concerns are documented in the supplied PR body, diff, or excerpt.
