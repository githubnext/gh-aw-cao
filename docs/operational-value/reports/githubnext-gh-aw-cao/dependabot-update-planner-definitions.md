---
title: What Dependabot / Update Planner measures
description: Definitions, evidence rules, and interpretation for the Dependabot / Update Planner operational-value report.
---

This page explains the operational-value timeline in plain language. It defines what was measured; it does not decide whether the workflow caused the observed changes.

## How to read the timeline

- The purple dotted line marks workflow adoption on `2026-09-17`.
- The left side is pre-adoption evidence; the right side is post-adoption evidence.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Workflow runs show execution activity only. They do not prove repository value.

## What was measured

### Open security alerts

- **What it tells you:** Open security alerts. This is a `primary` measure.
- **Native measurement formula:** `Dependabot security alerts open at the cutoff`
- **Unit:** `alerts`
- **Goal:** Lower values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Open critical/high alerts

- **What it tells you:** Open critical/high security alerts. This is a `diagnostic` measure.
- **Native measurement formula:** `Dependabot security alerts with critical or high severity open at the cutoff`
- **Unit:** `alerts`
- **Goal:** Lower values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

### Open Dependabot pull requests

- **What it tells you:** Open Dependabot pull requests. This is a `diagnostic` measure.
- **Native measurement formula:** `Dependabot-authored dependency pull requests open at the cutoff`
- **Unit:** `pull-requests`
- **Goal:** Lower values are better.
- **Chart display:** The chart shows the native value directly on a metric-specific axis.

## Evidence rules

- **Repository:** `githubnext/gh-aw-cao`
- **Evidence population:** A Dependabot security alert in an authorized target repository that was open at the immutable observation cutoff.
- **Collection:** Fetch Dependabot alert lifecycle records and Dependabot-authored pull-request lifecycle records once per supported repository, then reconstruct every requested cutoff locally from their authoritative timestamps.
- **Observation window:** 7 days, sampled every 7 days
- **Maturation delay:** 0 days
- **Filters:** `Count alerts created no later than the cutoff and not fixed, dismissed, or auto-dismissed by that cutoff.`; `Count critical and high alerts separately without severity weighting.`; `Count Dependabot-authored pull requests created no later than the cutoff and not closed by that cutoff as a separate queue diagnostic.`; `Fail the observation closed when complete alert or pull-request lifecycle evidence is unavailable.`

The same definitions and formulas are applied before and after adoption. The structured evidence, exact snapshots, provenance, units, and native values are recorded in the adjacent `dependabot-update-planner-timeline.json` artifact.

## Important limitation

A before/after pattern is an association, not proof of causation. Other repository changes may explain some or all of the movement.

Value-function SHA-256: `78540498a35c483cea4a7727ca961c3b2e0e94ca2c9604ff4b648064ad87ea34`
