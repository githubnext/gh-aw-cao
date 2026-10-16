---
title: Weekly rhythm
description: Understand the seven-day all-workflow-run comparison in Overview.
---

Weekly rhythm shows whether workflow activity is continuing through
the week without reducing recent activity to a single total.

## How to read it

The chart always shows Monday through Sunday. Reached weekdays represent
all workflow runs from the current week, regardless of status or conclusion.
Future weekdays use the matching count
from the previous week, so they do not appear as misleading zeroes.

Use the pattern to notice a change in cadence. It does not explain why activity
rose or fell, and it does not distinguish failures or measure output quality.

## Data it uses

`overview-rhythm` reads `started-at` from retained `runs`
across a 15-day window. Dashboard Language converts those records into seven
calendar-week points and counts every run, including failed, cancelled, skipped,
and in-flight runs with a recorded start time.

Malformed or unavailable rhythm data renders a stable seven-day empty state
instead of changing the component's shape.

## When to investigate

Open Runs when the current cadence differs unexpectedly from the previous week.
Check failures, queued work, and rollout mode before treating a quiet period as
an operational problem.