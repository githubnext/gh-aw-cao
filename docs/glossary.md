---
title: Glossary
description: Definitions for Central Agentic Ops terminology.
---

CAO names the work from the operator's point of view and preserves the canonical [GitHub Agentic Workflows terminology](https://github.github.com/gh-aw/reference/glossary/) for its implementation. An **operation** is the capability being supervised. A **coordinator** selects work for that operation, a **worker** performs one bounded task, and an **AI agent** reasons within an agentic workflow through a selected engine. An **operator** is always a person.

```text
human operator
  └─ supervises operation
	  ├─ coordinator (orchestrator workflow)
	  │    └─ dispatches work
	  └─ worker workflow
		  └─ performs one bounded task using an AI agent and engine
```

## AI agent

The reasoning component that interprets an agentic workflow's instructions, uses its configured tools, and generates outputs from repository context. GitHub Actions runs the AI agent through a selected engine. An AI agent is not the operation itself or the human supervising it. See the canonical gh-aw definition of [AI Agent](https://github.github.com/gh-aw/reference/glossary/#ai-agent).

## Agentic workflow smell

An evidence-backed warning that a workflow may be harder to control, secure, operate, or justify than necessary; a reason to investigate, not proof of a defect. The dashboard classifies each observation as an agent smell, workflow smell, security finding, or control-plane smell based on what the evidence describes, and normalizes all four into unified Home attention signals.

## Automation

A general description for work performed with limited manual intervention. Automation is not a distinct CAO entity or workflow role. Prefer the specific term **operation**, **coordinator**, **worker**, or **run** when naming something in the product or documentation.

## Coordinator

The CAO operator-facing name for the workflow that selects and dispatches work for an operation. The canonical gh-aw term is [Orchestrator Workflow](https://github.github.com/gh-aw/reference/glossary/#orchestrator-workflow). Workflow source, policy, package manifests, and other technical contracts use the role name `orchestrator`.

## Control plane

The repository that hosts CAO workflows and policy. It coordinates work across explicitly enrolled target repositories. This is CAO's implementation of the gh-aw [Central Control Plane](https://github.github.com/gh-aw/reference/glossary/#central-control-plane) pattern.

## Dispatch

The bounded handoff by which a coordinator starts a worker with one selected target and a resolved control envelope. A dispatch is an event within an operation run, not an operation or agent.

## Engine

The runtime and provider integration used to execute an AI agent. The engine is selected in workflow frontmatter and is distinct from the agent's reasoning role, the workflow being executed, and the operation being supervised. See the canonical gh-aw definition of [Engine](https://github.github.com/gh-aw/reference/glossary/#engine).

## Live authority

The control repository's exclusive right to admit a `live` worker for an operation and target, decided solely from `.github/workflows/cao.json` at the exact workflow SHA. A target repository's files cannot widen, narrow, or veto this decision.

## Operation

A bounded repository-management capability that an operator configures, supervises, and evaluates. An operation is implemented by one coordinator and one or more workers. Examples include Dependabot review, workflow optimization, and compliance assessment.

## Operator

A person who configures, supervises, pauses, reviews, or evaluates operations. Do not use **operator** as a synonym for coordinator, orchestrator, worker, or agent.

## Orchestrator

The technical workflow role that discovers, filters, ranks, selects, and dispatches work within resolved policy. An orchestrator does not mutate target repositories directly. In operator-facing interfaces, call this workflow the **coordinator**. See the canonical gh-aw definition of [Orchestrator Workflow](https://github.github.com/gh-aw/reference/glossary/#orchestrator-workflow).

## Package

A distributable collection of an operation's workflows, shared dependencies, and manifest.

## Run

One execution of a coordinator, worker, or standalone workflow. A coordinator run may produce many dispatches; each dispatch starts a separate worker run. A run records activity and evidence, but successful completion alone does not prove operational value.

## Safe output

A declared, bounded way for a workflow to produce an external effect, such as creating an issue or dispatching a worker. See the canonical gh-aw definition of [Safe Outputs](https://github.github.com/gh-aw/reference/glossary/#safe-outputs).

## Target repository

A repository enrolled for an operation. A target can provide data and receive declared safe outputs, but does not run the control plane's workflows and does not declare live authority in its own files.

## Worker

A workflow that receives one selected target and performs one bounded task for an operation. Workers revalidate their control envelope and can only narrow the policy they receive. **Worker** is both the operator-facing and technical term; it is not synonymous with AI agent or engine because it describes the workflow's role. See the canonical gh-aw definition of [Worker Workflow](https://github.github.com/gh-aw/reference/glossary/#worker-workflow).
