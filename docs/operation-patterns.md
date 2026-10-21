---
title: Choose an Operation Pattern
description: Decide when to observe existing workflows, run explicit targets, reconcile a fleet, or coordinate campaign workers.
agent:
  type: architecture
  prominent: true
---

**An operation is the work you want done; a pattern is how you organize its
execution.** CAO governs participating operations from reviewed control-repository
policy. It does not require every operation to become a campaign.

Choose the simplest pattern that fits the work. Adding orchestration does not
add authority.

## Which pattern should I choose?

| Situation | Choose | Why | Tradeoff |
| --- | --- | --- | --- |
| Workflows already run where their owners want them; you need shared visibility | **Observe only** | Activity and the dashboard collect evidence without moving execution | Monitoring does not put those workflows under CAO admission |
| The caller already knows the target or small target set | **Direct operation** | Request exact targets and execute one mission without discovery or worker dispatch | Multiple targets are review-only with a common destination; live requires one target |
| One mission should repeatedly inspect a bounded portion of an enrolled fleet | **Standalone fleet workflow** | Deterministic discovery, cells/batches, caps and rollout select work inside one run | One agent/run processes the admitted set; no independently retried workers |
| Selection and target execution should be separate, or target runs need independent isolation and history | **Campaign** | An orchestrator selects and dispatches independently governed, single-target workers | More workflows, dispatches, credentials and run correlation to operate |
| Work is deterministic, or needs deployment stages, approvals, fan-in or long waits | **Ordinary GitHub Actions** | Use deterministic code and normal job/deployment orchestration; invoke an AW only for the reasoning step | Ordinary jobs do not automatically inherit CAO admission |

### Direct operation: explicit work

Example: a maintainer asks for one review report about two named repositories.
The requested set is checked against policy and access, not expanded by a
discovery query. No campaign descriptor, worker, cell or rollout configuration
is needed.

Declare the exact workflow under `control-plane.operations` and import
`shared/operation.md`. Use [authority envelopes](authority-envelopes.md) for
the complete policy, workflow and compile-tested example. This path is useful
for bounded on-demand work; it is not a generic delegation or durable queue API.

### Standalone fleet: one mission, selected inventory

Example: periodically inspect a deterministic slice of enrolled repositories
and produce a review report. The workflow gets a precomputed admitted set,
executes its mission directly and ends. The next scheduled run is another
bounded attempt, not continuation of an unfinished process.

Declare the workflow under `control-plane.workflows` and import shared control
as `standalone`. Choose this over direct execution when **CAO should select the
inventory**, rather than the caller supplying it. See
[standalone configuration](configuration.md#standalone-agentic-workflows).

### Campaign: separate selection and execution

Example: continuously find dependency work across a fleet, then give each
selected repository its own planner run. The orchestrator selects within
policy; each worker independently revalidates its one target and ceilings.

Choose a campaign when independent target runs or multiple specialized worker
missions justify the operational overhead. Catalog manifests provide reusable
packaging and ownership. Installing a campaign is not permission to run it
live. See [Orchestrators and Workers](orchestrators-and-workers.md) and
[Rollout and Routing](rollout-and-routing.md).

## Do not confuse these choices

| Choice | Separate question |
| --- | --- |
| **Trigger** | When does a run start: schedule, manual request, or a supported event? This is not an orchestration pattern. |
| **Integration** | What verifies identity and enforces execution capabilities? The shipped envelope integration uses gh-aw. |
| **Mode** | Where may outputs go? Review and live are authority/routing choices, not execution patterns. |
| **Hosting** | Where are the dashboard and collectors served? Their deployment does not grant workflow authority. |
| **Packaging** | Is the workflow maintained in-tree or distributed through a catalog? Source ownership does not replace reviewed activation policy. |

The optional webhook gateway is separately governed event ingress and dispatch
infrastructure, not a mandatory campaign component or a general workflow engine.
Its enrollment, provenance, queue and dispatch contracts remain independent.
The direct-operation import does not automatically connect a workflow to it.

## The same authority boundary applies

For participating workflows, CAO controls whether and where an operation may
run. gh-aw controls how it executes: tools, network, permissions, credentials,
runtime limits and safe outputs. The request, policy, applicable pattern
ceilings, credential reach and compiled capabilities must all agree.

The resolved envelope is an upper bound, not a token that grants capabilities.
Target files, steering text, dashboard visibility and successful earlier runs
cannot authorize another target or promote review to live. Missing required
evidence fails closed.

**Review is real execution**, potentially creating proposals in the review
repository; it is not a no-write dry run. Promoting an operation to live
requires an explicit reviewed policy decision. Debug is a special human-launched,
staged worker profile, not a fourth production pattern.

## Start small

First decide whether observation alone is enough. If execution is needed, use
direct work for known targets, standalone fleet execution for one bounded
inventory mission, and a campaign when separate workers are genuinely useful.
Start with one review target. Inspect scope, routing and outputs before
considering live authority or wider selection.

For monitoring, stopping and recovering existing runs, use
[Monitor, Recover, and Maintain](operations.md).
