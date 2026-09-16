---
title: Factory rhythm
description: Understand the seven-day successful-run comparison in Overview.
---

Factory rhythm helps you see whether successful Actions activity is continuing
through the week without reducing recent activity to one total.

## How to read it

The chart always shows Monday through Sunday. Reached weekdays represent
successful runs from the current week. Future weekdays use the matching count
from the previous week, so they do not appear as misleading zeroes.

Use the pattern to notice a change in cadence. It does not explain why activity
rose or fell, and it does not compare failures or output quality.

## Data it uses

`overview-rhythm` reads `started-at` and `run-conclusion` from retained `runs`
across a 15-day window. Dashboard Language converts those records into seven
calendar-week points and counts successful conclusions.

Malformed or unavailable rhythm data renders a stable seven-day empty state
instead of changing the component's shape.