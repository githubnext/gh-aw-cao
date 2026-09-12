# Workflow Configuration Test Matrix

Use this as a lookup from configuration to verified behavior. Examples assume 25 discovered repositories. `-` means unset or not applicable. Statuses are `🟢 Pass` and `🔴 Fail`.

Run dependency-free contract tests with `npm run test:unit`. Run local failure-injection tests with `npm run test:integration`. Run the authenticated clean-room package tests with `npm run test:package-lifecycle`; they require gh-aw, `GH_TOKEN`, and public GitHub access. Run synthetic enterprise scale tests with `npm run test:load`. `npm test` runs unit and local integration tests, while `npm run check` adds load tests, visual checks, compilation, and documentation builds. Use `npm run compile:locks` when updating tracked lock files. CI runs package lifecycle tests in a separate job and sets `CENTRAL_AGENTIC_OPS_PACKAGE_SOURCE` to the exact commit under test so package installation validates pull-request contents rather than only the default branch. The CI job reports the lifecycle check as infrastructure-incomplete when the shared GitHub App installation lacks enough core API capacity to run the clean-room suite.

The automated suite checks source `.md` contracts, ops-value interfaces, smoke-workflow safety, generated workflows, and `gh aw add`/`gh aw update` package behavior. It does not execute agentic workflows or spend AI Credits; the manual `Review smoke` Actions workflow performs that opt-in runtime check.

## Test Suite

| Layer | Location | Command | Coverage |
| --- | --- | --- | --- |
| Unit | `tests/unit/` | `npm run test:unit` | Policy matrices, workflow contracts, safety limits, generated settings, and package manifest structure. |
| Integration | `tests/integration/control-*.test.mjs` | `npm run test:integration` | Pre-activation admission, policy resolution, and fail-closed execution of the actual control precompute shell. |
| Package lifecycle | `tests/integration/package-lifecycle.test.mjs` | `npm run test:package-lifecycle` | Authenticated clean-room `gh aw add`/`update` behavior. |
| Load | `tests/load/` | `npm run test:load` | Actual pagination, deterministic batching, and admission logic over 100,000 synthetic repositories, including bounded API failure. |
| Compilation | Source workflows | `npm run compile` | All agentic workflow sources compile without emitting repository artifacts; unit contracts reject HTML-escaped operators in tracked expressions. |
| Runtime review | `.github/workflows/review-smoke.yml` | Manual Actions dispatch | One bounded target and its workers complete; outputs route to a private review repository and target refs and issues remain unchanged. |
| Runtime modes | `.github/workflows/enterprise-canary.yml` | Manual protected Actions dispatch | Repository-local review/live routing against dedicated repositories with mode-specific write assertions. |
| Runtime stress | `.github/workflows/enterprise-stress.yml` | Manual protected Actions dispatch | Repository-local two, three, or five same-scope review runs verify cancellation and no target mutation. |
| Ops Publish | `tests/unit/ops-publish*.test.mjs` | `node --test tests/unit/ops-publish*.test.mjs` | Reviewer, provenance, routing, authority, least-privilege, API failure, retry, pagination, and publication contracts. |

## Package Lifecycle Integration

The integration suite creates disposable consumer repositories under the system temporary directory and removes them after each test.

| Test result | Command | Checked behavior |
| --- | --- | --- |
| 🟢 Pass | `gh aw add` | Installs the core orchestrators and workers, shared imports, packaged skills and agent, and package manifest; focused UK AI Advisory and EU CRA packages are validated separately. |
| 🟢 Pass | `gh aw update --force` | Replaces a locally modified package workflow and restores deleted workflow dependencies, skills, and agent files for a branch-tracked package. |
| 🟢 Pass | Dashboard `gh aw add` and `gh aw add --force` | Installs and restores the reusable builder, manual standalone publisher, and all deterministic report modules. |

## Enterprise Integration and Load

| Test result | Scenario | Checked behavior |
| --- | --- | --- |
| 🟢 Pass | Pre-activation admission | The actual `.github/cao/src/control.mjs` `admit` command authorizes declared packages and fails closed for disabled packages, malformed policy, and unavailable policy content. |
| 🟢 Pass | Control validation and authorization | The actual control precompute shell passes 54 success, failure, disablement, review-isolation, live-authorization, and output-binding cases. |
| 🟢 Pass | 100,000-repository inventory | Pagination stops at 1,000 pages, retains exactly 100,000 candidates, and applies the 10%/1,000 target cap within 120 seconds. |
| 🟢 Pass | Deterministic cell and batch selection | Stable repository IDs assign every selected candidate to one cell; bounded batches share an inventory version and have distinct batch IDs. |
| 🟢 Pass | Inventory API rate limit | Organization and user lookup each run once, then produce zero candidates, zero target capacity, and a durable error instead of retrying. |
| Manual | Review smoke | Orchestrator and correlated workers complete, outputs route privately, and target issue/ref snapshots remain identical. |
| Manual, approved | Review canary | Target remains unchanged; optional `require_output` asserts a durable proposal in the private review repository. |
| Manual, approved | Live canary | Optional `require_output` asserts a durable issue, pull request, branch, or comment change in the dedicated target. |
| Manual, approved | Review stress | Bounded same-scope runs are superseded by concurrency controls and do not mutate the target. |

## Modes

Mode controls how declared [safe outputs](https://github.github.com/gh-aw/reference/glossary/#safe-outputs) are processed: routed to a private review repository (`review`) or processed against their authorized live destination (`live`). All triggers use the same two modes; the trigger determines where the mode is read from.

### Trigger: Schedule (`on.schedule`)

Schedule-triggered runs use the configured package mode.

| Test result | Configured mode | Checked scheduled behavior |
| --- | --- | --- |
| 🟢 Pass | `review` | safe outputs route to the control-plane repository. |
| 🟢 Pass | `live` | Declared safe outputs may be processed against the live destination. |

### Trigger: Manual ([`workflow_dispatch`](https://github.github.com/gh-aw/reference/glossary/#workflow_dispatch))

Manual-triggered runs use the `safe_output_mode` workflow input. They run independently of the configured scheduled mode and do not change it.

| Test result | `safe_output_mode` workflow input | Checked behavior |
| --- | --- | --- |
| 🟢 Pass | `review` | Run starts and safe outputs default to the control-plane repository. |
| 🟢 Pass | `live` | Run starts and declared safe outputs may target the live destination. |
| 🟢 Pass | Either mode with package enabled | Run starts independently of scheduled configuration. |

## Routing safe outputs for Review

Review routing sends proposed safe outputs to the explicit review destination when provided, otherwise to the current control-plane repository (`github.repository`).

| Test result | Effective mode | `safe_output_repo` workflow input | Checked behavior |
| --- | --- | --- | --- |
| 🟢 Pass | `review` | provided | workflow input repository used. |
| 🟢 Pass | `review` | - | Current control-plane repository used. |
| 🟢 Pass | `live` | provided | Repository ignored; live routing used. |

## Setting Absolute Caps

`max_repos` defaults to `1` and limits selected repositories regardless of mode. The smallest of this cap, the percentage cap, and the dispatch-derived target cap wins.

| Test result | Effective mode | Rollout | `max_repos` | Checked limit |
| --- | --- | --- | --- | --- |
| 🟢 Pass | `review` | 100% | 1 | 1; safe outputs routed for review. |
| 🟢 Pass | `review` | 100% | 10 | 10; safe outputs routed for review. |
| 🟢 Pass | `live` | 100% | 1 | 1. |
| 🟢 Pass | `live` | 100% | 10 | 10. |
| 🟢 Pass | `live` | 10% | 1 | Absolute cap wins: 1. |
| 🟢 Pass | `live` | 10% | 10 | Percentage cap wins: 3. |

## Setting Safe Rollouts

`rollout_percent` gradually expands eligibility. Counts round up so a non-empty inventory can select at least one repository.

| Test result | Effective mode | Rollout | `max_repos` | Checked limit |
| --- | --- | --- | --- | --- |
| 🟢 Pass | `review` | 10% | - | 3; safe outputs routed for review. |
| 🟢 Pass | `live` | 10% | - | 3. |
| 🟢 Pass | Any | 100% | 1000 | 25. |
| 🟢 Pass | Any | 10% | 1000 | 2.5 rounds up to 3. |
| 🟢 Pass | Any | 10% | 1 | Stricter absolute cap gives 1. |
| 🟢 Pass | Any | 10% | 10 | Stricter percentage cap gives 3. |
| 🟢 Pass | Any | Any | Any | Empty inventory gives 0. |

## Rejecting Unsafe Configuration

Invalid caps, out-of-scope owners, and incomplete control facts stop before worker workflow dispatch.

| Test result | Configured value | Checked behavior |
| --- | --- | --- |
| 🟢 Pass | `rollout_percent: 0` | Rejected. |
| 🟢 Pass | `rollout_percent: 101` | Rejected. |
| 🟢 Pass | Fractional percentage | Rejected. |
| 🟢 Pass | Non-numeric percentage | Rejected. |
| 🟢 Pass | `max_repos` below `1`, fractional, or above `1000` | Rejected. |
| 🟢 Pass | `max_scan_repos` below `1` or above `100000` | Rejected. |
| 🟢 Pass | Invalid cell count/index or batch size/index | Rejected. |
| 🟢 Pass | Target or review repository outside `control-plane.scope.allowed-owners` | Rejected. |
| 🟢 Pass | Unknown or removed mode | Rejected before agent execution. |
| 🟢 Pass | Invalid package kill-switch value | Rejected before agent execution. |
| 🟢 Pass | Package kill switch set to `false` | Produces zero capacity and dispatches without repository inspection. |
| 🟢 Pass | Missing worker target or non-positive correlation ID | Rejected before target or review repository access. |

## Enterprise Safety

| Test result | Scenario | Checked behavior |
| --- | --- | --- |
| 🟢 Pass | Missing settings | review mode, one target, 1000-repository scan ceiling, control-owner allowlist. |
| 🟢 Pass | Inventory up to 1,000,000 repositories | Selection remains within absolute, percentage, and dispatch caps. |
| 🟢 Pass | AW Optimization with four eligible workers | 20-dispatch budget permits at most 5 targets. |
| 🟢 Pass | All workers disabled | Effective target cap is zero; no dispatch. |
| 🟢 Pass | Duplicate workflow display names | Workers resolve only by exact generated path; analytics group by workflow path. |
| 🟢 Pass | Enterprise and organization planes target the same repository | Independent provenance, policy, credentials, and kill switches are preserved. |
| 🟢 Pass | Direct worker dispatch | Target and safe-output owners still pass the trusted allowlist. |
| 🟢 Pass | Worker ceiling omitted | Worker remains enabled and inherits the resolved package or exact-target mode. |
| 🟢 Pass | Review destination is public or inaccessible | Rejected before agent execution. |
| 🟢 Pass | Aggregate AI Credit request exceeds `1100` default | Repository selection is reduced to fit the shared cap. |
| 🟢 Pass | Public targets without an App or PAT | Built-in `GITHUB_TOKEN` supports bounded review runs in the control repository; private access, alternate review repositories, and live target writes remain prohibited. |
| 🟢 Pass | Runaway prevention | Every workflow has finite AI credits and timeout; overlapping same-scope runs cancel. |
| 🟢 Pass | API rate limit or budget exhaustion | No internal retry/wait loop or self-dispatch; unresolved work is incomplete and requires a new bounded run. |
| 🟢 Pass | Same-scope queue pressure | Newest run supersedes older running or pending work; no unbounded Actions backlog. |
| 🟢 Pass | Full emergency stop | Documentation requires disabling Actions and canceling all queued/running work in every participating control repository. |

## Compiling Workflow Settings

Compilation checks prove the source policy reaches the generated GitHub Actions workflows.

| Test result | Workflow surface | Checked behavior |
| --- | --- | --- |
| 🟢 Pass | Dependabot orchestrator workflow | Mode, rollout percentage, and `workflow_dispatch` inputs compile. |
| 🟢 Pass | AW Optimization orchestrator workflow | Mode, rollout percentage, and `workflow_dispatch` inputs compile. |
| 🟢 Pass | Release Train Updater | Standard dispatch envelope and safe output settings compile. |
| 🟢 Pass | AI Credit Auditor | Standard dispatch envelope and safe output settings compile. |
| 🟢 Pass | AI Credit Optimizer | Standard dispatch envelope and safe output settings compile. |
| 🟢 Pass | All worker workflow safe outputs | Review/live routing vocabulary checked. |
| 🟢 Pass | All generated package workflows | Emitted activation gates, transitive job dependencies, review isolation, live authority, output binding, and removed-mode settings checked in a clean-room compile. |
| 🟢 Pass | Core catalog package | Installs the complete dashboard package while keeping its standalone Pages publisher manual-only. |
| 🟢 Pass | Operational value | Schema-v4 evaluators are registered by workers and the dashboard consumes actual `grader_results.json` observations. |
| 🟢 Pass | Dashboard package | Root and focused installations include the same dashboard destinations; reusable builds mount under a relative path and standalone deployment remains manual and access-controlled. |
| 🟢 Pass | Grader package transport | gh-aw installs and restores explicitly mapped `.github/aw/*/graders/*.sh` files in clean package consumers. |

Exhaustive coverage: 24 scheduled plus 96 manual cases, for 120 unique policy configurations and 22 user-facing scenarios. The custom review-bundle job retains gh-aw's internal `GH_AW_SAFE_OUTPUTS_STAGED` dry-run signal; it is compiler plumbing, not a public package mode.