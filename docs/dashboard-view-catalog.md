---
title: Dashboard view catalog
description: Find every standardized CAO dashboard experience, Dashboard Language page, view mark, chart, and named UI element.
---

This catalog is the human-readable index of standardized dashboard views. The executable vocabulary remains authoritative in `dashboard/site/src/specification.js`; named element implementations are registered in `dashboard/site/src/components/ui-elements.js`.

For a concrete ownership and responsive-layout example, see the [Overview component model](dashboard-overview-components.md).

## Primary product views

These are the default product destinations. They are custom pages composed from named elements so their data remains declarative while each specialized interaction has one DOM owner.

| Page ID | Navigation title | Named element | Purpose |
| --- | --- | --- | --- |
| `overview` | Overview | `outcomes-overview` | Summarizes current motion, outcomes, delivery, runs, dispatches, value, and weekly rhythm. |
| `work` | Work | `work-project-view` | Presents delegated work as board, task, and roadmap modes. |
| `agents` | Operations | `agent-marketplace-view` | Presents the policy-scoped package and agent marketplace. |
| `insights` | Insights | `insights-overview` | Composes outcomes, value, usage, runtime, security, and experiment evidence. |
| `configuration` | Settings | `configuration-policy` | Presents checked-in control policy and its editable settings surface. |

## Built-in pages

Built-in pages carry renderer-defined semantic requirements and required source contracts.

| Page | Purpose |
| --- | --- |
| `overview` | Cross-domain operational overview with availability and filter context. |
| `organizations` | Organization inventory and aggregate repository, workflow, run, and usage activity. |
| `repositories` | Repository activity, workflow coverage, failures, and usage. |
| `packages` | Installed package inventory, registration, modes, runs, and utilization. |
| `workflows` | Workflow inventory, role, rollout mode, activity, runs, and usage. |
| `runs` | Workflow run status, conclusion, model, engine, timing, and repository context. |
| `sessions` | Agent session inventory associated with retained runs. |
| `events` | Ordered session and execution event evidence. |
| `experiments` | Experiment definitions and observed variants. |
| `graders` | Grader definitions and scored run observations. |
| `evals` | Evaluation definitions and run-level results. |
| `usage` | Token, AIC, estimated cost, model, engine, and scope usage. |
| `engines-models` | Model and engine utilization plus run aggregates. |
| `operational-value` | Value observations, evidence, maturity, and baseline deltas. |
| `findings` | Linked security and quality findings with status and severity. |

## Declarative marks

| Mark | Purpose |
| --- | --- |
| `metric` | One summarized value with optional tone, icon, navigation, and number animation. |
| `table` | Structured rows with declared columns, formats, links, summaries, and actions. |
| `list` | Repeated records rendered as cards or issue-style rows. |
| `chart` | A declared graphical encoding rendered by one of the standard chart types. |
| `element` | A named reusable component for interaction or presentation beyond the generic marks. |
| `callout` | A concise labeled status or attention message. |

## Standard charts

| Chart | Purpose |
| --- | --- |
| `bar` | Compare quantitative values across categories. |
| `dot` | Compare compact point values across categories. |
| `heatmap` | Show intensity across two categorical or temporal dimensions. |
| `histogram` | Show the distribution of a quantitative field. |
| `line` | Show change across an ordered or temporal axis. |
| `pie` | Show a bounded part-to-whole composition. |
| `scatter` | Show relationships between two quantitative fields. |
| `swimlane` | Show events or intervals across categorical lanes and time. |

## Named UI elements

Named elements own specialized DOM, accessibility, interaction, local state, and cleanup. Their source shaping remains in Dashboard Language queries.

| Element | Purpose |
| --- | --- |
| `domain-attention` | Renders data-driven attention summaries by operational domain. |
| `package-status-grid` | Shows compact status across installed packages. |
| `summary-grid` | Presents a reusable grid of summarized values. |
| `readiness-verdict` | Presents the control-plane readiness decision and supporting evidence. |
| `context-summary` | Summarizes the active scope and contextual evidence. |
| `anomaly-readiness` | Presents anomaly-detection readiness and gaps. |
| `signal-list` | Presents a compact list of evidence-backed signals. |
| `package-activity` | Composes package activity views. |
| `package-activity-shell` | Coordinates package activity modes and shared chrome. |
| `package-utilization` | Presents package utilization measures. |
| `package-run-trend` | Presents package run history and trend. |
| `package-summary-table` | Presents the package summary table. |
| `package-insights` | Presents the insights variant of a routed package page. |
| `package-detail` | Presents the workflows variant of a routed package page. |
| `package-dispatches` | Presents the dispatches variant of a routed package page. |
| `package-reports` | Presents the reports variant of a routed package page. |
| `package-route` | Resolves and composes a route-selected package experience. |
| `workflow-route` | Resolves a route-selected workflow experience. |
| `workflow-route-page` | Composes a complete routed workflow page. |
| `outcome-detail` | Presents one outcome and its linked evidence. |
| `outcome-detail-section` | Presents a declared section within an outcome detail. |
| `configuration-policy` | Presents and edits checked-in CAO policy. |
| `configuration-actions` | Presents approved configuration actions. |
| `local-database` | Presents local canonical database diagnostics. |
| `work-project-view` | Presents delegated work in board, task, and roadmap modes. |
| `agent-marketplace-view` | Presents policy-scoped packages and agent capabilities. |
| `insights-overview` | Composes the primary cross-domain Insights experience. |
| `outcomes-overview` | Composes the primary Overview factory experience. |

## Testing standard

Generic marks are covered by validator and presenter tests. Named elements require focused unit tests for states and cleanup, plus Playwright when behavior depends on browser layout, navigation, focus, scrolling, workers, or responsive interaction. The integrated local visual fixture is available at `?fixtures=1#page-overview` for Overview and equivalent page hashes for other destinations.