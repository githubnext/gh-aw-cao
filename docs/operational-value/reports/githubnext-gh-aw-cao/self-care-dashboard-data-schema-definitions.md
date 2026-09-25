---
title: What SelfCare / Dashboard Data Schema measures
description: Definitions, evidence rules, and interpretation for the SelfCare / Dashboard Data Schema operational-value report.
---

This page explains the chart in plain language. It defines what was measured; it does not decide whether the workflow caused the observed changes.

![SelfCare / Dashboard Data Schema outcome measures after adoption](self-care-dashboard-data-schema-timeline.svg)

## How to read the chart

- Observations begin at workflow adoption on `2026-09-08`.
- No comparable pre-adoption evidence is available, so the chart shows attainment rather than improvement.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Workflow runs show execution activity only. They do not prove repository value.

## What was measured

### Matching sources

- **What it tells you:** Matching source share. This is a `primary` measure.
- **Normalized scoring formula:** `advertised source sections exactly matching inferred pseudo schemas / advertised sources`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the normalized score directly.

### Document synchronized

- **What it tells you:** Whole document synchronized. This is a `diagnostic` measure.
- **Normalized scoring formula:** `1 when the checked-in specification exactly equals the generated pseudo-schema document; otherwise 0`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the normalized score directly.

## Evidence rules

- **Repository:** `githubnext/gh-aw-cao`
- **Evidence population:** Each valid JSON source advertised by the deployed dashboard data manifest during a daily observation.
- **Collection:** Fetch one complete deployed Pages snapshot, infer its bounded pseudo schemas, and compare every generated source section with specs/dashboard-data.md at the immutable cutoff commit.
- **Observation window:** 1 days, sampled every 1 days
- **Maturation delay:** 0 days
- **Filters:** `The manifest must advertise at most 500 unique source names matching the workflow's source-name allowlist.`; `The manifest and every advertised source must be available and valid JSON.`; `Schema inference samples at most 50 rows, six nested levels, and twelve displayed object properties.`; `The checked-in specification is read from the last immutable repository commit at or before the observation cutoff.`

The frozen definitions and formulas are applied to every post-adoption observation. The structured evidence, exact snapshots, provenance, and normalized scores are recorded in the adjacent `self-care-dashboard-data-schema-timeline.json` artifact.

## Important limitation

This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow.

Value-function SHA-256: `53c3cdb5d35836dbec79b55d2f0ffeed566d1cfef7ebf833bfb0ea142aaa3179`
