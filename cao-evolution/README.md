# CAO Evolution Package

CAO Evolution operates on verified Central Agentic Ops control and agentic-workflow repositories. It keeps control-plane authority and package configuration consistent, surfaces recurring runtime failures, identifies portfolio and per-workflow waste, curates ambient context, and proactively suggests missing operational capabilities without taking over target-repository work.

| Workflow | Responsibility |
| --- | --- |
| `cao-evolution` | Select verified CAO control repositories and dispatch eligible workers. |
| `cao-evolution-integrity` | Check policy, authority, package ownership, installed workflows, and dashboard configuration for drift. |
| `cao-evolution-reliability` | Cluster actionable CAO admission, dispatch, worker, cache, review-bundle, and dashboard failures. |
| `cao-evolution-efficiency` | Rank package health from run, review-item, cost, and operational-value evidence, then suggest one measurable portfolio-level improvement. |
| `cao-evolution-catalog-advisor` | Match one recurring capability gap to a public operation in the official catalog, or identify a custom operation gap when none fits. |
| `cao-evolution-failures-investigator` | Group recent agentic-workflow failures by signature and publish focused fix issues. |
| `cao-evolution-compiler-security` | Compile and scan agentic workflows, then publish deduplicated remediation findings. |
| `cao-evolution-ai-credit-auditor` | Record daily AI Credit, token, and forecast evidence. |
| `cao-evolution-ai-credit-optimizer` | Recommend an evidence-backed change for the highest-impact workflow. |
| `cao-evolution-agents-md-curator` | Propose small updates to stale or oversized root agent instructions. |
| `cao-evolution-skills-curator` | Improve layering between root instructions, agent definitions, and skills. |

## Install

```bash
gh aw add githubnext/gh-aw-cao/cao-evolution@main
```

Declare the package and its workers in `.github/workflows/cao.json`. Begin in `review` mode with one control repository per run. Promote only through a reviewed policy change after validating the rolling reports.

## Boundaries

- The package selects only repositories with a checked-in CAO policy and runtime or installed-package evidence.
- The orchestrator only selects and dispatches. Each worker handles one authorized control repository and cannot discover or dispatch more work.
- GitHub tools are read-only. Workers emit one stable, deduplicated attention issue, a materially changed update comment, or `noop`.
- Catalog recommendations use an immutable published catalog release. They never install packages, edit `.github/workflows/cao.json`, enable workers, promote rollout mode, or dispatch suggested operations.
- Package health uses the authoritative activity and safe-output evidence that feeds the dashboard. Browser IndexedDB remains disposable per-browser derived state and is never queried as workflow authority.
- Agentic-workflow failure investigation, compiler-security maintenance, AI Credit optimization, and ambient-context curation are part of CAO Evolution. General gh-aw upgrades remain outside this package.
- This package does not delete caches or artifacts.

Operational-value design is intentionally deferred until each worker has adoption-time evidence.