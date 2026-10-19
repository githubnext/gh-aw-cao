---
title: Operational Value
description: Measure useful repository outcomes and workflow contributions separately with a frozen evidence contract.
---

Operational value is demonstrated useful improvement over time. Start from a
workflow, repository document or natural-language goal; freeze what counts as
improvement, then measure it repeatedly in native units.

**Credit demonstrated progress without weakening the original goal.** A named,
independently verified partial improvement can have value even when full goal
completion or a separate safeguard is unknown. Preserve the stricter acceptance
measure alongside it. A merge is not proof of a bug fix, and a smaller file is
not proof of behavior preservation.

Keep these answers separate:

| Answer | Evidence and boundary |
| --- | --- |
| Repository outcome | Accepted improvement regardless of actor. A person or another system achieving the same outcome counts under the same contract. |
| Workflow contribution | Useful change with a demonstrated workflow link, including downstream implementation and shared contribution. Not all repository movement belongs to the workflow. |
| Goal completion and safeguards | Evidence for the original stronger acceptance rule and independent quality conditions. Unknown checks remain unknown rather than cancelling a separately verified partial outcome. |
| Attribution confidence | Receipt-verified and corroborated linkage are separate provenance strata, not weights or a cap on useful outcomes. |
| Keep/change decision | An explicitly agreed native bar over complete comparable periods. Without one, the workflow is not rated. A review grants no authority to disable it. |

A repository may improve through other actors while a workflow contributes
nothing; it may also deteriorate despite useful workflow contributions. Neither
curve substitutes for the other. Adoption-relative movement is association, not
causation.

## Author once, measure deterministically

Use `/add-operational-value OWNER/REPO WORKFLOW`, supply an intent-bearing
document, or use `--goal "GOAL"`. Campaigns are optional; gh-aw is an intent
source, not a requirement of the measurement function.

The entire `.github/skills/add-operational-value/` directory is portable. Core
discovery, verification, evaluation and HTML reporting need Node.js 24+, not CAO,
a dashboard, or campaign registration. GitHub acquisition additionally needs
`git` and authenticated `gh`. Optional campaign discovery uses the skill's
locked YAML dependency: run `npm ci` in the copied skill directory.

Discovery supplies untrusted intent candidates, not accepted outcomes or an
automatically generated collector. Identify the effective executor, then freeze
eligibility, native formula/unit, direction, accepted evidence, cadence,
maturation, source interfaces and missing-data behavior. If authoring has
already seen results, label it outcome-informed retrospective; preserve prior
contracts and rejected predicates rather than claiming an ex-ante design.

Agentic tradeoffs happen once per explicit contract version. Subsequent
authorized acquisition, verification, collection, scoring, comparison, rendering
and replay use deterministic code without model calls. Material acceptance or
evidence-interface changes require a new version, not silent historical
rescoring. Pin helper dependencies as well as the module: a module-file digest
alone does not identify its transitive dependency closure.

The default definition is `.github/operational-value/NAME.mjs`. It exports
`definition`, `collectBatch` and `scoreMetric`; see the
[module contract](https://github.com/githubnext/gh-cao/blob/main/.github/skills/add-operational-value/references/module-contract.md)
for the schema, acceptance rules and optional review policy.

From the copied skill directory:

```sh
node scripts/discover-intent.mjs --root CHECKOUT
node scripts/discover-intent.mjs --root CHECKOUT --source PATH
node scripts/discover-intent.mjs --goal "GOAL"
node scripts/verify-value-function.mjs MODULE
node scripts/verify-value-function.mjs --collector MODULE
node scripts/evaluate.mjs --root CHECKOUT --end YYYY-MM-DDTHH:MM:SSZ OWNER/REPO NAME
```

Evaluation requires an existing reviewed module and usable evidence. Discovery
does not implement arbitrary remote workflow postconditions. A fixture-only
checker or all-unknown report is not finished measurement.

## Internals: author once, harvest deterministically

The module owns one frozen outcome contract, batch collector and native scoring
functions. Collectors reuse bounded canonical queries, persisted evidence and
immutable local repository facts across requested windows. Acquire missing
GitHub facts in a separately authorized bounded producer, not one API request
per historical or interactive window.

Prefer canonical CAO data when it contains authoritative facts and sufficient
retention. Query retention is a source limitation, not the operational-value
history window. Reconstruct older immutable repository facts when possible;
expired ephemeral evidence without a contemporaneous accepted snapshot is
missing, not zero.

`collect-output-history.mjs --until UTC OWNER/REPO ARCHIVE` provides shared
issue/PR lineage acquisition with digest-checked partitions and resumable
pagination. It is not an outcome evaluator, does not cover Discussions or
comments, and does not turn editable markers into creation receipts.

| Quantity | Calculation |
| --- | --- |
| Native outcome | The frozen scorer applies its own native formula to independently accepted facts. There is no universal normalization or weighted score. |
| Partial versus complete attainment | Separate named metrics preserve independently verified facets and the stronger original goal. Missing evidence for a facet prevents accepting that facet, not an unrelated demonstrated improvement. |
| Contribution | Deduplicate distinct useful changes, verify their workflow/downstream link, and count them in their accepted intervals. Shared authorship does not multiply the quantity. |
| Recent movement | Current minus reference for `increase`; reference minus current for `decrease`; reduction in distance from the declared target for `maintain` or `target`. Percentage movement is in percentage points. |
| Attention | `definition.signal`, otherwise the review metric, otherwise the actor-independent primary. Compare fresh, complete, mature adjacent periods; descriptive movement is not a causal or statistical claim. |
| Optional decision | `definition.review` checks its explicit native bar over consecutive complete periods with known nonzero opportunities. A repository-outcome bar reports goal attainment, not workflow keep/retire credit. |
| Cost | Not measured without matched workflow/version/period evidence. Unknown or zero accepted work cannot be a finite cost-per-outcome denominator. |

## Windows, missingness and temporal meaning

Collector windows are **start-inclusive, end-exclusive**. `durationDays` is the
evidence duration, `cadenceDays` the spacing, and `maturationDays` the assessment
delay. Interval schedules use disjoint cohorts, stepping by the larger of
duration and cadence. A leading adoption/activation period may be partial.
Snapshots measure state at a cutoff; their lookbacks may overlap, but the same
retained state is not a new delivery at every observation.

Preserve stable opportunity/delivery identities, explicit coverage, provenance,
period boundaries, maturity and the latest unavailable assessment. Missing is
`null`, not zero. A known empty opportunity population is different from an
unknown one. Partial native quantities may remain visible without satisfying
complete-period comparisons. Do not substitute an old success for the latest
missing, stale or provisional result.

Recent movement requires adjacent equal-duration comparable periods. Never
average ratios, sum overlapping rolling totals, or sum snapshot backlogs into
lifetime deliveries. Two observations show descriptive change, not a sustained
trend. Keep any supported adoption comparison separate; attainment-only designs
have no invented pre-adoption baseline.

The optional event pulse deduplicates stable event IDs. Later attribution
enriches the original delivery date rather than creating another delivery.
Its calendar-week totals and adjacent 28-day rates use only covered intervals;
the overlapping 91-day baseline is context, not an independent comparison.
Gaps remain unknown. Historical cumulative delivery is not current surviving
repository health or current workflow performance.

## File Diet since actual adoption

The motivating File Diet case distinguishes **48 demonstrated structural
reductions**, **13 receipt-backed reductions within that set**, and the stronger
claim of full behavior preservation. The 13 strengthen attribution provenance;
they do not cap the 48 demonstrated improvements. Full behavior preservation
remains unverified and must not be inferred from reduced file size.

Implement the distinction with an explicitly named structural metric/version,
retain the original full-acceptance metric, and report safeguard evidence and
attribution strata separately. Count each structural delivery once. A later
oversized-file backlog can worsen without erasing historical contributions;
historical contributions likewise do not establish that today's backlog is
healthy or that the workflow is currently delivering value.

## Local reports and optional CAO publication

Evaluation writes timeline JSON, a definitions/report page, self-contained HTML
pulse and matching JSON, and a version-keyed evidence archive under
`docs/operational-value/reports/OWNER-REPO/`. `--output-dir DIR` changes the
destination. These remain local until explicitly committed or published.
The archive preserves accepted observations for replay; dashboard/cache
retention is not durable outcome history.

`--runs` optionally adds diagnostic Actions context for workflow-adoption
reports. It does not affect outcome scoring. Prospective goal contracts instead
record contract activation; creating a measurement instrument today is not
evidence that the workflow or repository problem began today.

Optional `scripts/wire-workflow.mjs NAME --root CHECKOUT` creates the standard
`.github/operational-value.mjs` publication adapter. Explicit campaigns use
`CAMPAIGN/operational-value/NAME.mjs` and
`scripts/wire-campaign.mjs CAMPAIGN NAME`. Neither operation grants enrollment,
target authority, scheduling or deployment permission.

Scheduled `cao operational-value --root CHECKOUT` discovers standalone and
campaign adapters. Standalone records have workflow identity and namespaced
metric IDs, without fabricated campaign metadata. Collection still needs an
explicit repository or repository inventory from the selected canonical
database. Both adapters and local reports import the same frozen function.

Routine collection publishes only the current observation. Explicit historical
evaluation incrementally preserves reconstructable observations. Cadence
retention keeps closed observations fixed while replacing the current open
bucket. The Activity compute path can explicitly fill missing cadence
observations only while authoritative source evidence remains available.

The dashboard's **Operational Value** view starts with repositories and keeps
workflow, measure, native unit, direction and evaluator boundaries separate.
Run-scoped gh-aw operational-grader results are distinct evidence. No dashboard,
campaign, memory branch or publication integration is required for the portable
skill or its local reports.
