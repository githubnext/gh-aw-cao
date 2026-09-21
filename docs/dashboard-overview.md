---
title: Overview
description: Understand the current activity, delivery evidence, and operational signals on the dashboard's default view.
---

Overview is the dashboard's default operational view. It reports compact counts
of the canonical records retained in the browser's local dashboard database.

## What Overview shows

| Counter | What it tells you |
| --- | --- |
| **Campaigns** | Campaign records in the canonical store. |
| **Repositories** | Repository records in the canonical store. |
| **Workflows** | Workflow records in the canonical store. |
| **Runs** | Run records in the canonical store. |
| **Domains** | Domain observation records in the canonical store. |
| **Tools** | Tool observation records in the canonical store. |
| **Audits** | Audit observation records in the canonical store. |
| **Issues** | Issue and pull-request records in the canonical store. |

For the component boundaries, responsive behavior, and exact query names behind
each area, see the [Overview component model](dashboard-overview-components.md).

## How to interpret the metrics

Each value is an inventory count, not a health or conversion score. Use the
corresponding dashboard page to inspect the records behind a count.

## Where the data comes from

Overview uses the shared snapshot published by [CAO Activity](activity.md). The
[Activity Specification](https://github.com/githubnext/gh-aw-cao/blob/main/specs/activity.md)
defines the snapshot and its requirements.

| Source | How Overview uses it |
| --- | --- |
| `campaigns` | Counts canonical campaigns. |
| `repositories` | Counts canonical repositories. |
| `workflows` | Counts canonical workflows. |
| `runs` | Counts canonical runs. |
| `domains` | Counts canonical domain observations. |
| `tools` | Counts canonical tool observations. |
| `audits` | Counts canonical audit observations. |
| `issues` | Counts canonical issue and pull-request observations. |

The Overview queries are whole-store counts. The data worker maps them directly
to native IndexedDB `count()` operations instead of loading records into memory.

## When to investigate

Investigate a count on its corresponding detailed page when it differs from the
expected retained inventory. Always check evidence freshness before drawing a
conclusion.
