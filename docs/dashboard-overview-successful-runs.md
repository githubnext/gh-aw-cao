---
title: Successful runs
description: Understand the successful and failed run counts in Overview.
---

Successful runs shows how many retained workflow runs completed successfully.
The supporting failure count highlights runs that may need investigation.

Select the success count to open successful runs, or select the failure count
to open Runs with the failure filter applied.

## Data it uses

`overview-run-summary` reads retained `runs` within the selected dashboard
horizon and joins workflow inventory. A run is successful when its conclusion
is `success`.

The failure count includes `failure`, `startup-failure`, `stale`, and
`timed-out` conclusions. Queued and in-progress runs contribute to the shared
work-in-motion status, not to the successful count.

A successful run does not by itself mean that the operation produced or
delivered a safe output.

## When to investigate

Open the failure-filtered Runs view when the supporting failure count is
nonzero. If the success count is unexpectedly low, also check queued and
in-progress runs and confirm that the selected time range is appropriate.