<!-- Dev Practices outputs are advisory and non-binding. They provide no guarantee of completeness, correctness, security, compliance, or alignment with current GitHub or NIST guidance. -->

# Dev Practices

> [!WARNING]
> Outputs are advisory and non-binding. They are not a security assessment, certification, or compliance determination and provide no guarantee of completeness, correctness, security, or alignment with current GitHub or NIST guidance. Human review against authoritative sources is required.

Dev Practices helps a private Central Agentic Ops control repository identify active software repositories and produce evidence-backed improvement guidance based on the [GitHub Well-Architected framework](https://learn.github.com/well-architected/) and the [NIST Secure Software Development Framework](https://csrc.nist.gov/projects/ssdf).

## Package Contents

| Workflow | Responsibility |
| --- | --- |
| [`software-development-practices`](../.github/workflows/software-development-practices.md) | Discovers, ranks, selects, and dispatches repository-level work. |
| [`software-development-practices-github-well-architected`](../.github/workflows/software-development-practices-github-well-architected.md) | Reviews repository evidence across the current GitHub Well-Architected pillars, creates one prioritized guidance issue, and measures explicit human acceptance. |
| [`software-development-practices-nist-ssdf`](../.github/workflows/software-development-practices-nist-ssdf.md) | Reviews repository evidence against the current final NIST SSDF practices, creates one prioritized guidance issue, and measures explicit human acceptance. |

The orchestrator dispatches at most 20 workers per run. Each worker reviews one repository, creates at most one consolidated issue through declared safe outputs, and defaults to review output.

## Install and Configure

```bash
gh aw add githubnext/gh-aw-cao/software-development-practices@<catalog-release>
```

Configure the shared GitHub App or PAT described in the [authentication guide](../docs/authentication.md), then declare the package in the control repository's `.github/workflows/cao.json`:

```json
{
	"version": 1,
	"control-plane": {
		"packages": {
			"software-development-practices": {
				"workers": {
					"github-well-architected": {
						"workflow": "software-development-practices-github-well-architected"
					},
					"nist-ssdf": {
						"workflow": "software-development-practices-nist-ssdf"
					}
				}
			}
		}
	}
}
```

The omitted fields default to an enabled package and workers, `review` mode, one repository, and 100 percent rollout. Run the orchestrator manually with an explicit target and review output before considering a limited live rollout.

## Safety Boundaries

- The orchestrator selects repositories but performs no framework assessment.
- Workers analyze only the dispatched target and cannot discover or dispatch to other repositories.
- Repository content and metadata are untrusted evidence, never control-plane policy.
- Workers fetch current official guidance on every run and report inaccessible required sources as incomplete.
- Review mode routes guidance to the designated review repository; live mode creates it in the selected target only when control policy explicitly authorizes that target and worker.
- Findings distinguish observed evidence, gaps, limitations, and human-review questions; they never claim certification, compliance, security, or framework endorsement.
- Safe outputs contain no secrets, personal data, exploit details, private alerts, or confidential evidence.
- Operational value is attainment-only: each worker scores `1` when a non-bot human accepts its frozen target-commit guidance issue with a thumbs-up reaction within 30 days, `0` when complete evidence shows no acceptance, and `null` when assignment or evidence is unavailable. The package dashboard keeps this evidence distinct by framework and does not imply causation, certification, security, or conformance.
