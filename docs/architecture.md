---
title: How the Control Plane Works
description: Understand the control plane's purpose, execution boundary, and core safety properties.
---

Read this overview when evaluating whether the control plane fits your organization. Follow its links when you need deployment policy or implementation details. For installation steps, begin with [Install and run safely](getting-started.md).

## Objectives

The control plane is designed to:

- operate enterprise-wide and organization-wide workflows from private central repositories;
- promote packages independently without coupling their release schedules;
- keep credentials and common policy centralized;
- separate repository selection from repository mutation;
- make every dispatched action attributable to a control-plane run;
- fail closed when routing, credentials, or worker eligibility are incomplete.

## Mental Model

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="/gh-aw-cao/assets/control-plane-mental-model-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="/gh-aw-cao/assets/control-plane-mental-model-light.svg">
  <img alt="A catalog release enters a private control repository, where an orchestrator selects and dispatches work to a worker that emits declared safe outputs in review or live mode." src="/gh-aw-cao/assets/control-plane-mental-model-light.svg">
</picture>

:::note[Three records, three jobs]
The catalog release proves what was installed. The control repository owns operating policy and credentials. The target authority file records consent for live mutation. None of these records replaces the others.
:::

The execution boundary is the key architectural fact: orchestrators and workers run from the control repository. A worker checks out and analyzes one target at a time. Remote target repositories receive only declared safe outputs; they do not receive or run the control-plane workflow definitions.

Any repository may explicitly operate as a source-managed control plane for workflows it maintains in-tree. The reviewed workflow sources and generated locks are the runtime payload, while `.github/workflows/cao.json` remains the separate rollout-policy authority. When a catalog uses this topology to run its own workflows, it is dogfooding: the repository applies both catalog and control-plane safety rules. In every source-managed topology, repository visibility governs run metadata, dashboards, and review outputs, and source files alone never activate the control role.

## How It Works

1. A schedule or manual dispatch starts a package orchestrator in the control repository.
2. Shared control resolves mode, routing, candidate repositories, limits, and eligible workers.
3. The orchestrator ranks candidates and dispatches one worker run per selected target.
4. Each worker analyzes only its dispatched target and emits only declared safe outputs.
5. Outputs are sent to a review repository in review mode or processed against the target in live mode.

The orchestrator owns rollout and selection. Workers enforce the dispatched control envelope without escalating mode, discovering additional repositories, or duplicating credentials.

CAO Activity separately collects bounded workflow and run evidence into one
shared snapshot for dashboards and reports. It is supporting infrastructure,
not an execution or authority layer. See [CAO Activity](activity.md) for the
collection flow and data-quality behavior.

## Core Safety Properties

- review mode is the default;
- target selection and dispatch are bounded;
- owners, targets, and review destinations must pass explicit trust checks;
- every live `(target repository, package)` pair has one target-approved mutation authority;
- workers accept only declared targets and eligible generated-workflow paths;
- GitHub tools are read-only, while writes use declared safe-output primitives;
- credentials are resolved inside each run and never carried in dispatch inputs;
- missing authority, authentication, routing, or eligibility fails closed.

:::caution[The control plane is not a universal policy boundary]
Central Agentic Ops governs participating catalog workflows. Use GitHub rulesets, Actions policy, protected environments, CODEOWNERS, and credential scoping to govern other automation.
:::

## Detailed References

| Read | When you need to understand |
| --- | --- |
| [Deployment and Governance](deployment-and-governance.md) | Organization and enterprise topologies, ownership, target enrollment, provenance, reporting identity, and the broader governance boundary |
| [Execution and Safety](execution-and-safety.md) | Layer responsibilities, the full execution flow, dispatch fields, invariants, failure behavior, and implemented controls |
| [Orchestrators and Workers](orchestrators-and-workers.md) | Package-specific authority, worker enforcement, eligibility, and worker ceilings |
| [Rollout and Routing](rollout-and-routing.md) | Review-to-live promotion; review destinations; authority checks; and rollback |
| [CAO Activity](activity.md) | Shared evidence collection, snapshots, fallback behavior, and dashboard inputs |
