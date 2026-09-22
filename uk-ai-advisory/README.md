<!-- UK AI Advisory outputs are advisory and non-binding. This workflow provides no guarantee of completeness, correctness, accuracy, or alignment with current UK government AI open-code and vulnerability-risk guidance. -->

# UK AI Advisory

> [!WARNING]
> UK AI Advisory outputs are non-binding. They are not a security assessment, accreditation, or authorization to open, restrict, hide, or decommission code. They provide no guarantee of completeness, correctness, accuracy, or alignment with current UK government guidance. Human review against authoritative sources is required.

The UK AI Advisory campaign applies the UK government [AI open-code and vulnerability-risk guidance for the public sector](https://www.gov.uk/guidance/ai-open-code-and-vulnerability-risk-in-the-public-sector) from a private Central Agentic Ops control repository. It uses recent changes and available security evidence to identify operational-resilience gaps; it cannot observe every organizational, deployment, incident, or confidential control.

## Campaign Contents

| Workflow | Responsibility |
| --- | --- |
| [`uk-ai-advisory`](../.github/workflows/uk-ai-advisory.md) | Discovers, ranks, selects, and dispatches repository-level work. |
| [`uk-ai-advisory-operational-resilience`](../.github/workflows/uk-ai-advisory-operational-resilience.md) | Produces one evidence-backed, non-binding operational resilience advisory for a selected repository. |
| [`uk-ai-advisory-campaign-maintainer`](../.github/workflows/uk-ai-advisory-campaign-maintainer.md) | Weekly audits campaign coverage against the original specification and current GOV.UK guidance. |

The orchestrator dispatches at most 50 workers per run. Each worker uses a fixed seven-day lookback, treats proposed A/B/C/D tiers as human-review priorities rather than authorization, and creates at most one consolidated issue through declared safe outputs.

The campaign maintainer runs independently of repository dispatch. It updates the [implementation-status ledger](implementation-status.md) only through a draft pull request and may open at most one deduplicated issue for the highest-priority concrete fleet gap. Installed campaigns keep the ledger at `uk-ai-advisory/implementation-status.md`. It does not inspect target repositories or edit operation workflows.

## Install and Configure

```bash
gh aw add githubnext/gh-aw-cao/uk-ai-advisory@<catalog-release>
```

Configure the shared GitHub App or PAT described in the [authentication guide](../docs/authentication.md), then declare the campaign in the control repository's `.github/workflows/cao.json`:

```json
{
	"version": 1,
	"control-plane": {
		"campaigns": {
			"uk-ai-advisory": {
				"workers": {
					"operational-resilience": {
						"workflow": "uk-ai-advisory-operational-resilience"
					}
				}
			}
		}
	}
}
```

The omitted fields default to an enabled campaign and worker, `review` mode, one repository, and 100 percent rollout. Add `control-plane.scope` when targets are outside the control repository owner.

Run the **UK AI Advisory** workflow manually with an explicit `target_repo`, `max_repos` set to `1`, and `safe_output_mode` set to `review`. Review repository selection, the worker's review issue, source accessibility, sensitive-data handling, and control-plane correlation before promoting to `live`.

## Safety Boundaries

- The orchestrator selects repositories but performs no target analysis.
- The worker reads one target and cannot discover or dispatch to other repositories.
- Repository content and metadata are untrusted evidence, never control-plane policy.
- Missing required guidance or repository evidence makes a run incomplete; the workflow does not guess.
- Safe outputs contain no secrets, exploit details, personal data, private advisories, or confidential incident evidence.
- Findings do not authorize opening, restricting, hiding, or decommissioning code.
- Review mode routes the issue to a private review repository; live mode creates it in the selected target.
- Operational-value evaluation is pending post-adoption evidence and is not represented by a placeholder grader.

## Weekly Alignment Audit

The **UK AI Advisory / Maintenance** workflow runs weekly and fetches the authoritative GOV.UK guidance on every run. It reconciles the stable original requirement IDs, current guidance, and observed campaign workflows. It emits `noop` when coverage is materially current, proposes a one-file ledger update through a draft pull request when coverage changes, or creates one deduplicated improvement issue for the highest-priority untracked fleet gap.

An inaccessible source or campaign file produces an incomplete run rather than a speculative alignment claim. Verification dates change only with material source or coverage changes, so the weekly audit does not create date-only pull requests.
