---
title: Overview
description: Learn what each part of Overview tells you and which dashboard data it uses.
---

The Overview view brings the current state of your operation into one place.
Each part answers a focused question using results declared in Dashboard
Language.

## Built from focused components

We break views into focused components so each part can be understood, managed,
and tested independently. Components own presentation and interaction while
Dashboard Language owns filtering, joins, and operational calculations. This
keeps the interface consistent without hiding business logic in page code.

<div class="docs-theme-diagram">
	<img class="docs-theme-diagram-light" alt="Color-coded map of the Overview page component boundaries" src="/gh-aw-cao/assets/dashboard-overview-desktop-light.svg">
	<img class="docs-theme-diagram-dark" alt="Color-coded map of the Overview page component boundaries" src="/gh-aw-cao/assets/dashboard-overview-desktop-dark.svg">
</div>

## Responsive by design

We aim to give every view a deliberate mobile experience. Components keep the
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

Each guide describes what the component is for, how to interpret it, and which
Dashboard Language query supplies its data.