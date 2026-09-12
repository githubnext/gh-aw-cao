---
title: Execution and Safety
description: Follow the control envelope, execution invariants, and fail-closed behavior used by orchestrators and workers.
---

Use this page when implementing or reviewing control-plane behavior. For the architectural summary, start with the [Control Plane Overview](architecture.md).

## Responsibility Model

| Layer | Owns | Must not own |
| --- | --- | --- |
| [CAO admission runtime](admission.md) | Pre-activation policy validation and package, role, and request authorization | Repository inventory, target access, live target authority, or routing computation |
| Shared control | Authentication, common environment, mode interpretation, review requirements, authorized-run precomputation, control envelope | Package ranking or worker workflow-specific mutation policy |
| orchestrator workflow | Package mode, review destination, target selection, ranking, dispatch limits, eligible worker workflow list | Direct target mutation or credential duplication |
| worker workflow | Repository analysis, declared safe outputs, permissions, and execution limits | Repository discovery, downstream dispatch, or mode escalation |

The orchestrator workflow is the rollout authority. worker workflows are enforcement points: they consume the dispatched control envelope and must stay within it.

## Execution Flow

The execution boundary is the key architectural fact: orchestrators and workers run from the private central control repository. A worker checks out and analyzes one remote target at a time. Target repositories receive only declared safe outputs; they do not receive or run the control-plane workflow definitions.

![The control plane contains rollout policy and operation packages. Central orchestrators and workers inspect remote targets, emit declared safe outputs across the repository boundary, and correlate results with the originating central run.](assets/central-execution-how-it-works.svg)

1. A schedule trigger or `workflow_dispatch` starts a package orchestrator workflow.
2. Before activation, `.github/workflows/shared/control.md` uses the local `.github/workflows/shared` runtime for source-managed workflows or fetches that single runtime directory from an installed package's immutable source commit, then runs the `admit` command against policy from the workflow revision.
3. A denied or invalid request skips activation and records the reason in the workflow summary. An admitted run executes the `precompute` command in the same pre-activation job to resolve routing, repository inventory, centrally owned live authority, budgets, and worker workflow availability.
4. Pre-activation uploads only the resulting non-secret `control-precompute.json`. The agent job restores and validates that artifact before checkout; CAO policy and precompute credentials do not cross into the agent job.
5. The admitted workflow imports shared control with its package mode and review repository.
6. The orchestrator workflow ranks eligible repositories using package-specific discovery rules and applies `max_repos` and dispatch limits.
7. The orchestrator workflow dispatches each eligible worker workflow with the standard control envelope.
8. The worker workflow imports shared control as `role: worker`, analyzes only `target_repo`, and emits only its declared safe outputs.
9. safe outputs are routed to the review repository or processed against the target repository according to the effective mode.

Pages report routing participates in the control plane. Review routes report source data to the private `safe_output_repo` and publishes an access-controlled review Pages site owned by that repository. Live routes durable report source data to its normal destination and publishes the production Pages site. Conventional deterministic workflows perform both deployments and own `pages: write` and `id-token: write`; AI agent jobs do not.

## Standard Control Envelope

Every worker workflow dispatch carries:

| Field | Purpose |
| --- | --- |
| `target_repo` | The only target repository the worker workflow may analyze or update |
| `safe_output_mode` | `review` or `live` |
| `safe_output_repo` | safe output destination; review mode defaults this to the current control-plane repository |
| `correlation_id` | Joins worker workflow safe outputs to the orchestrator workflow run |
| `central_repo` | Identifies the control-plane repository |
| `control_plane_run_url` | Provides the originating run for audit and diagnosis |
| `batch_label` | Optional worker-specific grouping value |

Credentials are not part of this envelope. Each run resolves authentication through shared control.

An effective dispatch envelope resembles:

```yaml
target_repo: acme/example-service
safe_output_mode: review
safe_output_repo: acme/central-agentic-ops-review
correlation_id: optimization-2026-08-25-001
central_repo: acme/central-agentic-ops
control_plane_run_url: https://github.com/acme/central-agentic-ops/actions/runs/123456
batch_label: optimization-cell-0-batch-0
```

:::danger[No credentials in dispatch]
Never add an App key, PAT, installation token, or other secret to this envelope. Workers resolve authentication independently through shared control.
:::

## Invariants

- review mode is the default mode.
- Automatic discovery scans at most `1000` repositories by default and never more than `100000`.
- Orchestrator precompute versions each inventory and deterministically selects one bounded cell and batch before agent ranking begins.
- Repository selection defaults to one target and is bounded by absolute, percentage, and dispatch-derived caps.
- Manual targets and review destinations are restricted to trusted repository owners; the default is the control repository owner.
- Each live `(target repository, package)` pair has one assigned mutation authority; this operating invariant is not automatically reconciled across control repositories.
- Review mode defaults to the current control-plane repository when no destination override is provided.
- An orchestrator workflow dispatches only worker workflows declared in its `safe-outputs.dispatch-workflow.workflows` list and resolved by exact generated-workflow path.
- Disabled or unavailable worker workflows are skipped with a reason.
- A worker workflow handles one dispatched target and does not perform organization-wide discovery.
- GitHub tools are read-only; writes occur only through declared safe-output primitives.
- Agents do not receive Pages deployment permission or mode-promotion authority. Pages report mode and destination come from the control envelope; persistent publication is performed only by conventional deterministic workflows from trusted durable inputs.
- Review Pages must be access-controlled for the intended reviewers and isolated from production Pages. If that boundary is unavailable, review publication fails closed.
- A `workflow_dispatch` run may narrow or redirect one run but does not change another package's configured mode.
- Control-plane correlation is included in worker workflow-created issue, pull request, or comment safe outputs when available.

## Failure Posture

The system should stop or reduce scope when it cannot establish a required fact:

```text
required fact available? -- yes --> continue within declared limits
		  |
		  no
		  v
fail, skip, or report incomplete -- never infer broader authority
```

- inaccessible review destination in review mode: emit `report_incomplete` rather than writing elsewhere;
- unavailable or disabled worker: skip that worker;
- unreadable target or unresolved default branch: skip that target;
- invalid control precomputation: fail the run rather than infer policy;
- out-of-range repository, discovery, rollout, or dispatch caps: fail precomputation rather than widen scope;
- target or review repository outside the trusted owner allowlist: fail before repository access or dispatch;
- safe output not representable safely in review mode: publish an explicit review bundle or emit `report_incomplete`;
- Pages report in review mode without an access-controlled Pages-capable `safe_output_repo`: do not deploy the report;
- missing required authentication: fail before repository mutation.

## Current Controls

Implemented controls include shared authentication, package-level modes and review destinations, target and dispatch limits, versioned inventory batches, worker workflow eligibility checks, standard dispatch envelopes, read-only GitHub tools, and worker workflow safe outputs. Batch selection is deterministic; runs do not auto-advance or retry batches.

Worker-level `enabled` and `max_mode` controls provide ceilings beneath package policy for workers with independent risk or maturity. They are not separate control planes. See [Orchestrators and Workers](orchestrators-and-workers.md).