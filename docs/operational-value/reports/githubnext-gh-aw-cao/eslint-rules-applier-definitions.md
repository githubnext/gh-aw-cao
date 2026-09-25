---
title: What ESLint Factory / Applier measures
description: Definitions, evidence rules, and interpretation for the ESLint Factory / Applier operational-value report.
---

This page explains the chart in plain language. It defines what was measured; it does not decide whether the workflow caused the observed changes.

![ESLint Factory / Applier outcome measures after adoption](eslint-rules-applier-timeline.svg)

## How to read the chart

- Observations begin at workflow adoption on `2026-09-15`.
- No comparable pre-adoption evidence is available, so the chart shows attainment rather than improvement.
- Each dot is one immutable observation. Missing evidence is omitted, never treated as zero.
- Workflow runs show execution activity only. They do not prove repository value.

## What was measured

### Complete adoption

- **What it tells you:** Complete adoption share. This is a `primary` measure.
- **Normalized scoring formula:** `requests with warning-only rule, dedicated npm script, and separate non-gating CI job / eligible requests`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the normalized score directly.

### Warning-only rule share

- **What it tells you:** Warning-only rule share. This is a `diagnostic` measure.
- **Normalized scoring formula:** `requests with the selected rule configured at warning severity / eligible requests`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the normalized score directly.

### Dedicated script share

- **What it tells you:** Dedicated script share. This is a `diagnostic` measure.
- **Normalized scoring formula:** `requests with a dedicated ESLint Factory npm script / eligible requests`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the normalized score directly.

### Separate non-gating CI job share

- **What it tells you:** Separate non-gating CI job share. This is a `diagnostic` measure.
- **Normalized scoring formula:** `requests whose dedicated script runs in a separate non-gating CI job / eligible requests`
- **Goal:** Higher values are better.
- **Chart display:** The chart shows the normalized score directly.

## Evidence rules

- **Repository:** `githubnext/gh-aw-cao`
- **Evidence population:** A unique ESLint Factory adoption request for a target repository and rule key.
- **Collection:** Read one immutable campaign-memory archive and one immutable target-repository archive per cutoff, then inspect adoption-request transactions and repository state for the requested warning rule, dedicated npm script, and separate non-gating CI job.
- **Observation window:** 90 days, sampled every 7 days
- **Maturation delay:** 30 days
- **Filters:** `The request is an immutable adoption-request transaction written by the applier to campaign memory.`; `The transaction identifies a supported target repository, rule key, issue number, and recording time during the observation window.`; `Matured observations include only requests with thirty days to mature before the immutable repository cutoff.`; `Duplicate requests for the same target repository and rule key count once.`

The frozen definitions and formulas are applied to every post-adoption observation. The structured evidence, exact snapshots, provenance, and normalized scores are recorded in the adjacent `eslint-rules-applier-timeline.json` artifact.

## Important limitation

This report can show whether the intended outcome is attained after adoption. It cannot estimate change from pre-adoption conditions or attribute attainment to the workflow.

Value-function SHA-256: `e6d0ce1211b57309144efc2b561b0d8a073e4bf1cc8c84f90851a96e0840a888`
