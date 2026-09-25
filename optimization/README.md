# Optimization

> [!NOTE]
> **Experimental campaign:** Worker boundaries and output contracts may change as review evidence accumulates.

Optimization gives maintainers evidence-bounded audits and recommendations for reducing avoidable GitHub Agentic Workflow AI Credit and token consumption, while preserving workflow reliability and accepted outcome quality. Its orchestrator selects one repository with measurable agentic-workflow usage and dispatches bounded token audits and optimization reviews.

## Campaign Contents

| Workflow | Responsibility |
| --- | --- |
| [`optimization`](../.github/workflows/optimization.md) | Hourly and manually dispatchable orchestrator that selects a repository and dispatches campaign workers. |
| [`optimization-token-auditor`](../.github/workflows/optimization-token-auditor.md) | Audits one repository's measured agentic-workflow AI Credit, token use, and reliability. |
| [`optimization-token-optimizer`](../.github/workflows/optimization-token-optimizer.md) | Finds one evidence-complete agentic workflow and recommends a conservative, measurable efficiency change. |

Workers are independently dispatchable and handle exactly one authorized target repository. Review mode routes findings and recommendations to the control repository; live mode may open the equivalent issue on the target repository.

## Install

Install the campaign into a Central Agentic Ops control repository:

```bash
gh aw add githubnext/gh-aw-cao/optimization@<catalog-release>
```

The campaign is runnable after credentials, when needed, and checked-in policy are configured.

## Configure

Declare the campaign in `.github/workflows/cao.json`:

```json
{
	"version": 1,
	"control-plane": {
		"campaigns": {
			"optimization": {
				"mode": "review",
				"max-repositories": 1,
				"workers": {
					"token-auditor": { "workflow": "optimization-token-auditor", "max-mode": "review" },
					"token-optimizer": { "workflow": "optimization-token-optimizer", "max-mode": "review" }
				}
			}
		}
	}
}
```

The omitted fields default to an enabled campaign and worker and 100 percent rollout. Set shared owner and repository boundaries under `control-plane.scope`.

## Validate in review mode

1. Open the generated **Optimization** workflow in the control repository's **Actions** tab.
2. Select **Run workflow**.
3. Leave `target_repo` blank to discover an eligible repository, or set it to one fully qualified `owner/repository` name.
4. Keep `max_repos` at `1` and `safe_output_mode` at `review`.
5. Inspect the dispatched workers and the review-bundle issues produced in the control repository.

## Safety Boundaries

- CAO policy decides whether and where the campaign may run; workflow capabilities do not grant rollout authority.
- Orchestrators only rank and dispatch. Workers cannot discover repositories, dispatch more work, or widen mode.
- GitHub reads use scoped tools. Repository mutations use declared safe outputs only.
- Both workers are review-capped: `max-mode` limits them to `review` regardless of the campaign's resolved mode.
- Stable titles and deduplication prevent equivalent audits and optimization recommendations from being recreated.

## Operational Value

Campaign Insights consumes the package-level repository evaluator in [`operational-value/`](./operational-value/). Its evidence contract evaluates the authorized target repository and counts an outcome regardless of whether the Optimization worker, a maintainer, or another system produced it. AI Credit per successful run, failure rate, and cancellation rate existed before campaign adoption, so the evaluator applies identical seven-day native formulas before and after adoption when retained evidence is available. A vertical adoption marker separates baseline and post-adoption observations; missing repository baselines remain missing rather than becoming zero. Worker-computed cost, reliability, and outcome-quality measurements are strong target-bound evidence candidates, but a proposed recommendation is not realized savings.

## Pause or Stop

Set `control-plane.campaigns.optimization.enabled` to `false` in a reviewed policy change and cancel active runs. Disable an individual worker for a narrower stop. Re-enable in review mode after resolving the incident.
