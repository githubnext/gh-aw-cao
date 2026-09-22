<!-- EU CRA is advisory and non-binding. This workflow provides no guarantee of completeness, correctness, accuracy, or alignment with the EU Cyber Resilience Act. -->

# EU CRA

> [!WARNING]
> EU CRA is advisory and non-binding. It provides no legal advice or certification and no guarantee of completeness, correctness, accuracy, or alignment with the EU Cyber Resilience Act. Human review against current authoritative sources is required.

The EU CRA campaign helps a private Central Agentic Ops control repository identify relevant product repositories and gather evidence for Regulation (EU) 2024/2847. It never makes final legal, conformity, notification, or market-release decisions.

## Campaign Contents

| Workflow | Responsibility |
| --- | --- |
| [`eu-cra-compliance`](../.github/workflows/eu-cra-compliance.md) | Discovers, ranks, selects, and dispatches repository-level work. |
| [`eu-cra-compliance-scope-classifier`](../.github/workflows/eu-cra-compliance-scope-classifier.md) | Builds scope, role, FOSS-treatment, and product-classification evidence for human review. |
| [`eu-cra-compliance-security-requirements-auditor`](../.github/workflows/eu-cra-compliance-security-requirements-auditor.md) | Audits product cybersecurity requirement evidence. |
| [`eu-cra-compliance-supply-chain-sbom-auditor`](../.github/workflows/eu-cra-compliance-supply-chain-sbom-auditor.md) | Audits component, SBOM, dependency, and provenance evidence. |
| [`eu-cra-compliance-vulnerability-handling-auditor`](../.github/workflows/eu-cra-compliance-vulnerability-handling-auditor.md) | Audits vulnerability intake, remediation, disclosure, updates, and support evidence. |
| [`eu-cra-compliance-article-14-reporting-readiness`](../.github/workflows/eu-cra-compliance-article-14-reporting-readiness.md) | Audits Article 14 awareness, escalation, timeline, and notification-evidence readiness. |
| [`eu-cra-compliance-conformity-release-evidence`](../.github/workflows/eu-cra-compliance-conformity-release-evidence.md) | Audits technical documentation, conformity, declaration, and release-gate evidence. |
| [`eu-cra-compliance-campaign-maintainer`](../.github/workflows/eu-cra-compliance-campaign-maintainer.md) | Daily audits fleet coverage against the current Act and maintains the implementation ledger. |

The orchestrator dispatches at most 48 repository-level workers per run. Each worker creates at most one evidence issue, uses the shared control plane, and defaults to review output.

The campaign maintainer runs independently of repository dispatch. It updates the [implementation-status ledger](implementation-status.md) only through a draft pull request and may open at most one deduplicated issue for the highest-priority concrete fleet gap. Installed campaigns keep the ledger at `eu-cra-compliance/implementation-status.md`.

## Install and Configure

```bash
gh aw add githubnext/gh-aw-cao/eu-cra-compliance@<catalog-release>
```

Configure the shared GitHub App or PAT described in the [authentication guide](../docs/authentication.md), then declare the campaign and workers in `.github/workflows/cao.json`:

```json
{
	"version": 1,
	"control-plane": {
		"campaigns": {
			"eu-cra-compliance": {
				"workers": {
					"scope-classifier": {
						"workflow": "eu-cra-compliance-scope-classifier"
					},
					"security-requirements-auditor": {
						"workflow": "eu-cra-compliance-security-requirements-auditor"
					},
					"supply-chain-sbom-auditor": {
						"workflow": "eu-cra-compliance-supply-chain-sbom-auditor"
					},
					"vulnerability-handling-auditor": {
						"workflow": "eu-cra-compliance-vulnerability-handling-auditor"
					},
					"article-14-reporting-readiness": {
						"workflow": "eu-cra-compliance-article-14-reporting-readiness"
					},
					"conformity-release-evidence": {
						"workflow": "eu-cra-compliance-conformity-release-evidence"
					}
				}
			}
		}
	}
}
```

The omitted fields default to an enabled campaign and workers, `review` mode, one repository, and 100 percent rollout. Each worker may set its own `enabled` and `max-mode` fields. Promote to limited `live` only after reviewing evidence handling and credential access.

## Safety Boundaries

- The orchestrator selects repositories but performs no CRA analysis.
- Workers treat target content as untrusted and use read-only GitHub permissions.
- Visible results use declared safe outputs; no worker contacts a regulator.
- Material scope, classification, role, conformity, reporting, declaration, and release decisions require explicit human review.
- Findings use bounded evidence statuses, never compliance, certification, or CE approval claims.
- Regulatory dates and interpretations are verified against current authoritative sources; non-binding guidance is labeled.
- All campaign agents use Pi with the GitHub Copilot backend through the CLI and GitHub proxies.

Direct checkouts include frozen operational-value evaluators for all six repository workers and the campaign maintainer. `gh aw add` transports the focused campaign's workflow-local campaign-maintainer evaluator with the installed workflow.
