---
title: Repositories registered
description: Understand the repository-scope count in Overview.
---

Repositories registered shows how many canonical repository identities are
represented in the dashboard's retained control-plane scope. IndexedDB resolves
this inventory count directly without loading repository records. It describes
scope, not how many repositories received work during the selected period.

Select the count to open the Repositories view and inspect the inventory.

The Repositories run-volume chart reads repository identities and distinct
retained run IDs directly. It does not wait for workflow health, outcome reports,
AI Credit totals, or imported event coverage. It ranks up to 100 repositories
with drill-down links; the Table view retains the full inventory and its
execution-health and import-coverage metrics.

## Data it uses

`overview-registered-repository-summary` reads `repositories` and counts
distinct organization and repository pairs.

The metric floor's accessible summary also uses `overview-delivery-summary`.
That query joins successful worker dispatch runs with workflow and repository
inventory to count registered target repositories that received a delivery.

When repository evidence is unavailable, the component reports that state
instead of presenting the missing scope as zero.

## When to investigate

Open Repositories when the count changes unexpectedly or does not match the
reviewed rollout policy. Compare the inventory with delivery evidence before
concluding that every registered repository received work.