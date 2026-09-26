---
title: Operational Value
description: Measure whether an agentic workflow's intended repository outcome is attained using a frozen evidence contract.
---

Operational value is the degree to which a workflow's intended repository outcome is attained across eligible opportunities, demonstrated by accepted evidence under a fixed measurement contract.

It measures repository outcomes rather than workflow runs, generated output, or an agent's assessment. A person or another system achieving the same outcome must count as success under the same contract.

CAO uses one shared campaign module for both collection paths:

- By default, scheduled `cao operational-value` collection evaluates only the current repository observation and publishes compact numeric records to the canonical data model.
- Explicit historical evaluation incrementally fills missing immutable observations and produces the evidence archive, timeline, chart, and definitions page.

Both paths import the same frozen evidence contract, collector, and scoring functions. Default routine collection does not rebuild repository history, and a metric cannot drift between the dashboard record and its historical report.

Accepted operational-value observations are queryable from any local or downloaded canonical SQLite snapshot with `cao query --collection operationalValues`. Querying alone does not publish or reconstruct history. The Activity compute path may explicitly query missing cadence observations for a named campaign while their authoritative source evidence remains in its bounded canonical database; it writes only the resulting numeric observations into the same canonical Activity shard used for current values. No history archive is installed with the campaign. The Dashboard workflow then deploys those canonical records to Pages through the normal Activity snapshot pipeline.

The rolling Activity database is a query source for current observations, not the definition of operational-value history. Explicit evaluation schedules observations from adoption and incrementally preserves accepted snapshots. Git and other immutable repository facts can be reconstructed at historical cutoffs. Ephemeral run, usage, artifact, queue, and tool-call facts can be backfilled only while their source remains available; an expired interval without a contemporaneous snapshot is missing, not zero. The current live Activity publication retains 30 days of operational-value records, while the explicit evidence archive is the durable since-adoption record.
