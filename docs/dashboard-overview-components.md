---
title: Overview component model
description: Understand the component boundaries, responsive behavior, and data queries behind Overview.
---

This page explains how the Overview view is composed. Start with the
[operator guide](dashboard-overview.md) if you want to interpret the metrics;
use this page when you are building, reviewing, or testing the interface.

## Built from focused components

Overview uses focused components so each part can be understood, maintained,
and tested independently. Components own presentation and interaction, while
Dashboard Language owns filtering, joins, and operational calculations. This
keeps the interface consistent without hiding business logic in page code.

<div class="docs-theme-diagram">
	<img class="docs-theme-diagram-light" alt="Color-coded map of the Overview page component boundaries" src="/gh-aw-cao/assets/dashboard-overview-desktop-light.svg">
	<img class="docs-theme-diagram-dark" alt="Color-coded map of the Overview page component boundaries" src="/gh-aw-cao/assets/dashboard-overview-desktop-dark.svg">
</div>

## Responsive by design

Every view has a deliberate mobile experience. Components keep the
same meaning, data, and reading order, but their layout may differ when a narrow
screen needs a better way to scan or compare information. Mobile does not have
to reproduce the desktop arrangement or simply stack every block.

In Overview, the narrative and seven-day rhythm form one reading column, while
the four related metrics become a 2 x 2 comparison grid. No content or evidence
is removed.

## Component guides

- [Status header](dashboard-overview-status-header.md) explains the operating
	state, work-in-motion label, and retained-output summary.
- [Factory rhythm](dashboard-overview-factory-rhythm.md) explains the seven-day
	successful-run comparison.
- [Registered repositories](dashboard-overview-registered-repositories.md)
	explains the repository-scope count.
- [Successful runs](dashboard-overview-successful-runs.md) explains the success
	and failure counts.
- [Dispatches](dashboard-overview-dispatches.md) explains dispatched work and
	failed dispatches.
- [Value gains](dashboard-overview-value-gains.md) explains the grader evidence
	associated with operational value.

Each guide follows the same structure: what the component shows, how to read
it, which Dashboard Language query supplies its data, and when to investigate.