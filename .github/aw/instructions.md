# Central Agentic Ops Repository Instructions

## Package categories

Treat top-level Central Agentic Ops packages as operational packages by default. They contain an orchestrator and at least one independently dispatchable worker, use `shared/control.md`, and follow `.github/skills/create-ops-package/SKILL.md`.

The `dashboard/` package is the deterministic exception. It contains conventional GitHub Actions workflows, data producers, and the Dashboard Language renderer under `dashboard/site/`, not an orchestrator or workers. Install it from root `aw.yml` by default while retaining `dashboard/aw.yml` for focused dashboard-only installations; never fold it into an operational package.

## CAO and gh-aw authority

Central Agentic Ops governs **whether and where** an installed operation may run: package and worker enablement, eligible owners and repositories, review/live ceilings, inventory partitioning, rollout, and monthly package admission.

gh-aw governs **how** an authorized workflow executes: engines and models, per-run turns and AI Credit limits, tools, network access, permissions, generated job topology, authentication mechanics, and safe-output primitives and execution.

Treat this as a one-way boundary. CAO may deny a run or narrow its scope, but it must never grant or expand a gh-aw capability. Do not add engine settings, per-run limits, tools, permissions, credentials, jobs, or safe-output primitives to `.github/workflows/cao.json` or its resolver. Conversely, gh-aw execution capability never grants CAO rollout or live authority. CAO policy, credential reach, dispatch narrowing, and the compiled gh-aw workflow are cumulative boundaries; none substitutes for another. Target repository files do not participate in activation authority.

Orchestrators select and dispatch within the resolved rollout envelope; they do not perform target work. Workers enforce one dispatched target, resolve current policy before model execution, and do not discover repositories, dispatch downstream work, escalate mode, or accept credentials in the dispatch envelope.

## Deterministic core packages

- Install the `activity/` package from the root manifest. It owns the scheduled and manually dispatchable data-collection workflow, cache key contract, and activity index schema.
- Keep data collection and cache publication out of operational packages and dashboard build jobs. Consumers may restore the activity cache and must fall back narrowly when its scope, freshness, or completeness is insufficient.
- The activity cache is an evictable optimization, not historical authority. Do not use it to widen CAO policy or credential reach.

## Dashboard contract

- Install with the root package by default. Use `gh aw add githubnext/gh-aw-cao/dashboard@<release>` only for a focused dashboard-only installation.
- Keep `.github/workflows/cao-dashboard-build.yml` independently runnable through `workflow_dispatch` and package it through both dashboard manifests. Its `site-path` input controls the relative directory included in the mergeable `central-agentic-ops-dashboard` artifact.
- Keep `dashboard/cao-dashboard.yml` as the standalone Pages publisher. It must support manual dispatch and rebuild after changes to CAO policy or dashboard package files, pass `enablement: false` to `actions/configure-pages`, and must not add a schedule or another enable variable.
- For an existing Pages site, retain one Pages artifact uploader and deployer. Dispatch the builder, wait for that exact run, then download its artifact by run ID into the existing site's output directory before that workflow uploads the combined Pages artifact.
- Keep report source modules under `dashboard/report/` and install them under `.github/aw/dashboard/report/` through matching root and `dashboard/aw.yml` resources.
- Restore the complete collected-data snapshot from the activity cache; do not recreate collection or cache publication in the dashboard builder.
- Keep the production renderer under `dashboard/site/` and install its runtime assets under `.github/aw/dashboard/site/` through matching root and `dashboard/aw.yml` resources.
- Require Pages to be configured for GitHub Actions with appropriate access control before any standalone deployment.