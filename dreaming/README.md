# Dreaming

> [!NOTE]
> **Experimental campaign:** Worker boundaries and output contracts may change as review evidence accumulates.

Dreaming gives maintainers evidence-bounded curation of the ambient agentic context that every agentic workflow relies on: `AGENTS.md` today, and repository skills in the future. Its scope is broader than any single campaign, because `AGENTS.md` and skills apply to all agentic activity in a repository, not only to GitHub Agentic Workflow usage. Its orchestrator selects one repository with an existing `AGENTS.md` and dispatches a bounded ambient-context curation review.

## Campaign Contents

| Workflow | Responsibility |
| --- | --- |
| [`dreaming`](../.github/workflows/dreaming.md) | Weekly and manually dispatchable orchestrator that selects a repository and dispatches campaign workers. |
| [`dreaming-agents-md-curator`](../.github/workflows/dreaming-agents-md-curator.md) | Audits an existing `AGENTS.md` against git, pull request, and agent-run evidence, then files one issue with a ready-to-run agentic update prompt. |

Workers are independently dispatchable and handle exactly one authorized target repository. Review mode routes findings to the control repository; live mode may open the equivalent issue on the target repository.

## Install

Install the campaign into a Central Agentic Ops control repository:

```bash
gh aw add githubnext/gh-aw-cao/dreaming@<catalog-release>
```

The campaign is runnable after credentials, when needed, and checked-in policy are configured.

## Configure

Declare the campaign in `.github/workflows/cao.json`:

```json
{
	"version": 1,
	"control-plane": {
		"campaigns": {
			"dreaming": {
				"mode": "review",
				"max-repositories": 1,
				"workers": {
					"agents-md-curator": { "workflow": "dreaming-agents-md-curator", "max-mode": "review" }
				}
			}
		}
	}
}
```

The omitted fields default to an enabled campaign and worker and 100 percent rollout. Set shared owner and repository boundaries under `control-plane.scope`.

## Validate in review mode

1. Open the generated **Dreaming** workflow in the control repository's **Actions** tab.
2. Select **Run workflow**.
3. Leave `target_repo` blank to discover an eligible repository, or set it to one fully qualified `owner/repository` name.
4. Keep `max_repos` at `1` and `safe_output_mode` at `review`.
5. Inspect the dispatched worker and the review-bundle issue produced in the control repository.

## Safety Boundaries

- CAO policy decides whether and where the campaign may run; workflow capabilities do not grant rollout authority.
- The orchestrator only ranks and dispatches. The worker cannot discover repositories, dispatch more work, or widen mode.
- GitHub reads use scoped tools. Repository mutations use declared safe outputs only.
- The worker is review-capped: `max-mode` limits it to `review` regardless of the campaign's resolved mode.
- Stable titles and deduplication prevent equivalent curation recommendations from being recreated.

## Operational Value

The worker registers a deterministic one-shot operational grader through gh-aw's `operational-value` protocol:

| Worker | Primary metric | Attained evidence |
| --- | --- | --- |
| AGENTS.md Curator | `agents-md-optimization-request-conformance` | One target-bound issue includes ambient context health, estimated gain, proposed edits, an agentic update prompt, and a verification section. |

The evaluator grades validated requests available in the current run. It does not treat a requested issue as applied, accepted, or merged. Missing target evidence and explicit no-op outcomes remain `null`; malformed, inconsistent, or off-target requests score `0`.

## Pause or Stop

Set `control-plane.campaigns.dreaming.enabled` to `false` in a reviewed policy change and cancel active runs. Disable the worker for a narrower stop. Re-enable in review mode after resolving the incident.
