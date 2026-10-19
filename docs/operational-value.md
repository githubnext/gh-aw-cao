---
title: Operational Value
description: Turn stated goals or discovered workflow intent into deterministic repository-outcome measurements over time.
---

Operational value is demonstrated useful improvement over time. Start from
a workflow, a repository document or a natural-language goal; freeze what counts
as improvement, then measure it repeatedly in native units. Count repository
attainment and workflow-enabled contributions separately. A detector can earn
shared contribution credit when another agent or person implements its finding.

**Credit demonstrated progress; report full goal completion, safeguards and
attribution confidence separately.** Partial improvement can have value without
satisfying every acceptance criterion. Missing quality evidence or expired
creation receipts do not turn a measured improvement into zero. They qualify
what is established and how confidently it is linked to the workflow.
Do not weaken verification intrinsic to an outcome: a merge alone is not a
confirmed bug fix, and a smaller file alone is not behavior preservation.

The report answers: **What was delivered per period, what is linked to this
workflow, and does that meet an agreed keep bar?** It does not replace those
answers with a universal score or assume that repository improvement was caused
by the workflow.

The [goal-to-measurement paper](operational-value/goal-to-measurement-paper.md)
provides background, methodology, a worked calculation, and measured results
from a reproducible local reference benchmark. Its synthetic evidence tests
runtime behavior, not automatic goal-interpretation accuracy or live impact.
The [complete github/gh-aw census](operational-value/gh-aw-census.md) extends
the analysis to 385 source workflows and records real-evidence limitations
separately from missing outcome definitions and unimplemented collectors.

It measures repository outcomes rather than workflow runs, generated output, or an agent's assessment. A person or another system achieving the same outcome must count as success under the same contract.

The dashboard's **Operational Value** view starts with repositories. Select a repository to see its retained outcome measurements across campaigns and standalone workflows; campaign registration is not required. Each repository appears once in the overview, while workflow, measure, native unit, direction, and evaluator boundaries remain separate in history and comparisons. **Evidence** lists repository coverage and the latest native values. Missing measurements are not zero value. Native run-scoped gh-aw operational-grader results are separate evidence and are not included in this repository-outcome view.

Use `/add-operational-value OWNER/REPO --goal "GOAL"`, point to an intent-bearing
document, or select a workflow. gh-aw is one source adapter, not a requirement
of the measurement function. For example, "resolve confirmed bugs without
regressions" can become the fraction of eligible confirmed defects resolved with
passing regression checks; opened PRs alone are not evidence of resolution.
The acceptance rule must come from the actual intent and available evidence,
not an invented generic score.

The skill discovers local workflow and intent documents with a bounded read,
or accepts prose directly. It freezes one repository outcome, native formula,
population and accepted-evidence rule. Creation requires neither campaign
enrollment, compiled workflow history, full historical evaluation nor deployment.
Historical comparison is an optional capability. Prospective goals start at
measurement-contract activation with no historical reference claim; that date
is not workflow adoption. Workflow-adoption comparisons instead recover
adoption-time intent and comparable pre-adoption evidence.

The entire `.github/skills/add-operational-value/` directory is portable. Core
discovery, verification, collection, evaluation and HTML reporting require only
Node.js 24+, not this repository, its dashboard, CAO or campaign registration.
GitHub acquisition additionally uses `git` and authenticated `gh`; optional
campaign-manifest discovery uses the skill's own locked YAML dependency
(`npm ci` in the skill directory). Commands default to the target working
directory, with `--root` overriding it. Agentic authoring chooses the outcome,
contract and evidence plan once per version; normal new observations then
collect, score and render deterministically without model calls. Material goal,
acceptance or evidence-interface changes require explicit versioned revision,
not silent historical rescoring.

The default definition is `.github/operational-value/NAME.mjs`, with an optional
standard `.github/operational-value.mjs` adapter shared by workflow definitions.
An explicit `--campaign SLUG` instead uses
`SLUG/operational-value/NAME.mjs` and the existing campaign adapter.
Existing package-local definitions remain usable; evaluation also accepts an
explicit `--function PATH`. Definitions are reviewed source code, not agent
memory. The importable function and its local report work without an adapter;
CAO publication is optional.

Both collection paths use the same workflow module:

- By default, scheduled `cao operational-value` collection evaluates only the current repository observation and publishes compact numeric records to the canonical data model. Retention keeps one observation per declared cadence bucket: closed cadence-aligned observations remain fixed, while repeated collections replace the latest observation in the still-open bucket.
- Explicit historical evaluation incrementally fills missing immutable observations and produces the evidence archive, timeline, chart, and definitions page.

Both paths import the same frozen evidence contract, collector, and scoring functions. Default routine collection does not rebuild repository history, and a metric cannot drift between the dashboard record and its historical report.

Accepted operational-value observations are queryable from any local or downloaded canonical SQLite snapshot with `cao query --collection operationalValues`. Querying alone does not publish or reconstruct history. The Activity compute path may explicitly query missing cadence observations for a named campaign while their authoritative source evidence remains in its bounded canonical database; it writes only the resulting numeric observations into the same canonical Activity shard used for current values. No history archive is installed with the campaign. The Dashboard workflow then deploys those canonical records to Pages through the normal Activity snapshot pipeline.

`cao operational-value --root CHECKOUT` discovers the workflow-local adapter as
well as campaign adapters. Standalone observations have workflow identity and
namespaced metric IDs but no campaign metadata; the internal `.github` discovery
partition does not create a campaign. A checkout may contain both kinds.
Collection still requires an explicit repository or repositories present in the
selected canonical database; discovering a function grants no target authority.

For local historical evaluation, run the skill's `scripts/evaluate.mjs` with
`--root CHECKOUT --end YYYY-MM-DDTHH:MM:SSZ OWNER/REPO NAME`.
It writes timeline JSON, a Markdown definitions/report page, a self-contained
interactive HTML pulse with matching computed JSON, and a version-keyed
evidence archive under `docs/operational-value/reports/OWNER-REPO/`. Use
`--output-dir DIR` for another destination, such as a checked-out memory branch.
These are local files until explicitly committed or published. The report works
without CAO or a dashboard; publication into Activity is a separate action.
Evaluation performs no run-context API calls by default. Explicit `--runs` adds
diagnostic execution context only for workflow-adoption reports.

## Internals: author once, harvest deterministically

The intended on-demand experience is: **give the skill a repository and workflow,
generate its measurement function once, then request fresh reports from that
function whenever needed**. The agentic tradeoff is deciding what useful work
means and how to verify it, not judging every new result. Once reviewed, that
decision becomes executable, versioned code. Routine harvesting, verification,
scoring, comparison, rendering and replay must not call a model.

### What is agentic, and what is deterministic?

| Stage | Responsibility | Current interface |
|---|---|---|
| Discover intent | Deterministic source listing/reading supplies untrusted workflow, document or prose candidates; it does not decide whether work is good. | `discover-intent.mjs`; `list-repository-workflows.mjs` for remote gh-aw Markdown workflows |
| Generate the function | **Agentic, once per contract version:** interpret the goal and effective executor, choose eligibility, independent acceptance, native formula, evidence requirements, cadence, deduplication, safeguards and any agreed review bar. Implement and test those choices. | Reviewed module exporting `definition`, `collectBatch`, `scoreMetric` |
| Harvest originals | Deterministic, separately authorized acquisition preserves bounded source facts, immutable identities, timestamps, hashes and failure receipts. Workflow-specific evidence producers are still needed. | For example, `collect-output-history.mjs` for shared issue/PR discovery; module-specific native acquisition |
| Verify and collect | Deterministic custody/oracle checks turn originals into window-scoped evidence. Unknown defining facts remain unknown; collector defects are errors. | `collectBatch(requests, context)` returns evidence and provenance per request |
| Calculate and compare | Deterministic native scoring, period quality, adjacent comparisons and optional policy verdict. No narrative assessment or model-generated score. | `scoreMetric`, `build-timeline.mjs`, `review-value.mjs` |
| Render and replay | Deterministic presentation and verification of the same facts and contract. | `render-definitions.mjs`, `render-pulse.mjs`, `validate-report-artifacts.mjs` |

The agent must freeze the contract before inspecting outcomes. If candidate
descriptions or results have already been read, label subsequent authoring
**outcome-informed retrospective assessment**, preserve the earlier contract and
rejections, and do not claim blind or ex-ante acceptance. A material change to
the goal, eligibility/acceptance or evidence interface starts an explicit new
version; it is not permission to silently reinterpret old observations.
Ordinary new evidence runs the existing function, not another agentic review.

The three exports are the boundary, not a second reporting API:

- `definition` declares schema version 3, source/activation identity, population,
  measurement kind, windows, metrics and optional signal/review policy.
- `collectBatch([{ windowStart, windowEnd, observedAt }], context)` shares reads
  across requested windows and returns equally many `{ evidence, provenance,
  commit? }` objects. `observedAt` is the assessment time, not the delivery time.
- `scoreMetric(metricId, evidence)` returns a finite number in the declared
  native unit, or `null`. The generic evaluator never infers acceptance from a
  PR, merge, tracking marker or successful run.

Contract generation includes real positive, negative, missing and malformed
cases. `verify-value-function.mjs` checks the interface and examples;
`--collector` also exercises a real collection request. Neither test alone
establishes measured production value. Independent native evidence must actually
be evaluated. The generic runner imports reviewed JavaScript modules; it is not
a sandbox or an automatic guarantee that arbitrary custom code is offline or
model-free.

### How each reported quantity is calculated

| Quantity | Calculation and boundary |
|---|---|
| Eligible opportunities | The collector applies the frozen scope, source era, exclusions and distinct opportunity identity to original facts in the selected window. Emit the known `eligibleCount`, population identity and coverage; an undiscovered population is not an empty one. |
| Repository outcome | The scorer applies the declared native formula to independently accepted facts, regardless of actor. This may be a count, magnitude, fraction or retained state; there is no universal formula or normalization. A defect fraction, for example, divides accepted eligible defects by the known eligible population, using the contract's explicit zero-population rule. |
| Workflow-linked delivered contribution | First verify the useful change, then establish its link to the workflow and downstream implementation. Count each distinct delivery in its accepted interval, including shared work by later agents or people. Never credit all repository movement to one workflow. |
| Native partial and full acceptance | Score a named, independently verified partial facet separately from the stronger full-goal metric. A known partial may remain numeric while full semantics, regression safeguards or attribution are `null`. Missing the evidence defining the partial itself prevents acceptance. |
| Attribution and safeguards | Preserve evidence-backed strata or separate metrics/limitations, not invented confidence weights. A receipt-verified subset refines corroborated contribution; it does not erase weaker but established outcomes or multiply the delivered quantity. |
| Recent movement | For comparable values, native delta is current minus reference. Direction-aware gain is current minus reference for `increase`, reference minus current for `decrease`, and the reduction in absolute distance from the declared target for `maintain`/`target`. Percentages move in percentage points. This is descriptive movement, not causal impact or statistical significance. |
| Attention signal | Focus on `definition.signal`, otherwise the review metric, otherwise the primary repository metric. `timelinePulse` compares the latest fresh, complete, mature period with its adjacent comparable predecessor. Positive/negative/zero gain gives improving/worsening/steady. Contribution-specific no-opportunity/stalled states additionally require known opportunity evidence. Gaps do not become a trend. |
| Optional verdict | `reviewValue` checks the declared native minimum/maximum over the requested consecutive complete, mature, fresh periods with known positive opportunities. All meet: keep candidate; all miss: change/retire candidate; some meet: mixed. These workflow verdicts require interval contribution evidence; a repository-outcome policy instead reports goal met/missed. No policy means not rated. |
| Cost | Current generic reviews explicitly report not measured. Future cost per accepted outcome requires matched workflow/version/period cost and a positive known accepted quantity. Missing or zero work cannot yield a finite cost-per-outcome. |

These are separate answers, not components of an aggregate score. Incompatible
native units, versions, populations or safeguards must not be summed. A
repository-level improvement with unknown workflow linkage is still an outcome,
not demonstrated workflow contribution.

### Windows, deduplication and missingness

All collector windows are **start-inclusive, end-exclusive**. `durationDays`
defines the evidence window, `cadenceDays` the observation spacing, and
`maturationDays` the delay before it can be assessed. `observationWindows` in
`common.mjs` schedules interval windows backward from the requested endpoint,
subtracting maturation from each window end and stepping by the larger of
duration and cadence. This prevents overlapping delivered-work cohorts; a
larger cadence can leave explicit gaps. The first interval may be shortened at
the adoption/activation boundary. Snapshot schedules describe retained state
at observation times and may have overlapping lookbacks.

The module must deduplicate native opportunities and deliveries using stable
domain identities. The generic runner does not know whether two GitHub objects
represent the same repaired defect. Report-level deduplication is different:
the evaluator caches observations by assessment time plus window start/end,
and the value review selects the latest assessment for each identical window.
Neither mechanism makes overlapping snapshots additive. A retained fix is not
fresh work every week. The optional event projection deduplicates stable event
IDs, rejects conflicting time/value facts, and lets later attribution evidence
update the original delivery rather than create another event.

For a standard timeline, period quality requires the declared full duration,
explicit complete coverage, sufficient maturation and no future, provisional
or dubious assessment. Partial native values remain visible, but they do not
satisfy complete-period trend or keep-bar requirements. Freshness is evaluated
relative to the report endpoint and declared cadence, not today's wall clock.
The latest missing value stays missing; the renderer does not substitute an
older success.

The event projection is a separate, explicit input supported by the same pulse
renderer: calendar-week totals sum distinct native events only over covered
intervals. Its 28-day rate is the covered native total multiplied by `7 / 28`;
the 91-day baseline uses `7 / 91`. Its signal compares adjacent, non-overlapping
28-day windows, not the 91-day baseline. Coverage gaps and cold starts produce
`null`. These are event rates, not formulas imposed on every workflow.

### Current commands and the on-demand boundary

The slash skill can guide authoring for `OWNER/REPO WORKFLOW`, a document or
prose. **The CLI does not yet turn any arbitrary remote workflow into a complete
native harvester and report in one command.** Remote listing only clones a
temporary checkout and lists/selects gh-aw Markdown sources. Source reading is
not goal interpretation, and discovery inventory is not outcome evidence.
`evaluate.mjs` requires an existing reviewed module and the evidence its
collector needs; it fails if the module is absent. Missing evidence adapters
still require authoring rather than generic success-shaped fallback.

From a target checkout, with the portable skill copied there:

```sh
# Deterministic discovery: select intent, do not score it.
node .github/skills/add-operational-value/scripts/discover-intent.mjs \
  --root . --source .github/workflows/WORKFLOW.md
node .github/skills/add-operational-value/scripts/list-repository-workflows.mjs \
  OWNER/REPO WORKFLOW

# Agentic authoring happens here, once per version:
# implement .github/operational-value/WORKFLOW.mjs and its native evidence plan.

# Deterministic validation and repeatable reporting after authorized harvesting.
node .github/skills/add-operational-value/scripts/verify-value-function.mjs \
  .github/operational-value/WORKFLOW.mjs
node .github/skills/add-operational-value/scripts/verify-value-function.mjs \
  --collector .github/operational-value/WORKFLOW.mjs
node .github/skills/add-operational-value/scripts/evaluate.mjs \
  --root . --end YYYY-MM-DDTHH:MM:SSZ OWNER/REPO WORKFLOW
```

For prose, replace `--source PATH` with `--goal "GOAL"` in discovery. Evaluation
also accepts `--function PATH` and `--output-dir DIR`. Harvesting new originals
uses the chosen evidence producer; evaluation does not automatically acquire
every native postcondition. Routine runs reuse retained observations for the
matching requests and collect missing ones; `--refresh` explicitly recollects
the scheduled requests. It does not ask a model to rescore them. Replay fixes
the endpoint and verifies the same inputs, contract, helpers and runtime.

Outputs under `docs/operational-value/reports/OWNER-REPO/` are
`WORKFLOW-timeline.json` (definition, function hash, evidence, provenance, native
values and comparisons), `WORKFLOW-definitions.md` (definitions and review),
`WORKFLOW-pulse.html` and `.json` (the same plotted facts), and the
version-keyed `WORKFLOW-evidence-archive.json` or compressed/partitioned form.
The archive retains observations with at least one known metric; the timeline
also preserves all-unknown windows. Acquisition originals and failures live in
the producer's separately defined custody store, not automatically in that
archive. The evaluator keys archived versions by the module file's SHA-256;
that is **not** an automatic transitive dependency hash. Pin helper/oracle/input
identities explicitly so changing an imported implementation cannot silently
change a supposedly unchanged measurement.

Reports are local files until separately authorized publication. Generating a
function or invoking evaluation installs no scheduler, enrolls no campaign,
starts no continuous monitoring and deploys nothing. This repeatable pipeline
is the current building block for the desired on-demand repository/workflow
experience, not a claim that unattended generic function generation and native
acquisition are already implemented.

## A concise value review

Evaluation now writes a `valueReview` into the existing timeline and renders it
at the top of the Markdown report. It shows native values for each period,
eligible opportunities, missing/provisional evidence, recent comparable change,
the review policy and its decision. The latest twelve periods are displayed;
the full series remains in the timeline. There is no separate decision database
or new CAO enrollment.

### Plots and an attention signal for any workflow

Every standalone evaluation now also writes `NAME-pulse.html` and
`NAME-pulse.json`, without CAO enrollment or a web server. Open the HTML locally;
the JSON exposes the focused `signal.status` and `signal.attention`, plus each metric's native values,
comparison windows and reason for deterministic monitoring. These are saved
reports, not a background monitor: schedule evaluation separately if authorized.

The default focus is the reviewed metric, otherwise the actor-independent
primary. To focus on demonstrated workflow delivery without inventing a keep
threshold, set the optional module metadata:

```js
signal: { metricId: "linked-improvements", basis: "workflow-contribution" }
```

The metric must already exist as a diagnostic contribution measure. Each measure
remains separate; no weighted overall score merges different units or unknown
safeguards. The focused measure supplies the headline signal.

| Signal | Meaning | Attention |
|---|---|---|
| Improving / steady | Better / equal native results in comparable complete periods | Not indicated by trend alone |
| Worsening | Worse in the declared native direction | Review |
| Stalled | No contribution in either period despite known opportunities | Review |
| No opportunity | Complete evidence establishes no eligible work | Not indicated |
| Insufficient evidence | Missing, stale, provisional or noncomparable periods | Evidence needed |

Unknown opportunities with no observed delivery also request evidence, not
retirement. A missed agreed review bar requests inspection even when movement
is steady. These labels are descriptive, not statistical significance, exclusive
causal attribution or authority to disable a workflow. A repository-outcome
signal must not be read as that workflow's performance.

Snapshot and interval plots use the frozen contract's cadence and window.
Snapshots and overlapping windows are never added into lifetime work. If the
producer can preserve **deduplicated, independently measured delivery events**,
the same generic renderer accepts an event projection and adds calendar-week
bars, a trailing-28-day rate, a 91-day baseline, cumulative steps, attribution
strata and keyboard/click-through event evidence. Its trend compares the latest
28 days against the preceding, non-overlapping 28 days. Gaps and cold starts
stay unknown, negative effects survive, and later attribution evidence upgrades
the original delivery rather than inventing new work.
See the [module contract](https://github.com/githubnext/gh-aw-cao/blob/main/.github/skills/add-operational-value/references/module-contract.md#portable-plots-and-attention)
for the portable event projection; it is not another scoring interface.

Regenerate a plot from any existing standard timeline:

```sh
node .github/skills/add-operational-value/scripts/render-pulse.mjs \
  PATH/NAME-timeline.json PATH/NAME-pulse.html
```

The real File Diet lifetime example uses the same generic renderer, with only
its evidence-to-event adapter specialized:

```sh
node scripts/build-file-diet-value-events.mjs \
  docs/operational-value/proof/file-diet-lifetime \
  docs/operational-value/proof/reports/file-diet-value-events.json
node .github/skills/add-operational-value/scripts/render-pulse.mjs \
  docs/operational-value/proof/reports/file-diet-value-events.json \
  docs/operational-value/proof/reports/file-diet-pulse.html
```

As of October 18, 2026, that plot preserves **48 observed structural reductions**,
including **13 receipt-backed** contributions. Current 28-day delivery is
**0 files/week**, versus **1 file/week** over 91 days; the adjacent-window signal
is **worsening / review**. The last positive linked merge was August 25,
approximately 54 days earlier, while 53 oversized files remain.
This is a signal to inspect the workflow's downstream delivery, not to erase
its previous value or claim it caused repository growth. Coverage is the
surviving discovered issue cohort and explicit merge links; deleted outputs,
full behavior preservation and financial return are not established.

For example, the synthetic delivery test uses two distinct weekly cohorts of
five eligible defects each:

| Period | Repository defects accepted | Repository attainment | Accepted workflow-linked defects |
|---|---:|---:|---:|
| First week | 2 | 40% | 1 |
| Second week | 4 | 80% | 2 |

Each accepted defect is closed as completed, linked to a merged fix and backed
by the required regression checks. Linking follows acceptance, not the reverse.
Other actors' accepted fixes count toward the repository's 40% and 80%, but not
toward the workflow's one and two contributions. The recent repository movement
is **+40 percentage points**, not “40% workflow value.”
These are non-overlapping interval measurements, not repeated credit for a
previously accepted fix that remains closed. Snapshot measurements still
describe health and attainment, but cannot alone establish new workflow delivery.

Suppose the owner agreed **at least one accepted workflow contribution per
eligible weekly period for two consecutive complete periods**. This illustrative
bar yields **keep candidate**. Zero accepted contributions in both periods,
with known positive opportunities and complete mature evidence, yields
**change/retire candidate**. Meeting it in just one period yields **mixed**.
Missing evidence or no opportunities yields **insufficient evidence**, not a
retirement recommendation.

Set the optional native bounds, number of periods, basis and rationale in
`definition.review`; see the skill's
[module contract](https://github.com/githubnext/gh-aw-cao/blob/main/.github/skills/add-operational-value/references/module-contract.md#optional-keepchange-review).
No bar is assumed: without one the decision is **not rated**, while observed
values are still reported. A bar applied only to repository attainment can
report **goal met/missed**, not credit or retire a particular workflow.
Recommendations never authorize disabling a workflow or changing CAO policy.

Costs are explicitly **not measured** in this review. Native accepted quantities
and exact workflow/evaluator/period identities allow future cost matching, but
neither monetary return nor cost per accepted outcome is inferred today.
Unknown costs are not zero, and zero or unknown accepted work must not produce
a finite cost-per-outcome. Keep candidates are outcome-based advice, not a
financial break-even claim.

The rolling Activity database is a query source for current observations, not the definition of operational-value history. Explicit evaluation schedules observations from adoption and incrementally preserves accepted snapshots. Git and other immutable repository facts can be reconstructed at historical cutoffs. Ephemeral run, usage, artifact, queue, and tool-call facts can be backfilled only while their source remains available; an expired interval without a contemporaneous snapshot is missing, not zero. The current live Activity publication retains 30 days of operational-value records compacted to each metric's declared cadence plus its latest open-bucket observation, while the explicit evidence archive is the durable since-adoption record.

## Tracking work through the GitHub graph

For a repository-wide batch, first share one bounded acquisition rather than
searching for every workflow or making API requests per historical window:

```sh
node .github/skills/add-operational-value/scripts/collect-output-history.mjs \
  --until 2026-10-18T15:00:12Z --alias githubnext/gh-aw \
  --request-budget 2000 github/gh-aw PATH/OUTPUT-HISTORY
```

This pins all installed Markdown/lock pairs at the cutoff revision and exhausts
the issue and PR GraphQL cursor connections. It avoids Search's 1,000-result
cap and REST's large-dataset page-number ceiling. Imported objects are not
assumed to be in exact creation order; an object after the cutoff does not end
the traversal. Interrupted acquisition preserves incomplete, digest-checked
partitions; add `--resume` with the same repository, cutoff and aliases.
Aliases must resolve to the same numeric repository identity. The archive reader
verifies identities, scope, partitions and totals before offline replay.

The result is a surviving-output discovery inventory, **not value history**.
It preserves normalized facts, candidate links and body digests, not raw bodies,
prompts or usernames. Current state is not reconstructed historical state;
deleted/transferred outputs, removed markers, comments and Discussions are not
covered. A full inventory still needs workflow-specific goal checks before
producing native value events. Missing instrumentation must be shown explicitly,
not rendered as zero delivery or a worsening signal.

For workflows that publish Discussions, collect a separate bounded inventory
without repeating the issue/PR crawl:

```sh
node scripts/collect-workflow-discussions.mjs --until 2026-10-18T15:00:12Z \
  --request-budget 200 github/gh-aw PATH/DISCUSSION-HISTORY
```

This repository helper preserves exact acquired JSON response bodies, hashes,
queries and acquisition times in size-bounded compressed pages. It verifies
repository identity, cursor advancement, unique identities and cutoff counts;
`--resume` validates completed pages before continuing. The request budget
includes the repository-identity request. These are **surviving bodies observed
now**, not original historical revisions, comment inventories, accepted outcomes
or authoritative creation receipts. Keep the acquisition archive private until
selecting the bounded public evidence needed by a reviewed instrument.
`readDiscussionHistory` supplies validated bodies for independent source-specific
checks; titles, tracking markers and report claims remain discovery only.

### Repository-wide proof coverage

The retained [github/gh-aw coverage report](operational-value/gh-aw-workflows/index.html)
pins 344 agentic workflows at `c86377ec47b38f0b5af463277ee55d1d03d08da8`
and the `2026-10-18T15:00:12Z` cutoff. Its cursor traversal captured 58,048
surviving issues/PRs, including 31,638 recognized run markers. Normalized,
digest-checked acquisition partitions live beside the report under
`docs/operational-value/gh-aw-workflows/evidence/`; raw bodies and usernames are
not retained. The acquisition happened after the cutoff, so current graph state
is not claimed to be historical state at that cutoff.

The standalone report has sortable **Signal**, **Evaluation coverage** and
**Evidence freshness** columns, plus status selection and direct evidence links.
Its headline shows the native-evaluated percentage, count and remaining work;
80 of 344 is 23.3%, with 264 workflows still unevaluated.
Coverage shows periods with native values, not full-goal acceptance. Stale reports,
historical-only values, unknowns and scoped negatives remain distinct; freshness is
relative to the frozen cutoff, not today's date. Presentation orders and status
groups are compiled from the retained portfolio; browser controls only display
those precomputed rows. This portable file report does not query the CAO dashboard.

This is **not a completed value evaluation of all 344 workflows**. Linked native
policy-outcome evaluations establish three concrete infrastructure hosts removed
from the explicit Claude transport opt-in, and two independently reproduced
credential-at-rest condition repairs: origin-token persistence and wrapper
permissions for both fresh and existing files. The wrapper repair counts once,
not once per test case. Named engine sets were already explicit `network.allowed`
opt-ins, not unconditional engine access. These are heterogeneous native units,
not a combined value score. Preserved v1 contracts remain separate from the
explicitly outcome-informed retrospective v2 facets. Full acceptance, comprehensive
safeguards, receipt-verified contribution and costs remain unknown. The security
model retains a separate all-unknown gap report: eleven failure/incomplete issues
and two original pinned-runtime preparation failures do not establish completed
TLC exploration or native boundary acceptance.

The constraint-solving lesson instrument independently verifies three explicit
worked instances: a 4-Queens placement, an order-four Latin square and a proper
coloring of a fully enumerated five-vertex graph. The finite mathematical oracle
checks every defining witness constraint; it does not execute lesson code or
trust a claimed solution. A fourth selected Sudoku lesson supplies only a partial
input, not a complete witness, and remains unknown. Three measured periods do
not establish a trend or full lesson quality. These surviving body versions were
acquired after cutoff; original publication-time accuracy, general model
correctness, optimality, educational usefulness, nonrepetition and contribution
remain separately unmeasured.

Other linked native
evaluations include File Diet's lifetime structural contributions, the
rendering verifier's repository conformance, Go Test Parallelizer's unchanged-body
parallel activations, and six engine-conformance workflows' independently proven
behavioral cases, plus nine source- or issue-condition partial evaluations
and two native smoke checks, plus eleven native host-predicate evaluations and two
durable-ledger projection facets, default-version and direct-package currency
facets, a bounded formal-search facet, a static slide-geometry facet and
LintMonster's native function-body source facet, the native documentation
spelling facet, the compiled agent read-permission configuration facet and two
goal-specific schema-reference facets, a weekday-choice delivery function and
Instructions Janitor's native size-audit facet and CI Cleaner's model-catalog
formatting facet, plus independently replayed partial native container-tool
checks, temporary-ID reference/graph resolution, lockfile statistical accuracy,
Purelock executed coverage and native multi-PR branch-payload delivery.
Other workflows have functions and explicit unknown evaluations without
measured native outcomes. The newly integrated cross-repository creation/update
and PR-checkout investigations retain native evidence-gap reports, not measured
delivery. The Elixir Credo audit exhaustively replays 1,932 source states and
6,602 immutable Markdown blobs with no eligible snippets; its working native
tooling does not turn an empty opportunity population into clean compliance.
The dynamic-workflow investigation also has a replayable gap report after full
caller-source review, but no protected invocation/result proof.
Reusable-caller artifacts now have an integrated, production-replayed gap report:
all 2,459 discovered runs are retained, all 1,524 unresolved original candidate
logs are unavailable, and no original artifact payload survives. Acquisition is
complete; collision-safety, payload correctness and protected consumer acceptance
remain unknown in all 33 periods, so this does not increase native coverage.
Historical acquisition and versioned evidence integration continue for measured
partial workflows; measurement credit does not mean that work is finished.
The five newly measured partial workflows retain explicit open-history labels:
98 distinct container run/tool proofs across eleven runs, and 36 resolved body
references plus 12 parent-child links across six temporary-ID executions.
The latest native week contains 34 tool proofs and six references/two links,
respectively; neither supports a trend or full historical attainment claim.
These are separate native units and are never summed across workflows or
overlapping observation windows. Lockfile statistics retains 10,662 verified and
286 incorrect distinct assertions across 45 independently replayed full-population
censuses. Its latest week has 726 verified facts and 156 incorrect; the preceding
partial week has 857 and 129. The latest individual census is separately 121
verified and 26 incorrect across 344 lockfiles. All 17 queued acquisitions are
complete, but missing summaries, incompatible prompts and unresolved assertions
remain unknown. Neither trend nor full workflow acceptance is established. Reproducing that
native oracle requires the pinned parser in
`docs/operational-value/proof/lockfile-stats/native-requirements.txt`;
install it into an isolated Python environment before running
`python tests/unit/lockfile-stats-native.py`.
Purelock independently retains three source-bound coverage states, including the
complete 27-shard CI join; 283 uninstrumented CI functions remain unknown.
Multi-PR delivery retains 44 verified original branch payloads, including 21
CRLF payloads. Its regenerated cutoff-aligned, non-overlapping periods reconcile
to that exact union, not the invalid sum of overlapping snapshots, 56/27.
Earlier overlapping observations remain in the version-keyed evidence archive.
All 24 accepted interval timelines now follow the same cutoff-aligned,
non-overlapping scheduler. Seventeen older timelines were resampled offline
without changing their frozen functions; all 85 original report/evidence files
are retained byte-exact in
`docs/operational-value/proof/interval-schedule/pre-disjoint-resampling-v1.json`
and its digest-checked codec parts. Existing observed partial facets remain
available even when complete-population totals are unknown. Snapshot and event
projections are unchanged; resampling is not new delivery or additional credit.
The latest week has four verified payloads and two CRLF payloads; unknown
eligibility and full two-branch/summary acceptance are not promoted to completion.
Its 188 additional protected logs are now all unavailable, not pending. Complete
source-approved message enumerations retain no `add_comment` request or created
summary receipt; 46 native warnings explicitly skip commenting because the
trigger is undetermined. Branch payload value does not imply full summary delivery.
Its current module uses readability-preserving static-literal formatting to meet
the existing source-line budget. Identical normalized AST and token lexemes,
the exact prior source/proof bytes, and the original observation identities are
retained in its formatting-equivalence receipt; no predicate or outcome changed.
These five functions, native evidence, evaluations and plots have been integrated
and independently replayed. Historical completeness and full-goal acceptance
remain separate open milestones. Shared skill refinements and coverage publication
stay with the coordinator.
The page records its publication timestamp separately from the frozen evidence
cutoff. Gap-report links work across the retained report directories and do not
increase native coverage. Temporarily rate-limited acquisition remains open;
it is not permanently unavailable evidence or proof of zero delivery.
Four more investigations cover safe-output conformance, CLI performance,
blog auditing and editor HTTP availability. All four functions and retained
reports have been independently replayed, but remain in progress, not measured
coverage or exhausted evidence gaps. Blog auditing has no independently observed
page checks; its leading partial cohort's provisional no-opportunity zeros are
not delivery. Editor availability retains both source eras and all 12 historical
inventories. Its bounded provider run listing returned all 79 currently matching
runs, including 61 without retained output seeds; this is discovery, not deleted-run
history or original editor HTTP responses. The prior 22-file proof remains
byte-exact in its predecessor archive, and native HTTP outcomes remain unknown.
The latest run's original protected trace has no editor HTTP invocation:
denied source inspection is not an HTTP failure, and an internal safeoutputs
RPC status of 200 is not editor availability. Its complete 39-file predecessor
is also preserved before adding those original run receipts.
The CLI's original benchmark
artifact and protected log agree on 7,187,936 reported nanoseconds per attempted
operation across three iterations. Its separately linked native diagnostic is
not accepted compilation latency: the fixture ignores compilation errors, one
protected unit shard failed, and all 291 accepted latency values remain unknown.
No trend or workflow contribution is inferred. Original receipt discovery and
pagination remain explicitly open; assigning or implementing a function does not
establish an outcome. Safe-output conformance retains the entire current/adoption
specification review and all 55 source-cited rule reconciliations: 20 families are
partial lexical checks and 35 remain unimplemented. Three unsuppressed findings
and 13 suppressed raw findings are diagnostics, not full behavioral conformance
or demonstrated remediation. Its source-derived v2 surviving-file correction
preserves the sealed predecessor; required-file creation cannot count as
clearing a finding in an already-existing file. Baseline reconstruction and
original producer/remediation evidence remain open, and attainment-only output
is explicitly provisional.
The next six isolated workstreams cover model-resolution, raw MCP telemetry,
model-inventory, daily-credit guardrail, cross-repository compilation and CI repair.
The telemetry function has now been independently replayed: all 40 disjoint
periods are unknown, and 70 lineage candidates do not establish telemetry.
Its current capped sample and RPC fallback are separate from the adoption
source's gateway-only population; current predicates are not backdated.
The model-resolution checker and its all-unknown 59-period report are also
retained. Its diagnostic decoder reads the actual session/proxy schemas, which
lack an independent child-to-request identity bridge: matching models, tokens,
timestamps or aggregate accounting cannot fill it. Caller assertions and
unreviewed child-ID extensions are rejected; full function readiness remains false.
The cross-repository compile checker and five partial CI-repair receipt decoders
are retained, not admitted as complete protected native instruments. Original
compiler/cohort receipts, CI failure/landing checks, unsupported native checkers
and producer authentication remain explicit gaps.
The credit guardrail's original 14-file instrument is preserved but not admitted:
the actual checker bypasses every `workflow_dispatch`, including routed dispatch,
contradicting its predecessor eligibility assumption. The additive source review
also separates adoption's cap 10/copilot from current cap 1/pi. Source declarations
cannot supply the missing independent accounting ledger, inference audit or
executed-version receipts.
The credit and cross-repository compile reports end after the frozen evidence
cutoff and remain separate prospective artifacts, not frozen-portfolio evidence.
Model inventory's ownership-path correction is integrated with all 20 original
members retained and path-only function equivalence replayed. Its 62 current
aliases all have unknown live support without complete independent dated provider
inventories; SDK, routing, pricing and capability acceptance remain separate.
No native outcomes are claimed for these six workstreams, and their collectors
remain offline.
Four further owned instruments now cover step-name alignment, workflow report
normalization, CLI consistency and syntax-diagnostic quality, without claiming
full-function readiness. Step naming retains 40 disjoint periods and native
compiled-step comparisons: three partial periods establish zero observed lexical
repairs in 11, 74 and 72 readable pairs, **not zero total workflow value**.
Full semantic acceptance and contribution remain unknown. CLI consistency's
frozen source satisfies 22 of 22 implemented literal documentation obligations;
one registry-dependent requirement and actual command behavior remain unresolved.
This partial snapshot is not a defect-free CLI or historical improvement.
The report-style checker proves only closed-syntax, content-preserving partial
repairs in synthetic fixtures; production report revisions, active membership and
protected producer bindings are absent. Syntax quality decodes native diagnostic
JSON, text, build identity and exact numeric-engine restoration, but all production
outcomes and full developer usability remain unknown.

The step-name and syntax instruments' frozen-cutoff evidence plots are retained
as incomplete reports, not added measured coverage. CLI activation equals the
cutoff and report-normalizer activation follows it; their later prospective
reports remain separate rather than backdating the functions or plotting fixtures
as history. All four preserve original owned packages and discovery lineage,
with costs, full accepted delivery and workflow contribution unmeasured.
Thirteen other source-matched outcome proposals still need independent instruments,
220 need outcome-contract authoring, and 10 changed source blobs need intent
review. These are remaining measurement tasks or evidence gaps, not workflow
failures or zero-value results. A steady repository conformance signal is not
claimed as workflow delivery.

Four isolated investigations cover artifact-inventory accuracy, changeset
correctness, native Redis service-port operations and SDK file/read-back effects.
They follow the File Diet outcome-first path: inspect real downstream evidence,
measure the smallest independently verified useful change, and separate broader
acceptance and attribution. Assignment and fixture-only instruments are not
native evaluations. The target remains all 344 workflows, with 278 still lacking
native evaluations at this cutoff; refreshing this inventory does not complete it.

Changeset now adds a real structural partial evaluation, not just an instrument:
the October 4-11 period establishes 21 newly release-readable files, 21 newly
nonempty descriptions and 12 explicit-format transitions, with 22 assessed and
22 missing transitions. The latest period has no assessed transitions and 62
missing, so it stays unknown, not zero; no complete recent trend is claimed.
The cutoff's 731 readable files are a repository snapshot, not weekly delivery.
Exact native consumer-parser quirks and original before/after inputs are
preserved; semantic accuracy, completeness, bump appropriateness, safeguards and
workflow contribution remain separate unknowns. This follows File Diet's rule
that independently verified useful structural progress survives broader
acceptance gaps without weakening the frozen full-goal claim.

SDK now retains one measured period with two protected native effects: an exact
file-content phrase readback and actual Bash arithmetic output `42`, with 35
other disjoint periods unknown. New-file creation, full clock correctness and
the full goal remain unknown. Original compound execution is not rewritten as
fictional standalone commands; the real introduction and each applicable source
era are separate.

Redis retains three independently corroborated protocol cases and one
host-bound integration session in an **explicit same-source retrospective
reconstruction**. PONG, the exact SET/GET value and the source-defined INFO
prefix are established; no restart durability is claimed. The unchanged
contract still rejects the standard frozen evaluation because its activation
follows the cutoff. That actual rejection and the original null snapshot remain
preserved, and the linked retrospective report explicitly does not claim
standard evaluator success, ex-ante historical acceptance or adoption gain.
Unknown earlier cohorts do not become zero; neither new partial evaluation
establishes complete history, comparable trends, sole causation or a keep bar.

The small-model case adds one protected native Bash arithmetic result, `42`,
with 14 earlier periods unknown. Its separate three-newline file creation and
`cat|wc` read do not establish full-content readback or the strict write/readback
join. Chromium's native GLIBC launch failure remains a failure despite the
shell pipeline's zero exit code; original-haiku and full acceptance stay unknown.

The drive-memory case establishes two source-bound blocked attempts, not
positive delivery: the protected drive-service permission denial prevents both
agents from starting. Its latest partial cohort has zero same-run and full-goal
attainments, while restored persistence and actual git-log access remain unknown.
Eight earlier periods are unknown, not zero; the 25 direct and 37 related
discovery identities are not extra outcomes. Actual introduction and real-parent
absence proofs enable the standard nine-period frozen report without erasing
the preserved earlier rejection. Neither case establishes comparable movement,
a complete execution census, a keep recommendation or measured costs.

Pydantic adds one source-bound native Python filesystem-read case, deduplicating
three successful README reads in the October 17 authenticated trace. Strict
`read_file` conformance remains separate: that tool was never invoked in the
complete selected trace, so the scoped strict count is zero. The October 9
console-only mention lacks native arguments and returned bytes and remains
unknown, as do all ten earlier periods. Calculator output is not a standalone
model answer; host gateway listings do not prove agent-usable MCP or transport.
Persistence, full acceptance, complete history, costs and keep decisions remain
unknown. Actual workflow introduction is proven, but its initial goal differs;
later README acceptance is not backdated.

CI replay's forensic evaluator is implemented but **does not add native
coverage**. Fifteen original comments across two candidate PRs contain no accepted
unchanged source message. Unbound triggering targets, unknown executed workflow
revisions and expired original logs prevent a zero-effects claim. All 184 periods
remain unknown, with original predicates, compressed reports and failure receipts
preserved. An LLM invocation is not required for deterministic useful effects,
but an unused prompt and a successful replay do not establish those effects.

Two documentation cohorts now add five bounded native evaluations. Designer
guidance has 12 independently verified network-shorthand corrections; healing
has two authentication-warning repairs checked against implementation; updating
has one supported safe-output parent-selection option documented. Their original
local-reference predicates remain unchanged, rejected factual predicates remain
rejected, and the added factual version is explicitly **outcome-informed
retrospective authoring** after candidate PR prose, not ex-ante acceptance.

Claude onboarding has one source-verified missing add-wizard API-key setup
instruction repaired, checked against six contemporaneous implementation files.
The latest interval remains unknown; the earlier success is not carried forward.
Developer consolidation has one assessed native nonacceptance: zero lossless
redundant source occurrences removed in the selected original target-only change,
not zero semantic improvement or whole-period value. Older target paths are not
backdated into current eligibility. Unbloating adds only an all-null gap report:
the early candidate is an excluded blog change and the latest is unmerged.
It does **not** increase native coverage. Full semantic acceptance, human
usability, workflow contribution, complete history and matched costs remain
unknown across these cases.

Lint mining adds two narrow native evaluations: one retained `fs.mkdirSync`
call newly guarded by local `try/catch`, and two library `os.Exit` sites replaced
by same-function, same-code error returns. Unknown recovery, caller-wide
semantics, full diagnostic precision and attribution remain separate.
The refiner's standard EventEmitter alias correction is only a source-level
compatibility facet: selected originals explicitly describe no live affected
target. It remains an evidence-gap report, not native diagnostic coverage.

Go dependency work adds three bounded native evaluations: seven selected
historical bundled targets implemented, four recommended direct targets
implemented, and ten assertion API sites structurally migrated in three files.
These are different native units, not an additive portfolio score.
The original Burner's 333-byte goal is issue bundling per runtime/manifest;
explicit retrospective era v3 preserves that goal rather than backdating today's
generated-source rule. The GoFan subtotal is ten, not the candidate's claimed
602. Native Go AST and immutable manifest comparisons verify actual matched
sites and targets; advancement is not proof of safe-patch classification,
release correctness or behavioral preservation. Editable original issue links
corroborate shared delivery, not authoritative creation receipts or sole causation.
No-case periods, unassessed implementations, HTTP410 issue originals, full
acceptance, safeguards and costs remain unknown.
Assignments, edit counts and merged candidates do not increase native coverage.

Three additional native smoke reports verify bounded capabilities, not repository
improvements. Claude has two actual expanded-date write/readback attempts.
Cursor has one dated write/readback facet and one asynchronous native build
completion joined by exact start/task/session/command identity. OpenCode has one
literal-template native readback, **not** expanded-date acceptance; its native
build fails, and overlapping write/read intervals do not establish write-before-read.
The literal facet is an explicitly outcome-informed versioned partial, preserving
the stricter frozen acceptance. Gemini, Kiro and Crush retain separate replayable
gap reports: setup/auth failures, missing returned bytes/call correlation, or
missing native tool effects prevent outcome verification. They do not increase
native coverage. All six preserve unassessed periods and unknown costs/keep bars.

The remote MCP authentication report independently verifies three sampled
protected raw-canary transport checks. Exact-head editable and compiled scripts
match the frozen predicate; original runtime witnesses establish initialize,
initialized notification, ping, a concrete 23-tool catalog including `list_issues`,
and a non-error call. This is repeated sampled compatibility, not three repairs.
The canary does **not** verify returned issue schema/bytes or agent usability.
Its secret-token fallbacks also mean masked logs cannot establish Actions-token
credential identity. Full-goal acceptance, workflow contribution, costs and the
other forty weekly periods remain unknown. Seven-day grouping is an explicit
retrospective reporting choice, not an exhaustive historical test census.

The separate Codex remote-MCP instrument verifies one native access attempt
through protected stdout, matching raw/normalized call identities and a unique
sequential official-backend gateway exchange. Three open issues exist upstream,
but integrity policy withholds all three before the native result reaches Codex:
**upstream bytes are not agent readback**. Gateway request records omit IDs; the
cross-channel corroboration uses exact arguments, uniqueness and enclosing native
timestamps, not an invented shared request ID. The executed October 3 source did
not yet call filtering an expected result, so today's policy language is not
backdated into historical full success. Eight other run identities lack original
agent jobs; the remaining 39 weekly periods stay unknown.

Six monitoring instruments assess source-specific factual facets in one surviving
report body each: two workflow-inventory cells, thirty literal mainline commit
citations, ten extension populations, three JSON tool-mapping facts, fifty-five
listed new-issue identities and two captured-cache creation-window counts.
Their accuracy percentages apply **only to those named facets**, not overall
report quality or a portfolio score. The chronicle's stated 24h05m window does
not satisfy its 24h requirement. The weekly issue report's opening count has an
independently established undercount floor of thirty despite correct listed
new-issue citations. JSON mapping counts do not verify the claimed live-tool
inventory, and a retained 1000-issue cache is not the entire repository.

These six are explicitly outcome-informed retrospective assessments. The bodies
are surviving versions observed after cutoff, checked against independently
retained native facts and allocated by original report-creation cohort.
**Original publication-time body bytes and accuracy are not established.**
Other report cohorts/periods, semantic/editorial usefulness, creation receipts,
causal contribution, full acceptance and matched costs remain unknown.

The work-queue observer investigation retains all 12 initial executions:
seven belong to an incompatible historical finish-staging goal, and five are
observer-era opportunities. Eleven provider-digest-checked agent archives and
four protected log projections survive, but no independent observer operation,
snapshot or mutation-safety receipts. The upload also omits the finish file,
so a downstream missing-file check cannot prove local nonmutation. Its
[evidence-gap plot](operational-value/gh-aw-workflows/smoke-work-queue-pulse.html)
and retained function are available; all native values remain unknown and do
not increase measured coverage.

The parallelizer retains 1,718 immutable mainline Go-change commits and 11,601
digest-checked blob features from adoption through the frozen cutoff. Its native
function establishes 1,295 corroborated workflow-linked net unchanged-body test
parallel activations across 33 changes, within 2,145 repository-wide net
activations. These are source-verified partial improvements, not proof of race
safety, faster execution or complete acceptance. Unknown safeguards do not erase
the measured source improvement.

Tidy's full-history Go facet retains 229 known exact-format repairs; its complete
repository total is unknown and the retained graph establishes no linked Go
formatting delivery. Architecture Guardian's fixed-default Go facet shows
minus ten blocker reductions: ten more files above 1,000 newlines, not ten
improvements. Its linked contribution is zero in the retained graph. Neither
facet claims full lint, architecture-policy or behavioral acceptance.

ESLint Monster establishes five observed workflow-linked missing-radix
reductions. YAML lint retains eleven repository trailing-space reductions in
one frozen generated-file sentinel, with zero linked workflow reductions.
Unknown assessments stay unknown; this sentinel does not establish a
fleet-wide generator fix.

The two issue-triage functions share historical label, assignment, closure and
reopening events for 34,592 surviving issue identities. Their native partial
facet counts open issues gaining a first label, minus losing their last label;
Issue Triage Agent additionally requires historical unassigned eligibility.
Current labels are never backdated. Terminal-state mismatches and transfers
remain gaps. These plots measure repository discoverability progress, not
correct classification, causal workflow attribution or attainment of the
whole-repository five-percent target.
The actor-independent since-adoption subtotals are 29,269 and 30,048 net
coverage gains respectively, with 156 unreconstructed histories keeping complete
totals unknown. These overlapping cohort counts must not be added together.

Spec Coverage Kiro retains twelve immutable observation states and 248
digest-checked specification blobs from adoption. Its complete local-reference
scan remains at zero broken links in the observed states; missing-description
counts decrease from eight to zero. This is maintained repository condition,
not fresh weekly delivery or demonstrated workflow causation.

Schema Feature Coverage retains 32 immutable observation states and 12,188
independent structural validations of schema/example pairs. Uncovered properties
decrease from 19 in the first weekly state to six at cutoff; the schema population
also grows from 46 to 71 properties. At cutoff, 369 of 515 example documents are
valid standalone workflows and cover 65 properties (91.55%). Prose, nested keys,
schema-invalid documents and imported fragments without a trigger do not supply
credit. This is repository usage coverage, not compiler acceptance or attributed
workflow delivery.

Safe Output Integrator reuses the independent structural validator for its
`pkg/cli/workflows/test-*.md` fixtures. The eligible static registered type
population grows from 37 to 59; types without a valid standalone declaration
move from two to one. At cutoff, 215 of 233 fixtures are structurally valid and
cover 58 registered types (98.31%). Configuration-only keys and registry tools
without a canonical schema property are not counted as missing safe outputs.
This partial facet measures declarations, including valid disabled
configurations, not runtime exercise, dynamic tools, imported-only support
or passing Go compiler assertions.

Separate native smoke checks retain 20 observed Agy behavior proofs and ten
Aider partial behavior proofs. Two Agy assessments establish the full protected
conjunction, but incomplete historical coverage keeps complete totals unknown.
These are repeated monitoring observations, not new code changes. The
Claude/Copilot smoke workflow has no surviving independent assessment and
remains evidence-blocked rather than zero-valued.

Ten additional host-predicate functions retain twelve independently established
proofs across 545 initial-run opportunities: two one-credit enforcement
rejections, one packaged Claude dynamic invocation, and nine
routing/delegation/detection/steering proofs across eight workflow variants.
These counts are native monitoring observations, not code fixes or complete
historical totals. Missing assessments remain unknown, and the short retained
coverage does not establish an improving or worsening trend.

Historical routing evidence uses reviewed, coherent job/checker/runtime profiles.
Its native assertion steps and workflow intent are unchanged; runtime-version
differences are explicit, not assumed irrelevant to every engine behavior.
Expanded contracts retain previous definitions, functions and observations under
`proof/host-assertions/versions/`. Profile identities participate in the exported
definition so old unknown observations cannot silently satisfy a newer contract.
Coverage requires a current evaluated native value with matching function and
evidence-index provenance, not merely a positive acquisition counter.

Built-in Ledgers and Repo-Memory Ledger each retain five immutable durable-branch
states. Four nonempty states independently replay through the pinned production
canonical ledger, built-in reducer and SQLite materializer. At cutoff, all four
log fixtures and all four table-upsert fixtures survive exact expected-row
comparison in read-only SQLite. Raw canonical fixture blobs and the seven-file
native source closure support offline reproduction; only bounded run fixtures,
not arbitrary notes or ledger contents, are retained.

These plots show maintained replayable state, not fresh weekly delivery or
proof the historical agent inspected the database. The Built-in Ledgers facet
does not establish the other five ledger types; neither facet establishes
exclusive workflow causation or complete historical branch identity across
deletion/recreation. Empty initialization is no fixture opportunity, not a
measured failure.

CLI Version Checker now compares actual Go AST version constants against 1,369
surviving official stable-release publications for its eight named tools. It
retains 55 immutable weekly endpoints and 141 digest-checked source blobs.
Seventeen endpoints establish the complete eight-tool cohort; earlier partial
cohorts remain separate diagnostics, not comparable improving/worsening scores.
At the frozen cutoff, one pin is demonstrably behind: Claude Code `2.1.296`
versus published `2.1.302`; the other seven are not below the greatest eligible
surviving stable release. Playwright's three-day cooldown is respected.

This is default-version condition, not proof of upgrade compatibility, Docker
digest freshness, issue quality or exclusive workflow contribution. Publication
metadata is retained for offline replay; deleted releases and historical mutable
`latest` tags are not reconstructed. A timestamp-boundary correction preserves
the original function, interpreter, evidence and observations under `versions/`.

Update Astro retains 32 immutable manifest/lock endpoints since its March 17
adoption, 55 source blobs and dated official publication histories for a fixed
eighteen-package direct dependency cohort. Four recent endpoints establish the
complete cohort; earlier absent or unsupported lock evidence remains unknown
in the primary plot, with known-package counts shown separately. At the frozen
cutoff, nine locked packages fall below the policy's greatest surviving dated
numeric stable publication, versus eight one week earlier.

This is a frozen version-reference comparison, **not nine actionable upgrades**:
for example, `satori`'s greatest retained numeric version is `1.0.4`, published
in 2015, while the native lock pins `0.33.5`. Old package lineages can rank above
current release channels. The report does not reconstruct historical `latest`
tags, establish package-lineage continuity, prove migration/build correctness
or attribute the repository condition exclusively to this workflow. No keep
bar is invented; the evaluation remains not rated.

An explicit versioned review-metadata extension now marks the four complete
package cohorts as comparable and retains all earlier partial cohorts as
incomplete. The recent native reference count worsens from eight to nine;
this is not a workflow retirement recommendation. The prior function,
interpreter, collector, source closure, observations and reports remain under
`package-currency/versions/`; no native pin, publication or metric value changed.

Slide Deck Maintainer retains 45 immutable weekly endpoints since adoption:
36 have independently measured static Marp/Chromium geometry and nine lack the
required deck/theme input. Earlier measured states include one to three slides
with overflow; at the frozen cutoff all 36 slides fit, unchanged from one week
earlier. Affected slides and out-of-bounds descendant elements are distinct
native quantities, not summed deliveries.

This is a pinned local static replay using the explicitly registered checked-in
theme, not reconstruction of a historical agent session or the workflow's
unpinned CLI invocation. That invocation does not explicitly bind the theme.
Scripts and external requests are disabled; the two missing Mona Sans font
assets and consequent platform font fallback are recorded. Git and LFS
identities, source bytes, dependency lock and native rectangles are retained
for replay. Content accuracy, interactive diagrams, broad rendering portability
and workflow attribution remain unmeasured. Stable zero overflow is evidence
of this bounded repository condition, not proof of new work every week.

LintMonster retains 24 immutable weekly/cutoff endpoints since its May 16 adoption,
6,632 hash-verified Go source blobs and the native rule/suppression sources.
Its [native plot](operational-value/gh-aw-workflows/lint-monster-pulse.html)
counts parsed declarations and literals above the frozen native 60-body-line
boundary across non-test, non-generated `cmd/` and `pkg/` sources. The first
complete weekly endpoint contains 672 overlength bodies; the cutoff contains
539, down from 550 one week earlier. The eligible population grows from 4,949
to 12,608 functions/literals; these are raw native counts, not a normalized
quality score or exclusively workflow-delivered repairs.

Suppression is not a structural repair: all 539 bodies remain in the primary
count, with 404 unsuppressed and 135 suppressed bodies shown separately.
The replay preserves native same-line/previous-line `largefunc`/`all`
suppression semantics. It does not execute repository code or infer clean lint
from successful pre-checks or fallback error-line counts. This all-platform
source facet does not reconstruct historical build-tag selection, establish
other lint rules or typechecking, prove behavior preservation or attribute
repository movement to LintMonster. The frozen current default is comparable,
not a claim that every historical configurable policy was identical.

Daily AstroStyleLite Markdown Spellcheck retains 29 immutable reference endpoints
from its April 20 adoption through the cutoff, including the adoption anchor,
and 1,521 independently hash-verified source blobs. Its
[native plot](operational-value/gh-aw-workflows/daily-astrostylelite-markdown-spellcheck-pulse.html)
uses CSpell and its JSON reporter at 8.19.4 with a pinned dependency lock,
installed-tool identity and one frozen cutoff-native configuration. No optional
technical dictionary existed at that cutoff. The same reference vocabulary
checks every historical Markdown/MDX cohort; this does not reconstruct each
historical npm installation or hosted run.

The adoption anchor contains 1,273 diagnostics across 150 documents; the cutoff
contains 2,499 across 259 documents, versus 2,435 one week earlier. The comparable
recent native count therefore worsens by 64, with population growth explicit.
These are native checker diagnostics, not 2,499 proven English-language defects
or a measured count of workflow-delivered repairs. Unknown words and explicitly
forbidden words remain distinct. A retained positive probe and native jq
execution verify that `isFlagged: false` still counts under the source workflow's
`// true` filter; jq defaults false as well as null.

Source-internal waiver changes make the affected interval non-comparable, not
a credited repair. Runtime errors and missing source cohorts cannot become clean
checks. Raw source identities/bytes, normalized findings and the positive probe
are retained for offline replay. Linguistic correctness, exclusive contribution,
cost and a keep/retire bar remain unmeasured.

The original 28-endpoint function, producer, complete source/evidence closure and
reports remain in a bounded packed predecessor archive. An explicit acquisition
extension adds the missing start of the previous comparison interval without
changing the function or any established native observation. Both adjacent
windows now establish waiver continuity, so the actual published signal is
**worsening / review**, not an inference from the two counts alone.

The Properly Provisioned Permissions example retains 54 source/reference
endpoints from its October 31, 2025 source adoption and 70 hash-verified source
and compiled-workflow blobs. Its
[native plot](operational-value/gh-aw-workflows/example-permissions-warning-pulse.html)
counts exact `contents`, `issues` and `pull-requests` read-grant mismatches in
the actual compiled agent job, with agent write grants separate. At the cutoff
both counts are zero; the recent configuration signal is **steady**, with no
attention indicated for this facet.

This workflow originally demonstrated intentional under-provisioning warnings,
not successful read-only provisioning. Those historical quantities remain
visible but are not comparable acceptance for the later goal. The first source
anchor has no compiled artifact and remains unknown, not a failed execution.
Explicit agent-job permissions replace, rather than merge with, workflow-level
permissions. Write grants in separate safe-output/conclusion jobs are not
mistaken for agent grants. This configuration facet does not establish compiler
warning behavior, live scoped access, MCP read-only enforcement, measured costs
or workflow-delivered contributions.

The Daily Schema Consistency Audit and Schema Consistency Checker share 66
immutable schema endpoints and 70 retained source blobs, with separate
goal-specific functions and denominators. The audit's
[native plot](operational-value/gh-aw-workflows/daily-schema-audit-cursor-pulse.html)
counts root definitions unreachable from the schema evaluation structure;
the consistency checker's
[native plot](operational-value/gh-aw-workflows/schema-consistency-checker-pulse.html)
counts unresolved local references. At the cutoff, all 49 root definitions
are reachable and all 314 declared local references resolve to valid schemas.
Both recent signals are **steady**, not evidence of new delivery every week.
Earlier retained schemas contain up to two unreachable definitions.

The pinned native Draft-7/JSON Pointer oracle runs offline, with dependency
file identities and 15 positive/negative native probes retained. It handles
escaped and percent-encoded pointer names, cycles, boolean schema targets and
Draft-7 reference-sibling semantics; annotation text does not count as usage.
Unsupported external references and nested resource/dialect scopes stay unknown.
Missing references make definition reachability non-comparable, rather than
creating false cleanup credit. Optional properties are not automatically
defects, and local unreachability does not prove a public definition is unused
externally or safe to delete. Required-field correctness, implementation/docs
agreement, attribution, costs and complete goal acceptance remain unmeasured.

The Daily Choice Type Test's
[native plot](operational-value/gh-aw-workflows/daily-choice-test-pulse.html)
retains 243 execution identities from its December 22, 2025 adoption through
the frozen cutoff. Four configurations, delivered October 13-16, independently
match the source's weekday rule: staging/smoke on Monday, Wednesday and Friday;
production/integration on Tuesday and Thursday. Both original artifact payloads
must agree, their downloaded archive hashes must match provider digests, and
the source-bound protected custom job must read back the same configuration.
A successful run or job alone does not qualify.

There are 234 unassessed weekday opportunities and five ineligible weekend
dispatches, for which the source declares no rule. Expired artifacts, reruns,
unreviewed historical source profiles and missing protected receipts are not
zero deliveries or demonstrated incorrect choices. The recent window contains
four verified configurations across five opportunities, but no complete
previous comparison: the published signal is **insufficient evidence /
evidence needed**, not steady or improving. These four established deliveries
remain value despite incomplete lifetime coverage. This proves delivered
configuration, not actual test/deployment execution, invalid-choice rejection
or measured costs. The complete four-proof function, sources, evidence and
reports are also preserved in a version-keyed predecessor archive before any
future extension of historical source support.

Instructions Janitor's
[native plot](operational-value/gh-aw-workflows/instructions-janitor-pulse.html)
retains 55 adoption/weekly/cutoff endpoints from October 23, 2025, 614 immutable
source blobs and 571 distinct native line-count inputs. The explicit size-audit
rule is that no direct `.github/aw/*.md` file may be **over 400** lines.
Native `wc -l` counts newline characters; exactly 400 does not exceed this audit
ceiling, and an unterminated final line adds no newline. The stricter named-file
layout targets are a separate, unmeasured requirement.

At the frozen cutoff all 82 eligible files meet the audit ceiling, with zero
excess lines. One week earlier, one of 78 files exceeded it by 32 lines.
The actual recent repository-condition signal is **improving**, with no attention
indicated for this facet. Eight native boundary probes and full immutable-input
replay support the count. The historical source includes a 500-line policy era
and older unsupported policies; their current-reference quantities remain
visible but are not retrospective failures or comparable acceptance for the
later 400-line rule. Empty populations do not establish compliance, and compared
windows require policy continuity. This does not prove information preservation,
product accuracy, deduplication, stricter layout compliance, workflow-delivered
contributions or measured costs.

CI Cleaner's
[native plot](operational-value/gh-aw-workflows/hourly-ci-cleaner-pulse.html)
checks exactly `pkg/cli/data/models.json` and `actions/setup/js/models.json`,
the model catalogs declared in its `fmt-json` recipe. The retained history
contains 48 endpoints from December 11, 2025 adoption and 266 immutable blobs.
Pinned Prettier 3.9.9 matches the upstream dependency-lock integrity; its installed
file identities, four native probes and all 44 surviving catalog inputs were
independently replayed. Executable configuration and plugins are never loaded
from the repository; native ignore semantics determine whether a target is
actually eligible.

Both catalogs are formatted at the cutoff. Twenty-two endpoints have complete
native input pairs, but only three meet the reviewed current source profile.
The recent quantities are both zero, yet the previous complete comparable
period is not established: the actual signal is **insufficient evidence /
evidence needed**, not steady. Missing historical catalogs and unsupported
source configurations are not unformatted files. The first function, reports
and evidence closure are preserved before narrowing compatibility to the
goal-dependent model-format invocation; every original native receipt and
quantity remains unchanged. This facet does not establish other formatting,
model correctness, passing lint/tests, successful CI recovery, attribution,
regression safety or measured costs.

Larger native reports retain full evidence through digest-checked JSON archive
parts rather than dropping detailed facts or raising the 256 KiB file limit.
The standard report reader resolves both plain and compressed manifests;
copy every referenced part with the report. The same codec serves acquisition
archives, timeline validation, plot generation and incremental evaluation.
Machine-readable timelines use compact JSON so formatting overhead cannot
consume the decoded evidence budget without adding any facts.
Explicit `--refresh` reacquires the selected function's archived observations as
well as its current timeline; normal evaluation still resumes without collection.

Goose adds one historical native MCP/runtime smoke proof from 532 initial-run
opportunities. Its October 9 protected conjunction checks the source-declared,
checksum-verified Goose 1.53.0 runtime and actual correlated native GitHub MCP
traffic. The reviewed historical profile pins its entire jobs/parser/runtime
tuple. It does not certify current Goose 1.54.0, full compilation correctness,
or the historical parser's error-preservation semantics. The original,
current-version-only unknown evaluation remains archived before the explicit
historical extension.

Copilot Sub Agents now has a conditional native function, evaluation and retained
evidence for 82 initial runs, but remains evidence-blocked. Its sole successful
native assertion belongs to `single_agent_control`, which deliberately invokes
no subagents. The protected activation-job log independently establishes that
variant inside the exact selector-step interval. It must not become a positive
three-agent delegation proof or a fabricated zero-valued history. Source/runtime
profiles and each superseded unknown evaluation remain archived.

Protected experiment receipts retain only allowlisted variant/timestamp facts,
step metadata and archive/log digests. Both per-step ZIP entries and explicitly
versioned, exact producer-job logs with source-bound step intervals are supported;
agent stdout, report prose and ambiguous jobs cannot establish branch selection.

Work Queue Formal Verification retains four independently parsed native TLC
searches from ten initial-run opportunities. Its fixed-cohort exploration
frontier is 1,055,182 distinct states for `FairDAGGitHub` plus 195,900,304 for
`QueueOrdering`: **196,955,486 configuration-states**. Repeated searches do not
add these quantities again. The preceding complete cohort established
195,319,696 configuration-states, so the retained native frontier advanced by
1,635,790.

`FairDAGGitHub` independently exhausted its bounded state space; `QueueOrdering`
timed out with 48,697,205 states still queued. These are **one of two finite
configurations exhausted**, not two proofs or an unbounded guarantee. The
function preserves separate exploration and exhaustion quantities, unchanged
source/tool/search settings, safe raw counter lines and protected artifact
digests. Earlier changed source cohorts remain unknown. Weekly reporting has
only one comparable numeric endpoint at this cutoff, so an improving/worsening
trend is not yet established. Invalid presentation preflights and the prior
source-policy-unbound definition remain preserved; the native facts did not
change.

The conformance functions preserve five stable independent host assertions,
not agent completion claims. Their plots retain known proof counts through
missing historical assessments and withhold complete totals/rates across gaps.
An exact source-verified successful host assertion step proves its conjunction;
generic run success does not. Failed conjunctions are decomposed only from
retained protected reports, never assigned guessed per-probe failures.
The experimental Agy function explicitly measures only this shared partial
facet; its native MCP and staged-output extensions are not inferred. Its
surviving execution inventory is empty, so it is evidence-blocked, not zero.

Each workflow has a source-grounded goal/evidence entry and explicit measurement
status. Genuine measurements link to their native plot; unmeasured entries have
no synthetic flat-zero plot. Original marker-linked outputs, downstream PR
candidates, source-path ambiguity and provenance conflicts remain diagnostics
until graph follow-up and independent native checks establish improvement.
The first surviving output is explicitly not an adoption date.
The coverage report also shows function/evidence/evaluation/plot milestones and
separates evidence-blocked functions from work that has not been implemented.

Replay the retained acquisition and rebuild the partitioned report offline:

```sh
node scripts/build-gh-aw-value-portfolio.mjs \
  docs/operational-value/gh-aw-workflows/evidence NEW-REPORT-DIRECTORY
```

### Bounded graph follow-up

Tracking identifiers make later outcome reconstruction possible even when run
artifacts are unavailable. The repository-root
`scripts/trace-operational-outcomes.mjs` is a read-only gh-aw intent adapter,
not a second measurement interface or a dashboard query. It accepts an explicit
manifest with `repository` and `workflows: [{ id, path }]`; the frozen census's
contract manifest is also supported. The repository and workflow inventory
bound collection authority. Foreign producer repositories are excluded rather
than automatically followed.

The adapter searches a bounded issue/PR creation interval, reads exact footer
markers, validates their run repository, execution path and known attempt, and
records the execution revision through GitHub. A legacy footer without a workflow slug can resolve
through the actual run path, not its display name. The declared original
workflow is separated from appended contributor markers; extra contributor
references are retained as unverified metadata, not attributed creation.

It captures current issue/PR state, closure reason, merge commit and time,
reopening history, explicit closing links, cross-references and the current
head's check rollup. It follows closing relationships one hop within the
selected repository; ordinary cross-references are retained but not recursively
expanded. A declared closing link alone does not prove that the PR closed an
issue: the diagnostic requires the issue's complete state-event history to
identify that merged PR as its latest closer, with reason `COMPLETED`.
Regression acceptance still requires the goal's separately frozen checks.

For example, from this source checkout:

```sh
node scripts/trace-operational-outcomes.mjs \
  docs/operational-value/gh-aw-census/contracts.json.gz NEW-TRACE.json.gz \
  --since 2026-09-19T10:16:09Z --until 2026-10-17T10:16:09Z \
  --limit 200 --request-budget 500
```

The interval is start-inclusive and end-exclusive. Search is oldest-created
first, with at most 1,000 candidate results and an explicit request budget.
Indexed search is not a complete output inventory: deleted markers, comments,
reviews, Discussions, other output types and unlinked work are outside this
discovery instrument. Truncation, rejected identities, missing entities,
incomplete connections and request failures remain explicit. An unobserved
workflow has no observed-state summary, not zero value.

The output index references digest-checked, compressed entity partitions. Raw
bodies, prompts and actors are not retained. To revisit the same stable entity
identities later, repeat the command with the same manifest, interval and
adequate limit, a **new output path**, and `--previous NEW-TRACE.json.gz`.
This skips discovery, preserves the previous snapshot's digest, and can retain
the prior reference if a footer disappears. Conflicting provenance is reported,
not overwritten. Existing snapshots cannot be replaced.

Replay a recorded observation without GitHub access:

```sh
node scripts/trace-operational-outcomes.mjs --replay \
  docs/operational-value/gh-aw-census/downstream-final-2026-10-18.json.gz
```

These snapshots describe an acquisition interval, not an atomic GitHub snapshot
or recovered state at the cohort's end date. Merged/closed counts and merge
latencies are **diagnostics**; the adapter deliberately exports no primary
operational-value score. GitHub state is independent outcome evidence, but an
editable footer is not authoritative proof that a run created the object.
Preserve the independent problem cohort and accepted-evidence contract when
feeding these facts into `collectBatch` and `scoreMetric`. Reverts, deployment
effects and causal comparisons need additional instruments.

## A real, replayable end-to-end proof

The [real-case study](operational-value/goal-to-measurement-paper.md#54-real-goal-to-function-to-evidence-proof)
connects the rendering verifier's stated goal to its function, an independently
acquired provider failure, an Actions safe-output creation receipt, and
[github/gh-aw#62155](https://github.com/github/gh-aw/pull/62155).
The same diagnostic is lost before the workflow's original patch, preserved by
that patch and its merged revision, and still preserved at four later weekly
cutoffs. The selected cohort yields **one verified delivered repair**, not a new
repair every week or a complete estimate of the workflow's value.

The standalone module lives in
`tests/fixtures/operational-value-proof/rendering.mjs`; it is an explicit
research example, not an installed collector or campaign. The compressed proof
and its adjacent digest-checked source partitions persist in
`docs/operational-value/proof/`. They preserve the allowlisted input, receipt,
licensed upstream code and exact results, so replay needs neither GitHub access
nor unexpired Actions artifacts:

```sh
node scripts/prove-workflow-operational-value.mjs --replay \
  docs/operational-value/proof/rendering.json.gz --output-dir .tmp/operational-value-proof
```

The checked-in [value report](operational-value/proof/reports/daily-rendering-scripts-verifier-definitions.md),
timeline and observations are in the adjacent `proof/reports/` directory.
These retrospective results demonstrate the real evidence path for one selected
case; they do not validate automatic goal translation, total workflow coverage,
ROI or a keep/retire threshold. No recurring collection has been deployed.

### File Diet: distinguish a useful suggestion from a delivered refactor

The [File Diet case](operational-value/goal-to-measurement-paper.md#55-file-diet-correct-detection-an-unmerged-proposal-no-established-delivery)
applies the same path to `github/gh-aw`'s `daily-file-diet`: source goal,
deterministic function, complete historical Git inventories, Actions creation
receipts and downstream GitHub relationships. Its source-defined structural
measure is the number of regular non-test `pkg/**/*.go` files with at least
800 newline characters. Over five weekly cutoffs it gives **40, 42, 45, 49, 53**.
Seven receipt-linked issues correctly identify a largest oversized file.
An ordinary cross-reference connects one issue to
[github/gh-aw#64854](https://github.com/github/gh-aw/pull/64854), which proposes
a 1,214-to-370-line split but closes without merging. None of the selected
issues has an explicit accepted-refactor chain.

This demonstrates correct detection and a real downstream proposal, not accepted
delivery or causal improvement. All seven issues are currently `NOT_PLANNED`;
that alone is not success. The rising repository-wide count is not attributed
to File Diet, and the issue-producing workflow is not judged as if it directly
owned merging. Keep/retire remains not rated and costs unmeasured.

The standalone research module is
`tests/fixtures/operational-value-proof/file-diet.mjs`. The compressed
`docs/operational-value/proof/file-diet.json.gz` index and adjacent inventory
partitions retain complete per-file counts and immutable Git identities.
Offline replay verifies their digests and reaggregates the counts; raw-byte
rechecking requires read-only Git reacquisition. Replay and regenerate the
standard report without network access:

```sh
node scripts/prove-file-diet-operational-value.mjs --replay \
  docs/operational-value/proof/file-diet.json.gz --output-dir .tmp/file-diet-proof
```

The [value report](operational-value/proof/reports/daily-file-diet-definitions.md),
timeline and observations persist under `proof/reports/`. Explicit fresh
acquisition uses `--acquire NEW.json.gz` and a bounded read-only GitHub/Git
collector; it refuses to replace an existing proof index. No collector has
been scheduled and nothing is published to the upstream repository.

The [safe-output follow-up](operational-value/goal-to-measurement-paper.md#56-safe-output-execution-and-agent-handoff-follow-up)
separates File Diet's issue creation from Issue Monster's assignment requests,
actual GitHub assignment events and Copilot PR work. Five issues accumulated
44 selection comments, but only one observed Copilot assignment and one directly
connected PR. Two audited assignment jobs failed with `Bad credentials` despite
successful workflow conclusions and zero gateway errors. All seven issue
closures have explicit automatic-expiry explanations, not documented human
rejections. The candidate PR remains unmerged and has three failing final-head
unit-test checks; their cause and the reason for closing the PR are not established.

Replay the retained handoff projections separately, without changing the frozen
value-function evidence:

```sh
node scripts/trace-file-diet-handoffs.mjs --replay \
  docs/operational-value/proof/file-diet-handoffs.json.gz
```

Fresh capture uses `--acquire COHORT.json.gz NEW.json.gz`. Optional
`--audit AUDIT.json RUN_CACHE ISSUE` inputs attach allowlisted projections from
existing `gh aw audit --no-baseline --artifacts github-api --json` captures.
The collector never assigns an agent or dispatches a workflow. Timeline
pagination is bounded and marked incomplete if truncated. Selection comments,
queued requests, current editable failure-report bodies and green run summaries
must not substitute for successful safe-output execution or accepted outcomes.

### File Diet since actual adoption

The [lifetime follow-up](operational-value/goal-to-measurement-paper.md#57-file-diet-across-its-full-elapsed-lifetime)
covers November 15, 2025 through October 18, 2026, not just the recent four-week
cohort. It finds 95 issue outputs, 51 explicitly linked merged PRs, and an
immediate net reduction of 48 oversized files at those merges. Thirteen of
those structural deliveries also have retained exact workflow creation
receipts. Full behavior-preserving acceptance remains unknown; merge and file
size do not establish every required safeguard.

The **48 measured structural improvements count as workflow-enabled operational
value**, shared with the implementers and maintainers. The 13 receipt-linked
deliveries are the stronger-attribution subset, not a cap on value. Missing
functional evidence qualifies the quality claim; it does not cancel the
observed size improvement. Preserve the stricter full-acceptance measure
separately rather than changing its frozen definition.

The last qualifying linked merge is August 25; September and the observed
part of October have no such delivery. That recent decline must not be
mistaken for lifetime zero value. April and May have retained workflow runs
but no discovered issue outputs; their cause is not established. The
[monthly report](operational-value/proof/reports/file-diet-lifetime.json)
keeps these periods, repository condition, workflow-linked contribution,
receipt coverage and missingness separate.

The original policy used 1,000 lines. December 14 briefly mixed 800 and 1,000
before becoming consistent at 800 on December 15. The report retains separate
fixed 800- and 1,000-line reference curves, not a misleading mixed-threshold
trend. It never credits an unchanged surviving improvement as a fresh delivery.

Replay the complete retained lifetime evidence without network access:

```sh
node scripts/measure-file-diet-lifetime.mjs --replay \
  docs/operational-value/proof/file-diet-lifetime .tmp/file-diet-lifetime.json
node --test tests/unit/cao-operational-value-file-diet-lifetime.test.mjs
```

The report's destination directory must exist. Explicit fresh capture of this
frozen study uses new paths and a private acquisition cache:

```sh
node scripts/measure-file-diet-lifetime.mjs --acquire NEW-API.json.gz CACHE_DIR
node scripts/measure-file-diet-lifetime.mjs --inventories NEW-API.json.gz NEW_PROOF_DIR CACHE_DIR
node scripts/measure-file-diet-lifetime.mjs --runs NEW_PROOF_DIR CACHE_DIR
node scripts/measure-file-diet-lifetime.mjs --replay NEW_PROOF_DIR REPORT.json
```

The instrument is read-only, bounded to 1,000 API calls per stage, 200 issue
candidates, 100 related PRs, five timeline pages per entity and 50,000 distinct
Go blobs. API and inventory acquisition refuse replacement; execution capture
refuses to overwrite an existing execution history. Raw response caches are
local acquisition aids, not published evidence. The compressed proof preserves
projected evidence and digest-linked inventories independently of rolling
dashboard retention. No schedule, remote publication or deployment is added.

## Durable memory and reporting

[MemoryOps](https://github.github.com/gh-aw/patterns/memory-ops/) provides an
optional persistence pattern, not a prerequisite or an automatically installed
workflow. Keep the accepted evidence archive in a dedicated Repo Memory branch
when scheduled producers need durable cross-run storage. Consumers can read the
same branch and compact JSONL time series. Key observations by repository,
workflow, contract fingerprint, exact window and observation time. Bound and
rotate partitions without losing the sole accepted historical snapshot.
Actions cache (7-day retention) is only an optimization; managed comment memory
is appropriate for issue/PR-specific state, not the repository-wide archive.
Store aggregate, non-sensitive evidence and immutable references, never secrets
or personal data.

[MonitorOps](https://github.github.com/gh-aw/patterns/monitor-ops/) provides an
optional presentation pattern: summarize retained native outcomes, missing or
provisional evidence, and comparable recent movement in a durable Discussion or
another approved destination. Keep execution cost/failure diagnostics distinct
from repository outcome attainment. Repeated problems may be escalated only with
explicitly authorized safe outputs. The skill does not create Discussions,
issues, memory branches, schedules or remote runs. Those integrations require a
separate reviewed workflow change.
