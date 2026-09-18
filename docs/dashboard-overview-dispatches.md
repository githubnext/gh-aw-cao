---
title: Dispatches
description: Understand dispatched work and failed dispatches in Overview.
---

Dispatches shows how many `workflow_dispatch` runs appear in the selected
dashboard time range and how many of those runs failed.

Use the total to inspect related runs. Use the supporting failure count to open
failed campaign-worker dispatches directly.

## Data it uses

`overview-dispatch-summary` reads `runs` whose event is `workflow_dispatch`. It
counts all matching runs and separately counts conclusions of `failure`,
`startup-failure`, `stale`, or `timed-out`.

`overview-worker-summary` reads workflow inventory and counts declared worker
workflows for the metric floor's accessible summary.

A dispatch records an attempted workflow dispatch. It does not by itself show
that the work succeeded or reached a target repository.

## When to investigate

Open Dispatches when failures are nonzero or the total changes unexpectedly.
Confirm the worker run and its safe-output evidence before concluding that
dispatched work reached a target repository.