---
title: Status header
description: Understand the operating status, work-in-motion label, and retained-output summary at the top of Overview.
---

The status header gives you the overall shape of the operation right now.

## What it shows

- **Work in motion** appears when runs are queued or in progress.
- The heading classifies the available evidence as idle, humming, needing
  attention, under strain, or delivering value.
- The supporting sentence counts retained issue and pull request outputs and
  the repositories they reached.

Treat the heading as a signal, not a health score. Follow an unexpected state
into the relevant run, output, or value view before deciding what happened.

## Data it uses

| Query | Source | Purpose |
| --- | --- | --- |
| `overview-factory-status` | Run and grader summaries | Selects the status heading. |
| `overview-run-summary` | `runs` and workflow inventory | Counts active work, including review and live rollout modes. |
| `overview-outcome-summary` | `outcomes` | Counts retained issue and pull request outputs and delivered repositories. |

If status evidence is unavailable, the header says so instead of inferring a
healthy state.

## When to investigate

Investigate when the heading reports strain, needs attention, or is unavailable.
Start with failed or active Runs, then check retained outputs and Operational
value when run evidence does not explain the status.