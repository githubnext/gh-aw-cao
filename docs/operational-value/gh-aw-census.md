---
title: A complete github/gh-aw workflow census
description: Source-grounded contract proposals, real-evidence acquisition, explicit missingness, and the limits of a 385-workflow evaluation.
---

## Finding

**The expanded evidence is not sufficient to claim reliable automatic
goal-to-outcome translation or demonstrated agentic benefit.** It is stronger
evidence about corpus coverage, contract-authoring failure modes, and the
difference between available telemetry and accepted outcome evidence.

The study covers every top-level source workflow at the frozen
[`github/gh-aw` revision `d3915e4a21040c00a6e11e1acb0aac42605abc4c`][revision]:
**344 agentic Markdown workflows and 41 native Actions workflows**.
The 344 generated `.lock.yml` files are paired dependencies, not additional
independent workflows. Shared imports, templates, and examples outside the
top-level installed workflow directory are not separate census units.

Every source has a contract-design record and five explicit cutoff assessments.
An unresolved outcome definition is a recorded authoring failure, not a
successful generated function. A candidate function without an implemented
collector is not a usable production measurement. Neither is disguised as a
zero-valued outcome.

The single authoring pass produced **94 executable candidate proposals** and
**291 unresolved outcome designs**. These are proposal/abstention counts, not
94 independently validated successes.

A subsequent tracking-based follow-up reconstructs **184 run-linked objects
across 108 workflow identities**, including three merged PRs and two closed
unmerged PRs. This corrects any inference that missing run artifacts prevent
all downstream reconstruction. These are observed graph milestones, not new
primary outcome scores; see the bounded follow-up below.

## Method

### Source-grounded authoring

We pinned the source revision before authoring. Three assistant agents reviewed
disjoint source partitions; eight workflows were handled directly. Each record
identifies the goal, eligible population, acceptance instrument, native metric
or design blocker, evidence plan, limitation, and short source quotations with
line ranges. The builder verifies every quotation and source digest.

This is a single assistant-authoring exercise, **not independent annotation or
semantic adjudication**. A correct citation proves grounding, not that the
chosen contract faithfully captures all intended value. Candidates remain
proposals requiring domain review. Where an independent instrument cannot be
defensibly specified, the record explicitly needs clarification and has no
executable proxy metric.

The executable candidates use the existing schema-v3 definition, collector and
score interface. The shared factory preserves native counts, fractions or
ratios, direction and explicit targets. It does not infer scores from names,
generated PR counts, report retention, actor identity, or workflow conclusions.
Deterministic native arithmetic is not an automatic semantic oracle.

### Historical frame

The frozen endpoint is the user's request time,
**October 17, 2026, 10:16:09 UTC**. Five weekly cutoffs use that clock time on
September 19, September 26, October 3, October 10, and October 17.
For Git state we resolve the latest ancestor of the frozen revision before
each cutoff.

These are retrospective reconstructions under newly proposed contracts.
They are not pre-registered experiments or recovered adoption baselines.
Exploratory acquisition initially used commit-trigger timestamps; the final
frame instead uses the explicit request-time endpoint consistently.
No workflow is dispatched, modified, enabled, or deployed.

### Acquisition and bounds

For all 385 sources, the collector requests the latest completed `main`-branch
run created before the frozen endpoint, then at most 100 artifact metadata
records for that run. The final inventories contain:

| Acquisition fact | Result |
|---|---:|
| Source workflows accounted for | 385 |
| Matching run metadata | 352 |
| No matching completed main-branch run in this query | 33 |
| Workflows with artifact metadata | 280 |
| Artifact metadata entries | 2,265 |
| Errors in final per-workflow run queries | 0 |
| Errors in final per-run artifact queries | 0 |
| Truncated per-run artifact inventories | 0 |

The global artifact-list endpoint repeatedly returned HTTP 500, so acquisition
used per-run inventories instead. A run conclusion is observed at acquisition,
not reconstructed as historical outcome acceptance. “No matching run” does not
mean that a workflow never ran on another branch or event.

The study implements **two independent evidence instruments**, not 385
collectors. Other candidate records return an explicit
`instrument-not-implemented` assessment. This is a limitation of this study,
not proof that no suitable evidence exists anywhere. Historical source absence,
unavailable preserved evidence, partial evidence, and unresolved outcome design
are recorded separately.

## Real computed evidence

### Lightweight stale-lock guard

The native `stale-lock-files.yml` workflow declares a lightweight changed-file
guard. At each sampled Git commit, we inspect its first-parent changeset:

1. Select changed top-level workflow Markdown sources that still exist.
2. Find each source's corresponding `.lock.yml`.
3. Count a violation if that lock is absent or unchanged in the same changeset.

This implements the source-defined pair-change rule without executing upstream
scripts. It is **not** a full recompile or proof of semantic lock freshness.
The five observations are isolated sampled changesets, not weekly totals.

| Cutoff, UTC | Eligible changed sources | Guard violations |
|---|---:|---:|
| September 19, 10:16:09 | 0 | 0 |
| September 26, 10:16:09 | 1 | 0 |
| October 3, 10:16:09 | 0 | 0 |
| October 10, 10:16:09 | 0 | 0 |
| October 17, 10:16:09 | 0 | 0 |

All five native count values are zero. Four have zero opportunities and cannot
demonstrate attained work or improvement. The remaining observation establishes
only that its one changed source passes this narrow guard. No agentic-workflow
benefit follows.

### Go unit-test assertions: partial is not passing

The retained current `cgo.yml` execution exposes the five frozen unit-test shard
artifacts `a-c`, `d-g`, `h-m`, `n-r`, and `s-z`.
We download those bounded artifacts, verify archive bytes against GitHub's
SHA-256 digests, and parse Go test events. We preserve only normalized test and
package outcomes, not raw log messages or prompts.

The instrument counts top-level test cases, not both parent tests and nested
subtests. Every started test and package requires a terminal assessment.
A failed package without an interpretable failing test is incomplete evidence,
not a zero-failure result.

| Current shard | Non-skipped test starts | Observed terminal failures | Skipped | Coverage |
|---|---:|---:|---:|---|
| a-c | 3,236 | 0 | 2 | Complete |
| d-g | 2,961 | 0 | 24 | Complete |
| h-m | 1,574 | 0 | 5 | Complete |
| n-r | 2,402 | 0 | 7 | Partial: 10 started tests lack terminal events |
| s-z | 2,408 | 0 | 9 | Partial: 1 started test lacks a terminal event |

There are **12,581 non-skipped starts, 47 skipped cases, and 11 unfinished
top-level tests in the preserved stream**. The observed failure count in the
available terminal events is zero, but the complete primary score is **`null`**.
We do not repair or explain away missing terminal events to obtain a favorable
number.

For the four older selected executions, the complete required five-shard
artifact set is unavailable in the queried inventories. Those values are also
`null`. This bounded acquisition does not establish whether older evidence
expired, was never uploaded, or could be reconstructed by a different method.
It does not claim that history is fundamentally unreconstructable.

## How to read the full results

The complete census has **1,925 requested assessments**: 385 sources times five
cutoffs. Only the five narrow native guard observations are numerical.
There is **no accepted numerical primary observation for any of the 344
agentic workflows** in this study.

This result must not be stated as “344 workflows produced no value.”
It means the implemented instruments and acquired evidence did not establish
their operational value under the proposed contracts. Most candidate collectors
are not implemented; some outcomes remain undefined. The [results receipt][results]
separates these reasons and lists every workflow and cutoff.

There is no meaningful cross-workflow average or total value: native units
remain separate, and `null` cannot be averaged as zero. The count of syntactically
executable candidates is an authoring-coverage result, not a semantic success
rate. Source-grounding and deterministic scoring checks do not validate the
acceptance instrument's construct validity.

## Tracking-based downstream follow-up

On **October 18, 2026**, we added a separate, read-only graph acquisition
instrument. Tracking IDs and exact run references connect workflow activity to
stable GitHub issue/PR identities. Later state comes from GitHub, not the
agent's report or its run conclusion.

The exploratory cohort was the **first 200 oldest-created search candidates**
in the original study interval, September 19, 10:16:09 UTC to October 17,
10:16:09 UTC, end-exclusive. The bounded repository/body search reported
**5,605 candidates**. This is neither a random sample nor an exhaustive
inventory of outputs. Five candidates lacked an exact known workflow/run
identity, and eleven identified a producer in another control repository.
We did not widen collection authority to those producers.

Real footers exposed two important distinctions: a PR can retain its original
workflow marker while accumulating contributor footers, and an older footer
may identify a run without a workflow slug. The adapter separates the declared
original workflow from unverified contributor references and can recover a
missing workflow slug through the actual execution path. A tracker string or
display name alone is insufficient.

Initial and intermediate observations are retained alongside the final
snapshot. The parser was refined during acquisition, not pre-registered.
Differences in successfully resolved references between these observations
are **instrument corrections, not improved repository outcomes**.

The final acquisition spans **05:29:34 to 05:30:04 UTC** and uses 189 bounded
GitHub requests. The full 385-workflow inventory remains in its summary, with
unobserved workflows explicitly missing.

| Final follow-up observation | Count |
|---|---:|
| Objects with verified run references | 184 |
| Workflow identities represented | 108 |
| Closed issues, reason `NOT_PLANNED` | 179 |
| Merged PRs | 3 |
| Closed, unmerged PRs | 2 |
| Entity acquisition/identity errors | 0 |

**The 179 closed issues are not 179 successful resolutions.** Their authoritative
closure reason is `NOT_PLANNED`, not `COMPLETED`. None of the five PRs declares
a closing-issue connection in the acquired graph. A report cross-reference is
not a bug-resolution relationship. This is a concrete reason not to equate
closed counts, references or successful head checks with accepted good work.

The three merge milestones are real and timestamped:

| Workflow | PR | Merge time, UTC | Creation-to-merge latency |
|---|---|---|---:|
| `daily-rendering-scripts-verifier` | [github/gh-aw#62155](https://github.com/github/gh-aw/pull/62155) | September 21, 18:42:00 | 34.66 hours |
| `spec-extractor` | [github/gh-aw#62163](https://github.com/github/gh-aw/pull/62163) | September 21, 14:09:29 | 28.41 hours |
| `daily-safe-output-integrator` | [github/gh-aw#62220](https://github.com/github/gh-aw/pull/62220) | September 21, 14:09:50 | 19.20 hours |

Latency is elapsed merge time minus PR creation time, expressed in hours and
rounded only for this table. Raw seconds and commit identities are retained.
For example, `spec-extractor` has 102,262 seconds between creation and merge;
102,262 / 3,600 = 28.4061 hours. The two other tracked PRs,
[github/gh-aw#62029](https://github.com/github/gh-aw/pull/62029) and
[github/gh-aw#62146](https://github.com/github/gh-aw/pull/62146), were closed
without merging. A merge rate computed from these five selected PRs would be
descriptive of this small selected cohort only, not a workflow-wide success
rate or evidence of causal benefit.

All five PRs have an observed `SUCCESS` rollup on their current head revision.
That is not proof that a frozen set of required regression checks passed on
the accepted merge revision. Commit reverts, deployment effects and future
regressions are not collected by this instrument.

An editable footer plus an independently verified run is a **verified run
reference**, not an authoritative safe-output creation receipt. Additional
contributor markers remain unverified metadata. Ordinary cross-reference edges
are preserved but not recursively followed. Explicit closing relationships
can be followed one hop within the selected repository; the focused tests
exercise a merged PR that explicitly closes an issue, reopening, a different
closer, missing evidence and truncated histories.

The result establishes the feasibility of downstream reconstruction, including
for agentic work, and adds actual later merge/closure evidence. It does not
alter the original 1,925 historical primary assessments or establish an
accepted primary operational-value observation. Current state is recorded at
acquisition, never relabeled as state at October 17. The independent problem
cohort, required checks and maturation contract still determine whether a graph
milestone is accepted good work.

### Preserve and revisit the same objects

The index
`gh-aw-census/downstream-final-2026-10-18.json.gz` references digest-checked,
compressed entity partitions. The preceding two snapshot indexes and their
partitions are retained, with a digest chain between observations. No raw
bodies, prompts or actor identities are stored.

Offline replay:

```sh
node scripts/trace-operational-outcomes.mjs --replay \
  docs/operational-value/gh-aw-census/downstream-final-2026-10-18.json.gz
```

A later, explicitly requested acquisition can refresh the same stable entity
identities without searching again:

```sh
node scripts/trace-operational-outcomes.mjs \
  docs/operational-value/gh-aw-census/contracts.json.gz NEW-FOLLOWUP.json.gz \
  --since 2026-09-19T10:16:09Z --until 2026-10-17T10:16:09Z \
  --limit 200 --request-budget 500 \
  --previous docs/operational-value/gh-aw-census/downstream-final-2026-10-18.json.gz
```

Existing observations cannot be overwritten. Reopening events and changed
current state are retained in the new observation; a disappeared footer can
reuse the preserved reference, while conflicting provenance remains an error.
Future collectors must cover a broader cohort and independently verify
acceptance, not reinterpret this selected sample as complete workflow output.

## Reproduce

The frozen inputs are the [contract proposals][contracts] and
[preserved evidence][evidence]. Recompute the full census offline:

```sh
npm run benchmark:operational-value:gh-aw
node --test tests/unit/cao-operational-value-census.test.mjs
```

The JSON artifacts use deterministic gzip compression to stay within the
repository's per-file size limit. Normalized Go test outcomes occupy a separate
digest-checked adjacent archive, referenced by the evidence index. The reader
rehydrates that archive for offline computation. Inspect any artifact with
`gzip -dc FILE.json.gz`.

`createWorkflowValueFunction(contract, manifest, evidence)` in
`scripts/measure-gh-aw-operational-value.mjs` returns the standard definition,
batch collector, and deterministic score function for a candidate.
It rejects unresolved designs instead of exporting an always-successful proxy.
Contract fingerprints prevent cross-definition scoring.

The source-acquisition code is
`scripts/collect-gh-aw-operational-evidence.mjs`. Live acquisition requires a
separate isolated checkout at the pinned revision and authenticated read access:

```sh
node scripts/collect-gh-aw-operational-evidence.mjs CHECKOUT NEW-EVIDENCE.json
```

Do not overwrite the historical receipt with a later live acquisition and call
it the same experiment. Artifact availability and run metadata are mutable.
The frozen normalized evidence permits offline replay of the recorded result;
revalidating archive digests against GitHub remains possible only while those
artifacts are retained.

## What stronger evidence requires

The census removes hand-selection of workflow sources, but not shared authoring
bias, post-hoc design, or lack of independent semantic validation. It spans one
repository, and many sources are related smoke-test or conformance variants.
The 385 units are not independent samples from all agentic work.

The next study must independently adjudicate the candidate definitions,
resolve meaningful design blockers, implement the corresponding independent
collectors, and capture complete evidence prospectively. A cross-repository,
held-out generation experiment is still required to assess translation
generalization. Actual operational improvement requires comparable repeated
measurements; causal attribution requires an additional experimental design.

[revision]: https://github.com/github/gh-aw/tree/d3915e4a21040c00a6e11e1acb0aac42605abc4c
[contracts]: https://github.com/githubnext/gh-aw-cao/blob/main/docs/operational-value/gh-aw-census/contracts.json.gz
[evidence]: https://github.com/githubnext/gh-aw-cao/blob/main/docs/operational-value/gh-aw-census/evidence.json.gz
[results]: https://github.com/githubnext/gh-aw-cao/blob/main/docs/operational-value/gh-aw-census/results.json.gz
