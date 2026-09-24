# CAO Evolution Campaign

CAO Evolution operates on verified Central Agentic Ops control repositories. It keeps control-plane authority and campaign configuration consistent, surfaces recurring runtime failures, identifies portfolio-level waste, and proactively suggests missing operational capabilities without taking over target-repository work.

| Workflow | Responsibility |
| --- | --- |
| `cao-evolution` | Select verified CAO control repositories and dispatch eligible workers. |
| `cao-evolution-integrity` | Check policy, authority, campaign ownership, installed workflows, and dashboard configuration for drift. |
| `cao-evolution-reliability` | Cluster actionable CAO admission, dispatch, worker, cache, review-bundle, and dashboard failures. |
| `cao-evolution-efficiency` | Rank campaign health from run, review-item, cost, and operational-value evidence, then suggest one measurable portfolio-level improvement. |
| `cao-evolution-catalog-advisor` | Match one recurring capability gap to a public operation in the official catalog, or identify a custom operation gap when none fits. |
| `cao-evolution-failures-investigator` | Group recent agentic-workflow failures by signature and publish focused fix issues. |
| `cao-evolution-compiler-security` | Compile and scan agentic workflows, then publish deduplicated remediation findings. |

## Install

```bash
gh aw add githubnext/gh-aw-cao/cao-evolution@main
```

Declare the campaign and its workers in `.github/workflows/cao.json`. Begin in `review` mode with one control repository per run. Promote only through a reviewed policy change after validating the rolling reports.

## Boundaries

- The campaign selects only repositories with a checked-in CAO policy and runtime or installed-campaign evidence.
- The orchestrator only selects and dispatches. Each worker handles one authorized control repository and cannot discover or dispatch more work.
- GitHub tools are read-only. Workers emit one stable, deduplicated attention issue, a materially changed update comment, or `noop`.
- Catalog recommendations use an immutable published catalog release. They never install campaigns, edit `.github/workflows/cao.json`, enable workers, promote rollout mode, or dispatch suggested operations.
- Campaign health uses the authoritative activity and safe-output evidence that feeds the dashboard. Browser IndexedDB remains disposable per-browser derived state and is never queried as workflow authority.
- Agentic-workflow failure investigation and compiler-security maintenance are part of CAO Evolution. General gh-aw upgrades remain outside this campaign. Per-workflow prompt, model, AI Credit, `AGENTS.md`, and skill optimization remain with Optimization.
- This campaign does not delete caches or artifacts.

Operational-value design is intentionally deferred until each worker has adoption-time evidence.