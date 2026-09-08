---
title: Dashboard Overview
description: Understand what the Central Agentic Ops dashboard Overview page shows and how its attention metrics are populated.
---

# Dashboard Overview

Overview is a quiet operational summary. It answers whether current data shows
work that needs attention without requiring an operator to inspect raw workflow
activity.

Overview is intentionally bounded to four linked metrics. Selecting a metric
opens a focused child page whose table links each retained record to its GitHub
run or review evidence.

| Metric | Population rule | Investigation view |
| --- | --- | --- |
| **Failed runs** | Counts canonical `runs` rows whose normalized conclusion is `failure`, `startup-failure`, `stale`, or `timed-out`. | Failed run evidence |
| **Blocked work** | Counts `work-items` rows whose lifecycle state is `blocked`. | Blocked work evidence |
| **Awaiting review** | Counts `work-items` rows whose lifecycle state is `review`. | Review evidence |
| **Security findings** | Counts all `security-findings` rows. | Security finding evidence |

The selected dashboard horizon filters source rows before Overview calculates these
counts. Its start timestamp is inclusive and its end timestamp is exclusive.

## How the sources are populated

The dashboard report builds the three Overview sources from the shared snapshot
published by [CAO Activity](activity.md). The
[Activity Specification](https://github.com/githubnext/gh-aw-cao/blob/main/specs/activity.md)
defines the snapshot and consumer obligations; this page defines how Overview
derives and presents its attention metrics.

### Runs

The `runs` source is built from `runHealth.runRecords` for workflows discovered
in the control repository. Each row preserves repository, workflow, run ID,
status, normalized conclusion, timestamps, rollout mode, engine and model
metadata, available failure details, and a link to the Actions run.

Run availability requires either an available deployed run-health snapshot or
at least one retained run. Completeness follows the run-health collection state.
Overview does not infer failed runs from outcome records or aggregate counters when
the canonical run rows are absent.

### Work items

The report creates one work item per discovered workflow, joined to its latest
canonical run and latest matching durable outcome. Identity is stable across
executions and is based on organization, repository, and workflow.

Lifecycle state is assigned deterministically:

| Condition | Lifecycle state |
| --- | --- |
| Admission denied or blocked, or run concluded with a failure, timeout, startup failure, or action required | `blocked` |
| Latest run is queued | `waiting` |
| Latest run is in progress | `active` |
| Latest outcome is pending | `review` |
| Latest run succeeded, was cancelled, skipped, neutral, or stale | `completed` |
| No usable run state exists | `unknown` |

The work-item source is available when workflow inventory exists. It is complete
only when workflow inventory exists and run collection is complete. Blocked and
review counts therefore remain unavailable or incomplete when those
prerequisites are not satisfied.

### Security findings

The report derives `security-findings` from security observations. The current
normalizer includes threat-detection summary observations whose status is
`detected`; each becomes a trust-and-security finding with high severity and a
link to its run when available.

Availability and completeness follow the security telemetry collection state.
An empty but incomplete security source does not prove that no findings exist.

## Quiet and incomplete states

Overview shows **Nothing needs your attention** only when all four classes were
evaluated from available, complete, and fresh data and their counts are
zero. The message names the evaluated classes and displays the exact UTC start
and end of the effective interval.

A missing source is displayed as an em dash, not zero. Partial, stale, unknown,
or unavailable data produces a qualified quiet state that identifies which
classes could not be fully evaluated. This describes the available data; it is
not a healthy-system verdict.

See [Dashboard data health](dashboard-data-health.md) for the availability,
completeness, freshness, coverage, and confidence contracts. Normative Overview
requirements are defined in `specs/dashboard.md` under **Home Command Surface**.