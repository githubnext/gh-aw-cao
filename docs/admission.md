---
title: Admission Gates
description: Understand what Central Agentic Ops checks before activation and what authorized-run precompute checks before agent execution.
---

Central Agentic Ops admits a run only when its checked-in control policy authorizes the workflow identity and requested limits. Admission happens in the gh-aw pre-activation job, before activation and before any agent executes.

```text
trigger -> pre-activation admission -> authorized-run precompute -> activation -> agent
                 | denied              | blocked
                 +----------------------+-> no agent execution
```

Admission queries the GitHub rate-limit API and uses the returned core limit, remaining capacity, and reset time directly. It does not read or write a repository variable to coordinate capacity decisions across runs.

## What Admission Gates

The shared control component reads the package-installed `.github/aw/cao/src/control.mjs` and `.github/aw/cao/src/policy.mjs`, or the source-managed copies beside `control.md` under `.github/workflows/shared/`, from the exact `github.workflow_sha`. Admission then reads `.github/workflows/cao.json` at that revision, and authorized runs execute the `precompute` command from the same modules. They do not use policy or CAO runtime from another branch or from the agent checkout.

| Check | Admitted when |
| --- | --- |
| Runtime revision | `github.workflow_sha` is an exact commit and the policy and both CAO modules are readable at that revision. |
| Policy document | The JSON has supported keys, types, ranges, unique names, no duplicate keys, and no GitHub Actions expressions. |
| Control plane | `control-plane` exists. |
| Workflow identity | The workflow declares `orchestrator` or `worker`; workers also declare an exact worker identity. |
| Package | The package is declared and not disabled. |
| Worker | A worker is declared under that package and not disabled. |
| Target input | A supplied `target_repo` uses exact `owner/repository` form. Scope and access are checked later during precompute. |
| Mode input | `safe_output_mode` is `review` or `live` and does not exceed the checked-in package, target, or worker ceiling. |
| Run limits | `max_repos` and `rollout_percent` are valid and do not exceed checked-in policy. |
| GitHub API capacity | The credential used for precompute has enough primary REST API capacity for the run. |

A manual dispatch can narrow a run, such as changing an authorized `live` run to `review` or reducing `max_repos`. It cannot promote mode, add scope, enable a package or worker, or increase a limit.

## Worker Dispatch Trust Boundary

`workflow_dispatch` authenticates the caller as the GitHub App bot that holds the write-App credential. Allowlisting that bot preserves safe-output worker dispatches, but its login alone is not cryptographic proof of a particular orchestrator run, App installation, or dispatch envelope: a holder of the same App credential can submit equivalent workflow-dispatch inputs directly.

CAO therefore treats the write-App credential, its control-repository secret, and its selected installations as part of the trusted control-plane boundary. A worker independently fails closed unless the policy at its exact workflow SHA declares its package and worker, keeps both enabled, accepts the requested mode and output route, and accepts the target owner and any exact repository allowlist. The target repository cannot widen, narrow, or veto this authority through its own files. These checks prevent a dispatch from widening policy, operation, target, or mode, even when the caller has the allowlisted bot identity.

The correlation ID and control-plane run URL provide audit linkage only; they are dispatch inputs and cannot establish provenance by themselves. A deployment that requires proof that *only* a particular orchestrator run issued a worker dispatch needs a signed, replay-resistant envelope generated outside the agent-visible dispatch inputs (or a GitHub-provided source-run attestation). Do not treat the App login, installation access, or a matching run URL as a substitute for that stronger guarantee.

## What Precompute Gates

Admission is deliberately lightweight and repository-local. Once admitted, `.github/workflows/shared/control.md` runs deterministic precompute checks that need credentials, repository metadata, inventory, or usage evidence.

| Admission | Authorized-run precompute |
| --- | --- |
| Validates policy and workflow identity | Resolves repository inventory and allowlists |
| Rejects disabled or undeclared packages and workers | Verifies target and review-repository access |
| Prevents manual inputs from widening policy | Binds live workers to centrally authorized targets and output routes |
| Computes policy ceilings | Applies repository, rollout, and dispatch limits |
| Uses only the control repository revision | Confirms installed worker workflow availability and binds output routing |

Failure in either phase prevents agent execution. Admission denial skips activation; precompute fails closed when an authorized run cannot establish a required remote fact. Successful precompute uploads only `control-precompute.json`; the agent job restores and validates that non-secret artifact before checkout or model invocation.

## Connect Setup and Policy

Setup creates one atomic control-plane revision:

1. Install the gh-aw package from an immutable CAO tag or commit.
2. Verify that the root package materialized `.github/aw/cao/src/control.mjs` and `.github/aw/cao/src/policy.mjs` from that same CAO revision.
3. Declare the installed package and its worker-to-workflow mapping in `.github/workflows/cao.json`.
4. Commit the workflows, generated locks, CAO runtime, and policy together, then push before running the operation.

The root CAO package installs package-owned runtime copies under `.github/aw/cao` from the same pinned revision as the workflows; source-managed repositories keep the originals beside `control.md` under `.github/workflows/shared`. Follow [Quickstart: add Central Agentic Ops](getting-started.md#step-3---add-central-agentic-ops) to install them and [Quickstart: set the first-run boundary](getting-started.md#step-4---set-the-first-run-boundary) to create the consumer-owned policy.

Root package installation installs the CAO runtime, but it does not declare a package in consumer-owned policy or grant admission. The CAO setup procedure and checked-in control policy own those decisions.

The [Configuration Reference](configuration.md) defines every policy field. The phase that uses each group is:

| Configuration | Admission effect | Precompute effect |
| --- | --- | --- |
| `control-plane.packages` and `workers` | Declares and enables the exact workflow identity. | Resolves installed worker workflow paths. |
| `mode`, target `mode`, and worker `max-mode` | Establishes the maximum mode a dispatch may request. | Re-resolves the central ceiling before worker execution. |
| `max-repositories` and `rollout-percent` | Rejects a wider manual request. | Bounds selected repositories. |
| `scope` | Validates and returns the configured owners and repositories. | Filters inventory and rejects out-of-scope targets or review destinations; workers also reject targets outside a configured exact repository allowlist. |
| `inventory` | Validates scan, cell, and batch limits. | Performs bounded discovery and deterministic batching. |

## Diagnose a Skipped Run

Open the run summary and expand **Central Agentic Ops admission**. An authorized run names its package and role, and every check in the list is marked ✅. A denied run records a reason, marks every check before the failing one ✅, marks the exact failing check ❌, and leaves activation skipped. The ❌ marker identifies which row of the table below to consult; later checks are left unmarked because admission stopped before reaching them.

| Reason | Check marked ❌ | Configuration or setup to check |
| --- | --- | --- |
| Cannot read or execute CAO runtime | Runtime revision | Install both `.github/aw/cao/src` runtime files from the same immutable package revision, or keep both source-managed modules under `.github/workflows/shared`, and commit them with the workflows. |
| `control policy validation failed` | Policy document | Validate policy keys, types, ranges, unique names, and expressions in `.github/workflows/cao.json`. |
| `control-plane-absent` | Control plane | Add `control-plane` to `.github/workflows/cao.json`. |
| `role must be orchestrator or worker`, `worker identity is required`, `worker identity is forbidden for orchestrators` | Workflow identity | Fix the dispatched role and worker identity for the workflow. |
| `package-undeclared` | Package | Add the installed package under `control-plane.packages`. |
| `package-disabled` | Package | Review the package, then remove `enabled: false` when it is safe to resume. |
| `worker-disabled`, `unknown worker: <package>/<worker>` | Worker | Review the worker, then remove `enabled: false` or declare it under `control-plane.packages.<package>.workers` when it is safe to resume. |
| `target_repo must use owner/repository form` | Target input | Fix the `target_repo` manual input to the exact `owner/repository` form. |
| `safe_output_mode exceeds checked-in policy`, `safe_output_mode must be review or live` | Mode input | Narrow the requested `safe_output_mode`, or raise the checked-in package, target, or worker `mode`/`max-mode` ceiling. |
| `max_repositories exceeds checked-in policy`, `rollout_percent exceeds checked-in policy`, or an integer-range message | Run limits | Narrow the requested `max_repos`/`rollout_percent`, or raise the checked-in `max-repositories`/`rollout-percent`. |
| `github-api-capacity-insufficient`, `github-api-capacity-unavailable` | GitHub API capacity | Follow the remediation guidance in the run summary and wait until the reported reset time before retrying. |

Fix the checked-in setup or policy, commit and push the new revision, then start a new run. Do not bypass admission by editing a generated `.lock.yml` file or by widening manual inputs.