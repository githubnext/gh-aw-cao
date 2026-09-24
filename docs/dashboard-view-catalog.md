---
title: Dashboard view catalog
description: Find every standardized CAO dashboard experience, Dashboard Language page, view mark, chart, and named UI element.
---

This catalog helps dashboard builders choose an existing page, mark, chart, or
named UI element before creating something new. It describes the available
presentation vocabulary and the purpose of each option.

The executable vocabulary remains authoritative in
`dashboard/site/src/specification.js`; named element implementations are
registered in `dashboard/site/src/components/ui-elements.js`.

For a concrete ownership and responsive-layout example, see the [Overview component model](dashboard-overview-components.md).

## Primary product views

These are the default product destinations. They are custom pages composed from named elements so their data remains declarative while each specialized interaction has one DOM owner.

| Page ID | Navigation title | Named element | Purpose |
| --- | --- | --- | --- |
| `overview` | Overview | `factory-header`, `factory-floor`, `link-button-list` | Summarizes campaign health, repository coverage, weekly rhythm, and campaign shortcuts. |
| `work` | Work | `work-project-view` | Presents delegated work as board, task, and roadmap modes. |
| `agents` | Operations | `agent-marketplace-view` | Presents the policy-scoped campaign and agent marketplace. |
| `insights` | Insights | `insights-overview` | Composes outcomes, value, usage, runtime, security, and experiment evidence. |
| `configuration` | Settings | `configuration-policy` | Presents checked-in control policy and its editable settings surface. |

## Built-in pages

Built-in pages carry renderer-defined semantic requirements and required source contracts.

| Page | Purpose |
| --- | --- |
| `overview` | Cross-domain operational overview with availability and filter context. |
| `organizations` | Organization inventory and aggregate repository, workflow, run, and usage activity. |
| `repositories` | Repository activity, workflow coverage, failures, and usage. |
| `campaigns` | Installed campaign inventory, registration, modes, runs, and utilization. |
| `workflows` | Workflow inventory, role, rollout mode, activity, runs, and usage. |
| `runs` | Workflow run status, conclusion, model, engine, timing, and repository context. |
| `audits` | Ordered audit evidence linked directly to retained runs. |
| `experiments` | Experiment definitions and observed variants. |
| `graders` | Grader definitions and scored run observations. |
| `evals` | Evaluation definitions and run-level results. |
| `usage` | Token, AIC, estimated cost, model, engine, and scope usage. |
| `engines-models` | Model and engine utilization plus run aggregates. |
| `operational-value` | Ordered native gh-aw metrics with units, directions, and run provenance. |
| `findings` | Linked security and quality findings with status and severity. |
| `issues` | Reusable issue entity cards bound to safe-output queries with explicit drill behavior. |

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
| `area` | Show quantitative change over an ordered or temporal axis, optionally stacked by color. |
| `bar` | Compare quantitative values across categories. |
| `dot` | Compare compact point values across categories. |
| `heatmap` | Show intensity across two categorical or temporal dimensions. |
| `histogram` | Show the distribution of a quantitative field. |
| `horizontal-bar` | Compare up to 100 labeled quantitative values with labels on the left and bars aligned on the right. |
| `line` | Show change across an ordered or temporal axis. |
| `pie` | Show a bounded part-to-whole composition. |
| `scatter` | Show relationships between two quantitative fields. |
| `swimlane` | Show events or intervals across categorical lanes and time. |

## Named UI elements

Named elements own specialized DOM, accessibility, interaction, local state, and cleanup. Their source shaping remains in Dashboard Language queries.

| Element | Purpose |
| --- | --- |
| `domain-attention` | Renders data-driven attention summaries by operational domain. |
| `campaign-status-grid` | Shows compact status across installed campaigns. |
| `summary-grid` | Presents a reusable grid of summarized values. |
| `readiness-verdict` | Presents the control-plane readiness decision and supporting evidence. |
| `context-summary` | Summarizes the active scope and contextual evidence. |
| `anomaly-readiness` | Presents anomaly-detection readiness and gaps. |
| `signal-list` | Presents a compact list of evidence-backed signals. |
| `needs-attention-list` | Presents grouped unresolved evidence with observation time, one GitHub action link, and an optional full-list route. |
| `campaign-activity` | Composes campaign activity views. |
| `campaign-activity-shell` | Coordinates campaign activity modes and shared chrome. |
| `campaign-utilization` | Presents campaign utilization measures. |
| `campaign-run-trend` | Presents campaign run history and trend. |
| `campaign-summary-table` | Presents the campaign summary table. |
| `campaign-insights` | Presents the insights variant of a routed campaign page. |
| `campaign-detail` | Presents the workflows variant of a routed campaign page. |
| `campaign-dispatches` | Compatibility element that presents the workflow-runs variant of a routed campaign page. |
| `campaign-reports` | Presents the reports variant of a routed campaign page. |
| `campaign-route` | Resolves and composes a route-selected campaign experience. |
| `workflow-route` | Resolves a route-selected workflow experience. |
| `workflow-route-page` | Composes a complete routed workflow page. |
| `outcome-detail` | Presents one outcome and its linked evidence. |
| `outcome-detail-section` | Presents a declared section within an outcome detail. |
| `configuration-policy` | Presents and edits checked-in CAO policy. |
| `configuration-actions` | Presents approved configuration actions. |
| `local-database` | Presents local canonical database diagnostics. |
| `work-project-view` | Presents delegated work in board, task, and roadmap modes. |
| `agent-marketplace-view` | Presents policy-scoped campaigns and agent capabilities. |
| `insights-overview` | Composes the primary cross-domain Insights experience. |
| `factory-header` | Presents factory status, retained-output context, work in motion, and weekly rhythm. |
| `factory-floor` | Presents linked repository, run, dispatch, and value stations. |
| `link-button-list` | Presents one source as an inset grouped list of Octicon navigation rows with disclosure chevrons. |
| `campaign-problem-list` | Presents current runtime problems for a campaign, grouped by workflow, with retained failure evidence and a "Fix with Copilot" repair prompt. |
| `outcomes-overview` | Compatibility alias that composes the factory header and floor for existing version 0.1.0 documents. |

## Testing standard

Generic marks are covered by validator and presenter tests. Named elements require focused unit tests for states and cleanup, plus Playwright when behavior depends on browser layout, navigation, focus, scrolling, workers, or responsive interaction. The integrated local visual fixture is available at `?fixtures=1#page-overview` for Overview and equivalent page hashes for other destinations.