---
title: Status header
description: Understand the operating status and work-in-motion label at the top of Overview.
---

The status header gives you the overall shape of the operation right now.

## What it shows

- **Work in motion** appears when runs are queued or in progress.
- The heading classifies the available evidence as idle, humming, needing
  attention, under strain, or delivering value.

Treat the heading as a signal, not a health score. Follow an unexpected state
into the relevant run, output, or value view before deciding what happened.

## Data it uses

| Query | Source | Purpose |
| --- | --- | --- |
| `overview-factory-status` | Run and grader summaries | Selects the status heading. |
| `overview-run-summary` | `runs` and workflow inventory | Counts active work, including review and live rollout modes. |

If status evidence is unavailable, the header says so instead of inferring a
healthy state.

## When to investigate

Investigate when the heading reports strain, needs attention, or is unavailable.
Start with failed or active Runs, then check retained outputs and Operational
value when run evidence does not explain the status.