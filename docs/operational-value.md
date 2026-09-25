---
title: Operational Value
description: Measure whether an agentic workflow's intended repository outcome is attained using a frozen evidence contract.
---

Operational value is the degree to which a workflow's intended repository outcome is attained across eligible opportunities, demonstrated by accepted evidence under a fixed measurement contract.

It measures repository outcomes rather than workflow runs, generated output, or an agent's assessment. A person or another system achieving the same outcome must count as success under the same contract.

CAO uses one shared campaign module for both collection paths:

- Scheduled `cao operational-value` collection evaluates only the current repository observation and publishes compact numeric records to the canonical data model.
- Explicit historical evaluation incrementally fills missing immutable observations and produces the evidence archive, timeline, chart, and definitions page.

Both paths import the same frozen evidence contract, collector, and scoring functions. Routine collection does not rebuild repository history, and a metric cannot drift between the dashboard record and its historical report.

## Daily File Diet example

The Daily File Diet workflow in `github/gh-aw` aims to keep non-test Go source files under `pkg/` within a 999-line threshold. Its frozen, baseline-comparable contract evaluates weekly immutable repository snapshots using:

- **Largest-file health** as the primary metric.
- **Compliant line-mass share** as a diagnostic metric.
- The same evidence shape and formulas before and after adoption.

![Daily File Diet operational-value timeline](operational-value/reports/github-gh-aw/daily-file-diet-timeline.svg)

| Result | First observation | Latest observation |
| --- | ---: | ---: |
| Observation date | 2025-10-25 | 2026-09-24 |
| Largest eligible file | 2,785 lines | 1,214 lines |
| Largest-file health | 0.359 | 0.823 |
| Compliant line-mass share | 0.824 | 0.961 |

The deterministic evaluation contains 49 immutable observations through `2026-09-24T19:30:24Z`. All 40 timestamps shared with the original Bash-generated report produced identical commits, evidence, and metric values after the evaluator was converted to JavaScript.

Read the [measure definitions and interpretation](operational-value/reports/github-gh-aw/daily-file-diet-definitions.md), or inspect the versioned raw artifacts:

- [Timeline JSON](https://github.com/githubnext/gh-aw-cao/blob/main/docs/operational-value/reports/github-gh-aw/daily-file-diet-timeline.json)
- [Evidence archive](https://github.com/githubnext/gh-aw-cao/blob/main/docs/operational-value/reports/github-gh-aw/daily-file-diet-evidence-archive.json)
- [Timeline SVG](https://github.com/githubnext/gh-aw-cao/blob/main/docs/operational-value/reports/github-gh-aw/daily-file-diet-timeline.svg)

:::caution[Association is not causation]
The before-and-after result is an association. It does not prove that workflow adoption caused the observed repository change.
:::
