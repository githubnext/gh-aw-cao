# Dependabot Package

> [!NOTE]
> **Research prototype:** Features and interfaces may change as the project evolves.

The Dependabot package runs manifest-aware dependency maintenance from a private Central Agentic Ops control repository. It prioritizes security and repair work, selects target repositories, and dispatches one bounded update planner per repository.

The Agentic Workflow definitions remain in the control repository. Target repositories receive only declared safe outputs; they do not receive installed copies of these workflows.

## What It Does

- Prioritizes repositories with dependency alerts, stale or conflicted update pull requests, lockfile drift, and actionable Dependabot configuration failures.
- Understands relationships among manifests, lockfiles, workspaces, solutions, source code, tests, and CI instead of grouping updates only by package name.
- Maintains one repository-scoped issue containing every update currently identified by Dependabot.
- Refreshes the durable existing issue, posts a confirmation comment on later runs, and replaces obsolete tasks with a completed description when no work remains.
- Remembers the issue number in repository memory and reads that issue directly on later runs instead of repeatedly using GitHub search.
- Reads optional target-maintainer guidance from `.github/dependabot.md` and tells issue readers how to use that feedback channel.
- Uses progressive disclosure, a visible human call to action, and a complete prompt for an assigned coding agent.
- Measures whether each plan issue is consumed through assignment, outside participation, checklist progress, a linked pull request, or closure within 14 days.
- Never creates or changes a pull request.

## Package Contents

| Workflow | Role |
| --- | --- |
| [`dependabot`](../.github/workflows/dependabot.md) | Daily orchestrator workflow that discovers, ranks, and selects repositories. |
| [Dependabot / Update Planner](../.github/workflows/dependabot-update-planner.md) | Repository-scoped worker workflow that creates or refreshes one agent-ready Dependabot update-plan issue. |

The orchestrator workflow can dispatch no more than 50 worker workflows in one run. Each worker workflow handles one target repository and uses only its declared issue, refresh-comment, or `noop` safe outputs.

## Install

Install the package into a new private control repository owned by an organization:

```bash
gh aw add githubnext/gh-aw-cao/dependabot@<catalog-release>
```

The package is runnable after credentials, when needed, and checked-in policy are configured.

## Configure

Configure a GitHub App, a fine-grained PAT, or both in the control repository for private targets, alternate review repositories, or live operation. App authentication is preferred. A bounded review run against a public target can use the automatically provided `GITHUB_TOKEN` when outputs stay in the private control repository.

Store `GH_AW_GITHUB_READ_APP_ID` and `GH_AW_GITHUB_WRITE_APP_ID` as repository variables and their corresponding `GH_AW_GITHUB_READ_APP_PRIVATE_KEY` and `GH_AW_GITHUB_WRITE_APP_PRIVATE_KEY` values as repository secrets, or store a fine-grained PAT in `GH_AW_GITHUB_TOKEN`.

Declare Dependabot in `.github/workflows/cao.json`:

```json
{
	"version": 1,
	"control-plane": {
		"packages": {
			"dependabot": {
				"workers": {
					"update-planner": {
						"workflow": "dependabot-update-planner"
					}
				}
			}
		}
	}
}
```

The omitted fields default to an enabled package and worker, `review` mode, one repository, and 100 percent rollout. Set shared owner, repository, and inventory boundaries under `control-plane.scope` and `control-plane.inventory`.

The App installation or PAT must cover every private or internal target, alternate review repository, and live target the package needs to read or update. Public review runs may use `GITHUB_TOKEN`, but unavailable target Actions, security, or Dependabot data makes the run incomplete rather than broadening access or guessing. See the [authentication guide](../docs/authentication.md) for the permission model and credential precedence.

The update-planner rename preserves previously created plan issues. Existing issues with the former `dependabot:release-train-updater` label are recovered by the `dependabot` package label and canonical repository marker; newly created issues use `dependabot:update-planner`.

Grant the credential read access to Dependabot alerts and security events. The workflows already declare `vulnerability-alerts: read` and `security-events: read`; they do not request security write access. Dependabot alerts can therefore be inspected directly without scraping pull requests or repository content for vulnerability details.

Target maintainers can add `.github/dependabot.md` to declare dependency priorities, grouping preferences, validation commands, and sensitive risk areas. The update planner treats this file as guidance only: it cannot grant permissions, widen repository scope, or override package safety rules. Every generated plan issue reports whether the file was present and which guidance was used.

## Validate in review mode

Start with one representative repository:

1. Open the generated **Dependabot** workflow in the control repository's **Actions** tab.
2. Select **Run workflow**.
3. Leave `target_repo` blank to review the control repository itself, or set it to one fully qualified `owner/repository` name to review another repository.
4. Keep `max_repos` at `1` and `safe_output_mode` at `review`.
5. Trigger a `workflow_dispatch` run and inspect repository selection, the dispatched worker workflow, review outputs in the control repository, and control-plane correlation data.

To keep scheduled runs in review, leave `mode` omitted or set it to `review` in the package policy. Policy changes affect future runs; cancel active runs separately during incident response.

## Promote the Package

| Mode | Behavior |
| --- | --- |
| `review` | Routes safe outputs to the control-plane repository; manual runs may override it with `safe_output_repo`. |
| `live` | Allows the worker to create or refresh the single Dependabot plan issue in the selected target repository. |

Promote in order: one-repository review, limited live, then scheduled live. Change only this package's checked-in `mode`; other packages keep their own rollout state.

## Targeting

A manual `target_repo` can address a fully qualified repository only when its owner is allowlisted and the configured credential can access it. A manual `review` run with no explicit target uses the control repository itself. Scheduled runs, and manual `live` runs without a target, use bounded automatic discovery across repositories in the organization that owns the control repository. Enterprise-wide automatic discovery across multiple organizations is not provided.

The orchestrator favors:

1. Critical or high security alerts with a known patched version.
2. Broken, stale, conflicted, or duplicated dependency update work.
3. Lower-severity security updates with a clear path to a safer state.
4. Dependabot, registry, toolchain, grouping, or permissions repairs.
5. Routine compatible patch and minor maintenance.

Repositories without a recognized dependency ecosystem, readable manifests, or enough evidence for a safe change are skipped.

## Safety Boundaries

- GitHub tools are read-only; mutations occur only through declared safe outputs.
- The orchestrator workflow selects repositories but does not mutate them directly.
- A worker workflow receives one target and cannot discover more repositories, dispatch another workflow, or promote its mode.
- The worker workflow cannot create or mutate pull requests or repository files.
- The worker can create one deduplicated plan issue, refresh the existing issue with one confirmation comment, replace resolved work with a completed description, or emit `noop`.
- Credentials remain in the private control repository and are never included in dispatch inputs.

## Operational Questions

The package dashboard answers three questions from retained run, safe-output, and operational-value evidence:

1. **Does Dependabot work?** Run conclusions show whether the orchestrator and update planner activate and complete successfully.
2. **What did it produce?** The outcomes table links each durable repository plan issue and shows its disposition.
3. **Are people consuming my issues?** The consumption evaluator observes the exact remembered issue number. Assignment, outside participation, checklist progress, a linked pull request, or closure counts as consumption. Issues without a signal mature after 14 days; unavailable evidence remains unknown rather than becoming a false zero.

## Pause or Stop

Set `control-plane.packages.dependabot.enabled` to `false`, deploy that reviewed policy revision, and cancel active runs. For a narrower stop, set `workers.update-planner.enabled` to `false`. Re-enable in `review` mode after resolving the incident. For a control-plane-wide stop, follow the [emergency-stop procedure](../docs/operations.md#emergency-stop).

## More Information

- [Configuration reference](../docs/configuration.md)
- [Rollout and safe output routing](../docs/rollout-and-routing.md)
- [Control architecture](../docs/architecture.md)
- [Operations and incident response](../docs/operations.md)
