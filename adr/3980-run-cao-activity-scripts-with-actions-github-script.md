# ADR 3980: Run CAO activity scripts with actions/github-script

## Status

Draft

## Context

CAO activity scripts previously ran as standalone Node processes in `.github/workflows/activity.yml`. Per the pull request description, this prevented the scripts from using the APIs provided by `actions/github-script` (e.g. `core`, `github`, `context`, `exec`, `io`, `getOctokit`). PR #3980 ("Run CAO activity scripts with actions/github-script") changes the workflow to invoke these scripts through pinned `actions/github-script` steps while still supporting local Node debugging.

Evidence of the change footprint:
- `.github/workflows/activity.yml` (+14/-55) — Actions execution invocations reworked.
- New files: `activity/actions-context.mjs`, `activity/local-runner.mjs`, `activity/run-activity.mjs`, `activity/action.yml`, `activity/README.md`, `activity/.env.example` — introducing an Actions-context module, a local runner, an activity entrypoint runner, an action definition, and documentation/example configuration for local debugging.
- Modified: `activity/actions-log.mjs`, `activity/github-telemetry.mjs`, `activity/index.mjs`, `activity/logs.mjs` — adapted to the new entrypoint/logging contract.
- New tests: `tests/unit/actions-context.test.mjs`, `tests/unit/activity-run-activity.test.mjs`; updated `tests/unit/workflow-contract.test.mjs` and `tests/integration/package-lifecycle.test.mjs` — covering the new contract and github-script execution.
- `package.json` / `package-lock.json` updated (large lockfile delta), consistent with adding a dependency to support local-action shims (per PR body: "@github/local-action Toolkit shims").
- `dashboard/report/activity-collectors.mjs`, `dashboard/report/control-settings.mjs`, `dashboard/report/inventory.mjs` — modest adjustments, presumably to remain compatible with the updated activity script contract.

## Decision

Run CAO activity scripts as pinned `actions/github-script` steps in Actions, passing a shared Actions singleton (`{ core, github, context, exec, io, getOctokit }`) into each entrypoint via `await activity.main({ core, github, context, exec, io, getOctokit })`, instead of invoking them as standalone Node processes.

To support this, activity-related scripts now export a `main(actions, args)` entrypoint contract, expose the supplied Actions APIs on `globalThis`, and route logging through `core` when available (falling back to console-based logging otherwise). A new `activity/actions-context.mjs` module packages this shared Actions-context, and `activity/action.yml` defines the packaged action. A new `activity/local-runner.mjs`, backed by `@github/local-action` Toolkit shims, supports running the same scripts outside Actions via `local-action` or direct Node invocation, with `activity/README.md` and `activity/.env.example` documenting the local debugging workflow and example environment configuration. `activity/run-activity.mjs` implements the entrypoint runner used in both contexts.

## Alternatives Considered

- **Continue running activity scripts as standalone Node processes and reimplement needed GitHub API access manually** (e.g., custom Octokit setup, manual `core`-equivalent logging). Rejected implicitly by the PR, which states this approach "prevent[s] them from using the APIs provided by actions/github-script," motivating the migration instead of duplicating that functionality.
- **Migrate to `actions/github-script` without preserving local debugging support.** This would simplify the entrypoint contract but was not the path taken: the PR explicitly adds `activity/local-runner.mjs`, `activity/.env.example`, and README documentation specifically to preserve "local Node debugging," indicating this alternative was considered and rejected in favor of dual-mode (Actions + local) execution support.

## Consequences

**Positive:**
- Activity scripts running in Actions gain direct access to the `actions/github-script` API surface (`core`, `github`, `context`, `exec`, `io`, `getOctokit`) without reimplementing equivalents, per the shared Actions singleton passed into `main()`.
- Logging is unified through `core` when available, with console fallback retained, per changes in `activity/actions-log.mjs`.
- Local Node debugging is preserved via `activity/local-runner.mjs` and `@github/local-action` Toolkit shims, so contributors are not forced to run scripts only inside Actions to test them (per PR body and new README documentation).
- New unit tests (`tests/unit/actions-context.test.mjs`, `tests/unit/activity-run-activity.test.mjs`) and updated `tests/unit/workflow-contract.test.mjs` provide coverage for the new contract and github-script execution path.

**Negative:**
- Activity scripts must now conform to a new `main(actions, args)` entrypoint contract and expose Actions APIs via `globalThis`, adding an abstraction layer compared to plain standalone Node scripts, as reflected in changes across `activity/actions-log.mjs`, `activity/github-telemetry.mjs`, `activity/index.mjs`, and `activity/logs.mjs`.
- The workflow file `.github/workflows/activity.yml` required restructuring (+14/-55 lines) to pin and invoke `actions/github-script` steps, representing a nontrivial migration surface.
- The `package-lock.json` delta (+3156/-113) indicates a substantial new dependency tree (consistent with adding `@github/local-action` per the PR body), increasing the project's dependency footprint. Specific performance or maintenance cost implications: Not inferable from current pull request evidence.
- Downstream dashboard report modules (`activity-collectors.mjs`, `control-settings.mjs`, `inventory.mjs`) required corresponding adjustments, indicating the entrypoint contract change has ripple effects beyond the `activity/` directory. Full scope of any other affected consumers: Not inferable from current pull request evidence.
