---
title: What Is Central Agentic Ops?
description: Bring GitHub Agentic Workflows across repositories into a shared view and run cross-repository work with explicit ownership and control.
---

Central Agentic Ops (CAO) brings together the day-to-day operation of GitHub Agentic Workflows (AWs): seeing what they do, understanding costs and results, and running shared work within explicit boundaries. It builds on AW's existing capabilities with a shared dashboard and integrated rollout controls for participating workflows.

Issue triage, command-driven tasks, scheduled reports, and on-demand investigations can all contribute to that shared view through their collected run evidence. Cross-repository patterns such as [MultiRepoOps](https://github.github.com/gh-aw/patterns/multi-repo-ops/) and [CentralRepoOps](https://github.github.com/gh-aw/patterns/central-repo-ops/) extend the picture: shared work can run from a side or control repository while project workflows stay alongside the code, under their existing owners.

The same approach works for a maintainer caring for a few projects, a team, an organization, or an enterprise. The starting point is the work and who is responsible for it, not the number of repositories.

## Operating Workflows Across Repositories

A CAO installation has a **control repository**: an ordinary GitHub repository that owns its operating policy, credentials, and the workflows it runs. Alongside those workflows, CAO can observe agentic workflows running in other repositories within its configured collection scope. Those workflows remain where they are, under their existing owners.

The dashboard brings collected activity and available cost, output, and outcome evidence together across repositories. Useful automation can quietly keep running and slip out of view; CAO helps you track its cost, usefulness, and need for attention. A successful run is not automatically a successful outcome.

Shared automation should not require copying the same workflows into every repository it serves. A single workflow can run from its owning repository, analyze an authorized target, and send declared **safe outputs**, such as issues or pull requests, to allowed destinations. Maintainers have one place to improve and operate it; targets receive outputs, not workflow copies to keep in sync.

CAO started with operational **campaigns** as an opinionated approach to coordinated work at scale: an orchestrator discovers, prioritizes, and selects targets, then dispatches workers, each handling one repository. Maintained directly or installed from a catalog, campaigns are today's integrated governance model. CAO policy bounds their scope and starts them in `review` mode, keeping proposed outputs in a review destination and targets unchanged until live output is explicitly authorized.

This is just one of many patterns. When the target and task are already known, a single worker or standalone AW may be enough, without discovery or prioritization. The broader direction is to extend CAO's scope, enablement, and review controls to these simpler approaches, including directly invoked workers and scheduled or event-driven AWs. Those governance integrations remain envisioned rather than available today; orchestration would be used where the work needs coordination.

Observation grants no write authority, and hosting a workflow alongside CAO does not automatically apply its rollout policy. Governed execution requires explicit integration; AWs remain responsible for execution capabilities and safe outputs.

## Shared Work, Independent Ownership

Workflows should live with the people responsible for governing and caring for them: maintaining behavior, reviewing changes, watching costs and results, and deciding when to stop. The intended scope usually tells you who should own the work and where it belongs.

A workflow serving only `owner/repo1` naturally belongs in its `.github/workflows/`, maintained by the project owners. Work serving `owner/repo1`, `owner/repo2`, and other projects usually belongs in an owner- or organization-level CAO control repository, maintained for that shared scope rather than copied into each project. Cross-organization work can belong in an enterprise-operated CAO control repository, hosted in a designated organization by the responsible enterprise team.

Location alone neither restricts a workflow to its hosting repository nor authorizes access to others. Actual reach depends on explicit policy, credentials, and workflow capabilities.

“Central” means an operating point for its owner's scope, not one global installation. Repository, organization, and enterprise workflows can coexist without moving everything to the highest level.

Project owners retain their local automation and review requirements alongside shared work. CAO policy governs participating campaigns, not every workflow in a repository it observes or targets.

This leaves room for an open ecosystem: owners can share campaigns, learn from evidence, and contribute improvements without handing over control. Reusing a campaign shares its implementation, not its credentials or rollout authority. Each control repository makes its own scope and adoption decisions.

Openness need not mean public operational data. A control repository should be public only when its policy, run metadata, dashboard data, evidence, and review outputs can also be public.

## Get Started

[Set up CAO](setup-quickstarts.md) for the repositories you want it to reach, then use the [dashboard](dashboard.md) and [CAO commands](cao-cli.md) to follow the work. You can [browse reusable campaigns](catalog.md) or [build your own](author-your-first-operation.md) as your needs develop. The [control plane overview](architecture.md) explains the execution and safety boundaries in more detail.
