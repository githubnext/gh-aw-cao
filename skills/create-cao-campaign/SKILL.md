---
name: create-cao-campaign
description: Create a governed CAO campaign with one orchestrator, bounded workers, policy declarations, packaging, and validation.
argument-hint: "Describe the operational outcome, target repositories, and desired outputs"
---

# Create a CAO Campaign

## Procedure

1. Load `.github/skills/agentic-workflows/SKILL.md` and follow its new-workflow
   route for every workflow. Inspect `.github/workflows/shared/control.md`, the
   effective `.github/workflows/cao.json`, and the nearest maintained campaign.
2. Define the campaign slug, outcome, discovery and ranking signals, workers,
   triggers, rollout expectations, permissions, tools, network, credentials,
   safe outputs, completion evidence, and bounded campaign memory. Ask only for
   decisions that cannot be inferred safely.
3. Create one orchestrator and at least one independently dispatchable worker
   together. A standalone workflow is not an operational campaign.
4. Apply the [workflow contract](references/workflow-contract.md) to the
   orchestrator and every worker. Keep `review` as the default and preserve the
   intersection of policy, request, worker ceiling, credential reach, and
   compiled capability.
5. Add or update the campaign `aw.yml`, `cao.json`, README, root `aw.yml`, and
   package-completeness tests as required by
   [Build Your First Campaign](../../docs/author-your-first-operation.md).
6. For each stable worker, use the repository's operational-value skill to
   decide whether a deterministic evaluator is meaningful. Add a measurable
   worker and evaluator together, or record that the outcome is not measurable.
7. Add package problem clustering only when the campaign has a deterministic,
   bounded problem definition not covered by built-in computations; follow
   [Computations](../../specs/computations.md).
8. Compile editable workflow sources with `npm run compile`. Never edit generated
   `.lock.yml` files directly. Run focused tests, package-completeness tests, and
   clean-room lifecycle tests when credentials are available.
9. Compare intended state with policy and the dashboard control-plane view.
   Report the campaign files, workers, safety capabilities, review-mode proof,
   evaluator status, validation, and unresolved prerequisites.

## Guardrails

- CAO decides whether and where work runs; gh-aw decides how an authorized
  workflow executes. Neither authority substitutes for the other.
- Orchestrators discover and dispatch. Each worker handles one dispatched
  repository and cannot discover targets, dispatch work, or widen mode.
- Keep credentials in Actions secrets and out of policy, prompts, inputs,
  steering, memory, logs, and commits.
- Use GitHub tools read-only. Repository writes use declared safe outputs.
- Keep installed package sources immutable. Optional consumer guidance belongs
  in `.github/cao/<campaign-slug>.md`, loaded with a trailing optional
  `runtime-import`.
- Use stable work identity, handler-level deduplication, bounded output volume,
  silent no-ops, and the shortest practical expiration.
- Never infer activation from catalog files, workflow sources, repository name,
  or credential reach. Missing authority fails closed.

## Targeted references

- [Workflow contract](references/workflow-contract.md): required orchestrator,
  worker, steering, memory, and safe-output invariants.
- [Safe outputs](references/safe-outputs.md): idempotency, labels, expiry, and
  human-first report formatting.
- [Package extensions](references/package-extensions.md): operational-value,
  problem-clustering, optimization, and the dashboard add-on exception.
- [Build Your First Campaign](../../docs/author-your-first-operation.md):
  authoring sequence and package shape.
- [Orchestrators and Workers](../../docs/orchestrators-and-workers.md):
  execution roles.
- [Control policy](../../specs/control-policy.md): rollout authority.
- [Control architecture](../../specs/control-architecture.md): normative
  dispatch and enforcement.
- [Operational value](../../specs/operational-value.md): evaluator contract.
- [Computations](../../specs/computations.md): deterministic package
  computations.

The top-level deterministic `dashboard/` package is the sole add-on exception:
it is conventional Actions automation, not an agentic campaign. Do not add an
orchestrator, worker, memory, steering, or operational grader to it.
