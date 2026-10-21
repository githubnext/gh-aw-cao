---
title: Operational Value
description: Measure whether an agentic workflow's intended repository outcome is attained using a frozen evidence contract.
---

Operational value is the degree to which a workflow's intended repository outcome is attained across eligible opportunities, demonstrated by accepted evidence under a fixed measurement contract.

It measures repository outcomes rather than workflow runs, generated output, or an agent's assessment. A person or another system achieving the same outcome must count as success under the same contract.

For the short intent → output → Git evidence flow, see
[Define and measure workflow value](operational-value-how-to.md).
Research and replay details are in the
[blog article](/gh-cao/blog/measuring-agent-work-value/).

Open **Value** in the sidebar (the trophy icon) to see evidence-backed workflow
result cards; a workflow's **Value** tab is also a shortcut to its reports.
The legacy **Operational Value** page and its **Repository measurements** tab
have been removed. Existing native observations remain in the canonical data
model; missing measurements are not zero value.
A result card appears when a validated report packet has been published.
For example, **↑ +38 files · Worse** means the
independently measured repository population increased by 38 since its displayed
first snapshot, against a **lower is better** goal. It is not an alert, a
pre-adoption baseline or a causal rating of the workflow. Select the card to
follow consolidated intent, retained safe outputs, distinct accepted changes and
their Git evidence; select a measured dot to inspect the exact counted items.
The card and native report share one canonical evidence packet, not a saved HTML
page. Opening either does not collect new evidence or silently fill missing
measurements. Each workflow still needs a frozen measurement contract and
published evidence; no packet produces an explicit unconfigured state.
These evidence routes keep their declared cohort and cutoff when the dashboard's
global display horizon changes; they are not new evaluations of that horizon.

## Publish a report once

After the skill has collected and validated fresh evidence, use
`gh cao value publish OWNER/REPO WORKFLOW --server URL --input REPORT-evidence.jsonl`.
This writes original facts through an administrator-authenticated API into the
hosted PostgreSQL canonical database. It does not upload HTML, execute evaluator
code or enable recurring collection. Exact retries are idempotent; conflicts
fail closed. Activity replacement preserves these publications and their
structural parents. The dashboard's active subscriptions see the new revision;
value-dependent query caches are revision-keyed so an old cached card cannot
hide the new evidence.

See [authentication and command details](cao-cli.md#publish-and-refresh-workflow-value).
Static dashboards receive the same envelope through Activity publication,
not a direct database connection.

## Recurring collection after opt-in

The skill designs the measurement once. **Once the frozen function and bounded
collector pass verification, the skill stages registration automatically for
that exact repository and workflow.** There is no separate enable step in the
normal skill flow. A report upload alone is not registration.
Unconfigured workflows are never discovered or evaluated automatically.

The skill uses `gh cao value enable ... --collector PATH --if-absent` to record
the selection under
`control-plane.campaigns.activity.workflow-values` in the control repository's
reviewed policy. The collector and policy must be committed and deployed
together; the repository must also be in the effective Activity collection scope.
`gh cao value disable ...` persists `enabled: false` without deleting
measurements. Automatic registration preserves existing selections and explicit
disables; use `value enable` without `--if-absent` to deliberately re-enable.
Without an enrolled control repository or a verified collector, a function file
alone does not start collection.

The repository-local ECMAScript collector exports its frozen `definition` and
`collectValueEvidence({repository, workflow, observedAt, database, previous, workspace})`.
It returns the original schema-v2 `operational_value_evidence` envelope.
It may acquire bounded, read-only evidence missing from the canonical database;
measurement uses the same fixed rules, never a new model-generated assessment.
Keep immutable measurements and receipts in the supplied per-workflow workspace
for reuse. Uploaded report packets cannot register or execute collector code.

The existing Activity cycle or hosted collector invokes only due, opted-in
collectors at the frozen cadence. It follows new safe-output lifecycle and
acceptance evidence, measures the independent repository state, and publishes
a validated capture into the same canonical facts consumed by **Value**.
Opening a report does not trigger collection. Fast/recycle-only runs do not
silently request fresh measurements. A failed acquisition, insufficient budget
or invalid packet leaves the previous evidence and capture timestamp intact;
it is not a fresh success or zero. Collection timing is bounded by the existing
cycle and available credentials, not a guarantee of an observation at every
wall-clock instant.

## Existing compact repository measurements

CAO uses one shared campaign module for both collection paths:

- By default, scheduled `cao operational-value` collection evaluates only the current repository observation and publishes compact numeric records to the canonical data model. Retention keeps one observation per declared cadence bucket: closed cadence-aligned observations remain fixed, while repeated collections replace the latest observation in the still-open bucket.
- Explicit historical evaluation incrementally fills missing immutable observations and produces the evidence archive, timeline, chart, and definitions page.

Both paths import the same frozen evidence contract, collector, and scoring functions. Default routine collection does not rebuild repository history, and a metric cannot drift between the dashboard record and its historical report.

Accepted operational-value observations are queryable from any local or downloaded canonical SQLite snapshot with `cao query --collection operationalValues`. Querying alone does not publish or reconstruct history. The Activity compute path may explicitly query missing cadence observations for a named campaign while their authoritative source evidence remains in its bounded canonical database; it writes only the resulting numeric observations into the same canonical Activity shard used for current values. No history archive is installed with the campaign. The Dashboard workflow then deploys those canonical records to Pages through the normal Activity snapshot pipeline.

The rolling Activity database is a query source for current observations, not the definition of operational-value history. Explicit evaluation schedules observations from adoption and incrementally preserves accepted snapshots. Git and other immutable repository facts can be reconstructed at historical cutoffs. Ephemeral run, usage, artifact, queue, and tool-call facts can be backfilled only while their source remains available; an expired interval without a contemporaneous snapshot is missing, not zero. The current live Activity publication retains 30 days of operational-value records compacted to each metric's declared cadence plus its latest open-bucket observation, while the explicit evidence archive is the durable since-adoption record.
