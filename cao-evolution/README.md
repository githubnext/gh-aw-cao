# CAO Evolution Package

CAO Evolution operates on verified Central Agentic Ops control repositories. It keeps control-plane authority and package configuration consistent, surfaces recurring runtime failures, and identifies portfolio-level waste without taking over target-repository work.

| Workflow | Responsibility |
| --- | --- |
| `cao-evolution` | Select verified CAO control repositories and dispatch eligible workers. |
| `cao-evolution-integrity` | Check policy, authority, package ownership, installed workflows, and dashboard configuration for drift. |
| `cao-evolution-reliability` | Cluster actionable CAO admission, dispatch, worker, cache, review-bundle, and dashboard failures. |
| `cao-evolution-efficiency` | Rank package health from run, review-item, cost, and operational-value evidence, then suggest one measurable portfolio-level improvement. |

## Install

```bash
gh aw add githubnext/gh-aw-cao/cao-evolution@main
```

Declare the package and its workers in `.github/workflows/cao.json`. Begin in `review` mode with one control repository per run. Promote only through a reviewed policy change after validating the rolling reports.

## Boundaries

- The package selects only repositories with a checked-in CAO policy and runtime or installed-package evidence.
- The orchestrator only selects and dispatches. Each worker handles one authorized control repository and cannot discover or dispatch more work.
- GitHub tools are read-only. Workers emit one stable, deduplicated attention issue, a materially changed update comment, or `noop`.
- Package health uses the authoritative activity and safe-output evidence that feeds the dashboard. Browser IndexedDB remains disposable per-browser derived state and is never queried as workflow authority.
- General gh-aw upgrades and workflow failures remain with AW Doctor. Per-workflow prompt, model, AI Credit, `AGENTS.md`, and skill optimization remain with AW Optimization.
- The existing conventional `cao-maintenance.yml` workflow owns cache cleanup; this package does not delete caches or artifacts.

Operational-value design is intentionally deferred until each worker has adoption-time evidence.