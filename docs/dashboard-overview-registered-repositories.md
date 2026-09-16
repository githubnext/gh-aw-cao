---
title: Registered repositories
description: Understand the repository-scope count in Overview.
---

Registered repositories shows how many distinct repositories are represented
in the dashboard's retained control-plane scope. It describes scope, not how
many repositories received work during the selected period.

Select the count to open the Repositories view and inspect the inventory.

## Data it uses

`overview-registered-repository-summary` reads `repositories` and counts
distinct organization and repository pairs.

The metric floor's accessible summary also uses `overview-delivery-summary`.
That query joins successful worker dispatch runs with workflow and repository
inventory to count registered target repositories that received a delivery.

When repository evidence is unavailable, the component reports that state
instead of presenting the missing scope as zero.