---
title: Add Control Plane configuration view
description: Record the dashboard configuration view for explaining and diagnosing CAO policy.
---

# ADR 2501: Add Control Plane configuration view

## Status

Proposed

## Context

The Control Plane dashboard did not previously expose an understandable, actionable view of `.github/workflows/cao.json`, the non-secret policy document that governs Central Agentic Ops behavior. Operators had to leave the dashboard to inspect this file directly, and there was no in-dashboard surfacing of resolver validation errors or policy diagnostics (e.g., owner-wide scope, review-only packages, missing packages, live target-authority requirements).

This pull request adds a Configuration view to the dashboard that renders the raw `cao.json` policy document, explains configured entries and inherited behavior, surfaces resolver validation errors and diagnostic conditions, and generates bounded, copyable prompts for common remediation actions (e.g., changing a package from `review` to `live`, enabling workers) while preserving existing scope and rollout constraints in that prompt guidance.

Changes span dashboard report/data generation (`.github/aw/dashboard/report/control-settings.mjs`, `.github/aw/dashboard/report/dashboard-language-sources.mjs`, `.github/aw/dashboard/site/dashboard.json`), dashboard UI (`.github/aw/dashboard/site/src/components/configuration-view.js`, `ui-elements.js`, `specification.js`, `styles.js`, `index.html`), and associated unit tests.

Not inferable from current pull request evidence: specific stakeholder requests, prior incidents motivating this feature, performance considerations, or any explicit rejection of alternative designs.

## Decision

Add a dedicated Configuration view to the Control Plane dashboard that:

- Carries the non-secret `cao.json` policy document and resolver status into dashboard data generation, making it available to the static dashboard site.
- Displays the complete raw JSON (with copy support) alongside human-readable explanations of configured entries and inherited behavior.
- Surfaces resolver validation errors and diagnostic conditions (owner-wide scope, review-only packages, missing packages, live target-authority requirements) directly in the UI.
- Generates bounded, copyable prompts for specific policy changes (e.g., `review` → `live`, enabling workers), with prompt guidance that preserves existing scope and rollout constraints.
- Integrates a configuration health visualization into the Control Plane navigation.

This is read-only diagnostic and prompt-generation functionality added to the dashboard's existing report/data pipeline and site components; it does not introduce any new write or execution capability — actions remain limited to producing copyable prompt text for the operator to use elsewhere.

## Alternatives Considered

Not inferable from current pull request evidence — the PR body and diff do not document alternative designs that were considered or rejected (e.g., whether a CLI-based diagnostic tool, a separate standalone page, or direct policy-editing capability in the dashboard were evaluated).

## Consequences

**Positive:**
- Operators can review the configured policy document, its resolved/inherited behavior, and resolver diagnostics without leaving the dashboard.
- Diagnostic surfacing (owner-wide scope, review-only packages, missing packages, live target-authority requirements) makes policy issues visible in-context rather than requiring manual inspection of `cao.json`.
- Bounded, copyable remediation prompts reduce the effort of drafting correct change requests while preserving existing scope and rollout constraints.
- The feature is additive to the dashboard's existing data/report pipeline and does not grant new write or execution capability, limiting its blast radius.

**Negative:**
- The dashboard now carries and renders the full non-secret policy document and resolver status, increasing the amount of configuration-derived data embedded in `dashboard.json` and the dashboard bundle.
- Additional UI surface area (`configuration-view.js`, associated styles, navigation entries) and data-generation logic (`control-settings.mjs`, `dashboard-language-sources.mjs`) increase the maintenance surface of the dashboard.
- Not inferable from current pull request evidence: any performance, security review, or accessibility implications beyond what is described in the PR body.
