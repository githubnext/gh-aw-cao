---
title: What Daily File Diet measures
description: Definitions, evidence rules, and interpretation for the Daily File Diet operational-value report.
---

# What Daily File Diet measures

This page explains the chart in plain language. It defines what was measured; it does not decide whether the workflow caused the observed changes.

![Daily File Diet outcome measures before and after adoption](daily-file-diet-timeline.svg)

## How to read the chart

- The purple dotted line marks workflow adoption on `2025-11-15`.
- The left side is pre-adoption evidence; the right side is post-adoption evidence.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Workflow runs show execution activity only. They do not prove repository value.

## What was measured

### Largest-file health

- **What it tells you:** Largest-file health. This is a `primary` measure.
- **Normalized scoring formula:** `min(1, 999 / largestFileLines) when at least one eligible file exists`
- **Goal:** Lower values are better.
- **Chart display:** The chart shows `1 - normalized score` so improvement follows the workflow goal downward.

### Compliant line-mass share

- **What it tells you:** Compliant line-mass share. This is a `diagnostic` measure.
- **Normalized scoring formula:** `compliantLines / totalLines when at least one eligible file and positive line mass exist`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the normalized score directly.

## Evidence rules

- **Repository:** `github/gh-aw`
- **Evidence population:** A weekly immutable snapshot containing at least one non-test Go source file under pkg/.
- **Collection:** Resolve all requested cutoffs from batched main-branch commit history, fetch each selected immutable commit archive once, and derive line counts locally. An empty eligible population is missing; when eligible files exist, zero compliant line mass is a valid zero.
- **Observation window:** 7 days, sampled every 7 days
- **Maturation delay:** 0 days
- **Filters:** `Include pkg/**/*.go.`; `Exclude files whose names end in _test.go.`; `Use the last commit on main at or before windowEnd.`; `A file is compliant when its physical line count is at most 999.`

The same definitions and formulas are applied before and after adoption. The structured evidence, exact snapshots, provenance, and normalized scores are available in the [timeline JSON](https://github.com/githubnext/gh-aw-cao/blob/main/docs/operational-value/reports/github-gh-aw/daily-file-diet-timeline.json).

## Important limitation

A before/after pattern is an association, not proof of causation. Other repository changes may explain some or all of the movement.

Value-function SHA-256: `211bc976ef53c94ce74bcf682a36566056b7f606414ba1aa96077a56f107ea10`
