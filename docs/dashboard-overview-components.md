---
title: Overview component model
description: Understand the component boundaries, responsive behavior, and data queries behind Overview.
---

This page explains how the Overview view is composed. Start with the
[operator guide](dashboard-overview.md) if you want to interpret the metrics;
use this page when you are building, reviewing, or testing the interface.

## Built from focused components

Overview uses the standard declarative metric mark for every counter. No
Overview-specific component performs data shaping or renders a chart.

## Declarative composition

The default dashboard declares eight metric views backed by the
`database-*-count` queries. Each query is a whole-store aggregate over a
canonical entity's primary key. The data worker recognizes this shape and uses
native IndexedDB `count()` operations without materializing source rows.

## Responsive by design

The metric views use the `third` layout hint and preserve their declared reading
order as the presenter collapses the grid for narrower viewports.

## Component guides

The Overview source list is `database-campaign-count`,
`database-repository-count`, `database-workflow-count`, `database-run-count`,
`database-domain-count`, `database-tool-count`, `database-audit-count`, and
`database-issue-count`.