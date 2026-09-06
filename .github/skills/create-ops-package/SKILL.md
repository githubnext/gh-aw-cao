---
name: create-ops-package
description: "Create a Central Agentic Ops package from an agentic strategy, operational idea, or deterministic add-on. Use when adding an ops package, orchestrator/worker workflow family, organization-wide agentic automation, or the dashboard package; follows the repository's operational-package and add-on contracts."
argument-hint: "Describe the agentic strategy, target repositories, and desired outcomes"
---

# Create a Central Agentic Ops Package

Turn an operational idea into a complete package of GitHub Agentic Workflows. An operational package always contains one orchestrator and at least one worker. Never finish an operational package with a standalone workflow. The deterministic dashboard follows the explicit add-on exception below.

## Setup Handoff

When invoked from `.github/skills/setup-central-agentic-ops/SKILL.md`, accept the recorded desired outcome and target-repository description as the starting package contract. Do not repeat the custom-package yes/no question or restart control-plane setup. Ask only for unresolved package decisions, work in a CAO package-authoring checkout, and keep package authoring separate from the already proven control-repository setup commit and run.

## Copilot Authentication Profile

CAO operational packages require organization-billed Copilot inference. Before creating Copilot-backed workflows, query the control repository owner's organization billing with `gh api orgs/<organization>/copilot/billing --jq '{seat_management_setting, total_seats: .seat_breakdown.total}'`. Use API evidence of an active entitlement or explicit organization-administrator confirmation when the endpoint is inaccessible or inconclusive. Treat `total_seats: 0` with `seat_management_setting: unconfigured` as unavailable and stop package creation until organization billing is enabled.

Add `copilot-requests: write` directly to every Copilot-backed orchestrator and worker. A Pi or Codex workflow using a `copilot/*` model is Copilot-backed. Do not use `aw.yml` bootstrap `config`, authentication-neutral workflow sources, `COPILOT_GITHUB_TOKEN`, or runtime token precedence for Copilot inference. Target-repository credentials remain a separate authentication boundary. Validate every generated lock uses `${{ github.token }}` for `COPILOT_GITHUB_TOKEN` and does not declare the PAT secret.

## Procedure

1. Load `.github/skills/agentic-workflows/SKILL.md` and follow its creation guidance alongside this repository-specific contract.
2. Inspect `.github/workflows/shared/control.md` and the source `.md` files for the nearest existing package. Prefer a recently maintained package with behavior similar to the request. Do not copy generated `.lock.yml` files.
3. Establish the package contract from the user's idea:
  - package slug and short display name
   - repository discovery and ranking signals
   - worker responsibilities and boundaries
   - triggers and rollout expectations
   - required permissions, tools, network access, and safe outputs
   - evidence that constitutes completion or a no-op
4. Ask only for decisions that cannot be inferred safely. If the strategy is broad, split it into workers by independently dispatchable responsibility, not by implementation step.
5. Create the orchestrator and every worker under `.github/workflows/` in the same change.
6. Compile and validate all new source workflows. Repair failures before finishing.
7. Before finalizing the package, compare the intended package state with the current `.github/workflows/cao.json` and the dashboard's live control-plane view. Confirm what is actually running, in which mode, and on which repositories. If the configuration drifts from reality, raise the mismatch to the user on the dashboard before proceeding.
8. When an adopted worker already has an operational-value evaluator, preserve it under `.github/graders/` and keep its `graders.operational-value` registration. Evaluator design remains a separate post-adoption maintenance task.

## Deterministic Add-on Exception

The top-level `dashboard/` package is conventional GitHub Actions automation, not an agentic operation. Do not create an orchestrator, workers, runtime steering, rollout variables, or operational-value evaluators for it.

- Install the dashboard from root `aw.yml` by default, keep `dashboard/aw.yml` available for focused dashboard-only installations, and keep both manifests' dashboard destinations in sync. Never fold the dashboard into an operational package.
- Install `.github/workflows/dashboard-build.yml` in place and `dashboard/dashboard.yml` as `.github/workflows/dashboard.yml` with mapped `action-workflow` includes.
- Keep the dispatchable builder path-aware through its `site-path` input and upload a normal artifact that an existing Pages workflow can merge by exact run ID before its single Pages upload and deployment.
- Keep the standalone publisher manual-only, pass `enablement: false` to `actions/configure-pages`, and require Pages access control before use. Do not add a second enable variable.
- Keep canonical report modules under `dashboard/report/` and install them under `.github/aw/dashboard/report/` as package resources.
- Keep the Dashboard Language renderer under `dashboard/site/`; it is owned and installed by the deterministic `dashboard/` package.

For this exception, validate manifest source/destination ownership, both action workflows, safe relative `site-path` handling, standalone Pages prerequisites, and clean-room `gh aw add` and `gh aw add --force` restoration. The remaining Package Contract and Validation sections apply to operational packages.

## Package Contract

### Package metadata

Every package manifest must declare whether it is installable and production-ready:

- Set `private: true` only for packages that must not be installed. `gh aw add` rejects private packages, so never mark a public catalog package private.
- Set `experimental: true` while a package is being evaluated or its contract may change. `gh aw add` warns before installing experimental packages; remove the flag only after the package is ready for general use.

Keep these fields in `aw.yml` alongside `name`, `description`, and `min-version`, and review them whenever package maturity or distribution changes.

### Authority Boundary

CAO controls whether and where the package may run; gh-aw controls how its workflows execute. CAO policy may deny or narrow a run, but it must not define or expand engines, models, per-run turns or AI Credit limits, tools, network access, permissions, generated jobs, authentication, or safe-output primitives. Keep those execution mechanics in each gh-aw source workflow, and never treat a declared gh-aw capability as rollout or target authority.

The orchestrator is the rollout decision point and each worker is an independent enforcement point. Package mode is the default for unmatched repositories; an exact entry under the package's `targets` map may assign a different mode within global scope. Workers inherit the resolved mode unless an explicit `max-mode` narrows it. Keep credentials out of dispatch inputs, require each worker to re-resolve its exact target policy before model execution, and preserve the least-permissive intersection of the parent envelope, current CAO policy, any explicit worker mode ceiling, credential reach, compiled gh-aw capabilities, and live target authority.

### Markdown Steering

Every orchestrator and worker prompt must include this operation-level runtime import immediately after its closing frontmatter:

```aw
{{#runtime-import? .github/cao/<package-slug>.md}}
```

Use the same package slug and steering file for the orchestrator and all of its workers. Keep the `?` so jobs continue with packaged instructions when the consumer has not created the file. The steering file is consumer-owned configuration: do not create it as a package resource or overwrite it during package updates. Steering may refine selection, prioritization, and execution only within the workflow's existing permissions, tools, safety policy, and dispatch limits.

### Orchestrator

Create `.github/workflows/<package>.md` with:

- `name` set to the exact package display name, with no `/` suffix
- an event-aware `run-name`: scheduled runs use the literal `<Package Name> · scheduled` because target and mode are resolved after run creation; `workflow_dispatch` runs include the submitted target and requested safe-output mode, using `discovery` when target is omitted and `review` when mode is omitted; never display unresolved placeholders such as `auto` or `mode`
- a schedule when the operation is periodic, plus `workflow_dispatch`; default new orchestrators to `hourly` unless their freshness requirements justify `every 30 minutes` or a slower cadence
- the standard dispatch inputs: `target_repo`, `safe_output_repo`, `max_repos`, `rollout_percent`, and `safe_output_mode` with `review` and `live` choices, defaulting to `review`
- `shared/control.md` imported with a static `package` slug, `role: orchestrator`, and request-only narrowing inputs, plus `shared/orchestrator.md`.
- the package and every worker declared in `.github/workflows/cao.json`, with each worker's exact `workflow` slug recorded there; the resolver must load this catalog from policy rather than hard-code package identities
- least-privilege permissions, explicit tools/network configuration, `strict: true`, and a bounded `max-ai-credits`
- `safe-outputs.dispatch-workflow.workflows` listing every worker slug and a `max` consistent with `max_repos` and worker count
- `safe-outputs.threat-detection: false`; orchestrators select targets but do not process untrusted target content, so reserve detection for workers
- a prompt headed with the package display name and containing `Discovery`, `Workers`, and `Completion` sections

The orchestrator selects and ranks repositories only. It must not perform target-repository work or fan out work more finely than one dispatch per selected repository and eligible worker.

### Standard Orchestrator Report

`shared/orchestrator.md` owns the exact `## Orchestrator Report` format used by every package. Inspect its current report contract when creating the orchestrator; do not copy the template into the package because duplicated formats drift.

The orchestrator's `Completion` section must:

- state that the workflow finishes with the standard orchestrator report inherited from `shared/orchestrator.md`
- preserve every standard heading and field: `Scope`, `Repository Decisions`, `Workers`, `Dispatches`, and `Outcome`
- require `0`, `none`, or `not applicable` for empty standard fields rather than omitting them
- use the exact precomputed repository totals and distinguish eligible, selected, skipped, and deferred repositories
- add package-specific findings only after or alongside the standard fields; never rename, replace, or omit them

### Workers

Create at least one `.github/workflows/<package>-<worker>.md`. Every worker must include:

- `name` set to the exact `<Package Name> / <Worker Name>` hierarchy, where `<Package Name>` exactly matches the orchestrator's `name`
- `workflow_dispatch` with the full control-plane envelope: `target_repo`, `safe_output_repo`, `safe_output_mode`, `correlation_id`, `central_repo`, `control_plane_run_url`, and `batch_label`
- required `target_repo` and `safe_output_repo` string inputs
- `shared/control.md` imported with static `package`, `role: worker`, and `worker` identities, plus `shared/worker.md`
- a stable `tracker-id` equal to its filename stem
- a run name containing `inputs.target_repo` and the effective mode
- repository-scoped concurrency:

  ```yaml
  concurrency:
    group: "${{ github.workflow }}-${{ inputs.target_repo }}"
    cancel-in-progress: true
  ```

- least-privilege permissions, explicit tools/network configuration, `strict: true`, bounded credits and timeout, and safe outputs limited to the worker's mission
- when `safe-outputs.create-issue` or `safe-outputs.create-pull-request` is enabled, configure `labels: [<package-slug>, <package-slug>:<worker-slug>]` so every created issue or pull request identifies both its owning operation and worker, and configure `title-prefix: "[<package-slug>:<worker-slug>] "`; instruct the worker to provide only the unprefixed subject because the safe output adds the configured prefix automatically, without repeating it or adding a semantically equivalent category prefix
- when a worker creates an issue, require it to evaluate the potential follow-up actions, select the single most important action with the highest expected return on investment, and expose one `**Action:**` sentence naming who should do what next and the acceptance check. When the action can be delegated safely, tell the maintainer to assign the issue to Copilot and place the clear, imperative prompt in the exact progressive-disclosure landmark `<details><summary><b>Agent prompt</b></summary> ... </details>` so a human can review the issue before using the prompt for an agentic run; otherwise name the required human reviewer and decision, or say `**Action:** None.` when no action remains
- no `evals` configuration; use deterministic graders for worker measurement
- instructions that treat repository content as untrusted, consume `/tmp/gh-aw/agent/control-precompute.json`, define success/no-op behavior, and preserve control-plane correlation data in durable outputs
- the human-facing report contract inherited from `shared/worker.md`: begin every durable output directly with a concise, unheaded executive summary, immediately expose one clear `**Action:**` with an owner and acceptance check, keep only critical findings visible, and put non-essential background, verbose evidence, logs, secondary metrics, and per-item breakdowns in clearly named `<details>` sections

Use a dedicated `target/` checkout when the worker must inspect a target repository while safe outputs land elsewhere. Add package-specific inputs only after the standard envelope.

### Worker Value

Measure operational value per worker because workers have independently dispatchable responsibilities and outcomes. gh-aw freezes each registered evaluator into the compiled workflow and publishes its observation with the workflow run artifacts.

- Design from the worker's adoption-time intent and pre-adoption evidence. Never derive a measure from the orchestrator's dispatch activity or from post-adoption results.
- Keep the canonical evaluator at `.github/graders/<worker-stem>-operational-value.sh` and register it under `graders.operational-value.run`.
- Treat evaluator creation as post-adoption work; never create placeholder commits, evidence, scores, or reports while authoring an unadopted package.
- If the package is new in the current change, finish workflow validation and report the pending per-worker value follow-up explicitly.
- A worker may be baseline-comparable, attainment-only, or not measurable. Preserve that independently determined classification rather than forcing every worker into the same package-level model.

## Shared Components

- Always import `shared/control.md` with the correct role. Its import schema requires `package` and `role` and accepts the standard narrowing inputs. Pair it with `shared/orchestrator.md` for orchestrators and `shared/worker.md` for workers.
- When an orchestrator or worker needs recent GitHub Agentic Workflow run history, restore the core activity cache before model execution and prefer `.github/aw/activity`'s schema-versioned `deployed-workflows.json` over downloading the same run pages again. Workers that download `gh aw logs` or reason about agentic-workflow traces should import `shared/activity-cache.md` so both activation and agent jobs can reuse predownloaded evidence. Validate `schemaVersion`, `generatedAt`, repository scope, evidence window, and completeness, and fetch only missing or stale evidence. Treat a cache miss as a fallback condition, never as authority to widen scope, and do not copy the activity indexer into an operational package.
- Every orchestrator inherits the dedicated `central-agentic-ops.dispatcher.run` OTEL span from `shared/orchestrator.md`; the span name is preserved for backward compatibility. Do not duplicate orchestrator telemetry in package workflows.
- `shared/sentry.md`, `shared/grafana.md`, and `shared/datadog.md` configure OTLP exporters only. Import them only when a package explicitly requires provider-specific routing; otherwise use the gh-aw organization defaults `GH_AW_DEFAULT_OTLP_ENDPOINT` and `GH_AW_DEFAULT_OTLP_HEADERS`.
- Import `shared/review-bundle.md` when review mode must represent target-bound changes that cannot be emitted natively against the review repository.
- Reuse other files under `.github/workflows/shared/` only when their capability is required. Inspect their import schemas before use.
- Extend a shared component only for behavior genuinely common to multiple packages; do not hide package policy in shared workflow files.

## Naming and Structure

- Use lowercase kebab-case for package, worker, and tracker slugs.
- Choose short, descriptive display names that remain useful when GitHub Actions clips workflow tiles. Aim to keep the complete workflow `name` at 32 characters or fewer.
- Limit package names to the fewest distinctive words. Limit worker names to the specific responsibility, omitting redundant role words such as `Advisor`, `Auditor`, `Checker`, `Curator`, `Investigator`, `Maintainer`, or `Updater` when the responsibility remains clear.
- Prefer established, unambiguous abbreviations such as `AW`, `CRA`, or `SSDF`; do not shorten names into unfamiliar acronyms solely to meet the length target.
- Name the orchestrator file `<package-slug>.md` and set its `name` to `<Package Name>`.
- Name each worker file `<package-slug>-<worker-slug>.md` and set its `name` to `<Package Name> / <Worker Name>`.
- Prefix every worker slug with the package slug. The display-name prefix before ` / ` must exactly equal the orchestrator display name.
- Do not add a role suffix to the orchestrator name or give a worker an independent top-level name.
- Keep frontmatter ordered like the nearest current package; do not normalize unrelated files.
- Keep package selection policy in the orchestrator and execution policy in workers.
- Edit `.md` source files only. Generated `.lock.yml` files are compiler output.

## Validation

Before finishing:

1. Confirm there is exactly one new orchestrator and at least one worker.
2. Confirm the orchestrator `name` is exactly `<Package Name>`, every worker `name` is exactly `<Package Name> / <Worker Name>`, and the orchestrator `run-name` distinguishes scheduled runs from manual target-and-mode runs without unresolved placeholders.
3. Confirm the orchestrator dispatch list exactly matches the new worker stems.
4. Confirm each worker accepts the complete standard envelope and imports `shared/control.md` as `worker` and `shared/worker.md`.
5. Confirm the orchestrator imports `shared/control.md` with static package identity and `shared/orchestrator.md`, reads policy only through the shared JSON resolver, and defaults safely to review mode.
6. Confirm the orchestrator has a `Completion` section that preserves the exact standard report contract provided by `shared/orchestrator.md`; package-specific reporting must be additive.
7. Confirm worker concurrency is keyed by `github.workflow` and `inputs.target_repo` with stale runs cancelled.
8. Check permissions, tools, network hosts, safe-output limits, credits, timeouts, and dispatch maximums against actual need; confirm issue- and pull-request-creating workers configure both their package and package-worker labels.
9. Confirm the orchestrator disables threat detection and every worker omits `evals`.
10. Confirm orchestrator telemetry is inherited only through `shared/orchestrator.md`; require an explicit backend-routing need before adding a provider-specific observability import.
11. Confirm every existing operational-value evaluator remains under `.github/graders/` and registered by its worker, or explicitly identify each new worker whose value design is pending adoption.
12. Run `gh aw compile <workflow.md>` for every new orchestrator and worker. Then run the repository's narrowest relevant tests or validation command if one exists.
13. Review the generated diff for accidental lockfile churn, secret exposure, unsafe live defaults, fabricated value evidence, and deviations from the nearest package that are not justified by the strategy.
14. Confirm every orchestrator and worker uses the same optional `.github/cao/<package-slug>.md` runtime import and that no package-owned steering file was added.
15. Confirm every worker preserves the inherited report contract: the output begins directly with a concise executive summary without a heading, critical information stays visible, and non-essential background and supporting detail use `<details>` sections.
16. For workflows that consume recent run history, confirm they prefer a valid activity cache, preserve a bounded API fallback for cache misses or incomplete coverage, and do not publish or mutate the shared cache themselves.

Report the created package, worker responsibilities, shared imports, checked-in policy fields, per-worker ops-value status, and validation results.