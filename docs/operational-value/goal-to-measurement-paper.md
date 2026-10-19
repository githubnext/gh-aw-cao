---
title: From intent to deterministic operational value
description: A reproducible local reference benchmark for goal-first repository-outcome measurement.
---

## Abstract

Agentic workflows are usually described through natural-language goals, while
their readily available telemetry describes execution: runs, failures, cost,
and generated artifacts. These are not interchangeable measures of useful
repository outcomes. We describe a goal-first measurement method that turns
an intent source into a reviewed, deterministic outcome contract, then evaluates
accepted evidence under that fixed contract over time. Workflows and campaigns
are optional integration contexts rather than prerequisites.

We evaluate the implementation with a public, author-curated local benchmark:
ten intent cases, seven executable reference contracts, and three cases that
require clarification or additional outcome evidence. The benchmark executes
300 checks, including native arithmetic, missingness, invariance, collection,
temporal eligibility, value-review behavior, report semantics, and five seeded
scorer defects. All 300 checks pass, and all five seeded defects are detected. These results support
correctness on the specified synthetic cases. They do **not** establish automatic
intent-to-contract translation accuracy, real operational improvement, or causal
impact. The corpus, reference functions, runner, and machine-readable results
are included for reproduction and extension.

A follow-up census covers all **385 source workflows in `github/gh-aw`** at a
frozen revision. One assistant-authoring pass produces 94 executable candidate
contracts and 291 explicit outcome-design blockers. Bounded real-evidence
acquisition and two implemented independent instruments yield no established
numerical primary observation for an agentic workflow. This exposes the gap
between corpus coverage and actual outcome measurement; it does not establish
that those workflows lack value.

A separate retrospective proof connects one real agentic workflow's goal to an
executable function, an independently acquired provider failure, an Actions
creation receipt, the original repair and its merged revision. Controlled replay
shows the defect failing before the patch, passing in the original and merged
patch, and remaining fixed at four later weekly cutoffs. This establishes one
delivered repair in a selected cohort, not complete workflow value or ROI.

A full-lifetime File Diet follow-up finds 51 explicitly linked merged PRs and
48 net reductions in the oversized-file count at those merges. These measured
structural improvements count as workflow-enabled operational value with shared
implementation credit. Full goal completion, safeguards and attribution
confidence remain separate dimensions; their missingness does not erase
demonstrated improvement.

## 1. Background and problem

### 1.1 Activity is not an accepted outcome

A successful workflow run proves that an execution completed according to its
runtime rules. An opened pull request proves that an artifact was produced.
Neither alone establishes that a defect was fixed, an accessibility barrier was
removed, or documentation works on the intended devices.

GitHub Agentic Workflows' [MonitorOps pattern][monitorops] addresses scheduled
operational inspection and durable reporting, including execution health and
cost. Its [MemoryOps pattern][memoryops] distinguishes transient cache from
durable cross-run memory and describes producer/consumer sharing and time-series
storage. These patterns motivate the persistence and reporting design; they
do not supply a universal outcome metric.

Executable software benchmarks offer a complementary precedent.
[SWE-bench][swebench] separates a task statement and repository state from the
patch and tests used to establish resolution. Our method adopts the narrower
principle that an asserted outcome needs an explicit verification instrument.
We neither reuse SWE-bench instances nor compare our results with its scores.

### 1.2 Goal-first rather than campaign-first

The original operational-value authoring process was tightly coupled to CAO
campaign packaging and historical adoption analysis. This made a useful but
specialized case appear to be the prerequisite for measurement.

The revised boundary is simpler:

1. Accept a stated goal or discover an intent-bearing repository source.
2. Review and freeze a measurement contract and an executable function.
3. Collect evidence and report native outcomes over time; integrate with CAO
   or durable scheduled publication only when wanted and authorized.

Natural-language interpretation remains an authoring responsibility, supported
by the skill and subject to review. The deterministic intake helper reads and
fingerprints sources; it does not understand prose or infer the right metric.
The system is source-agnostic, not evidence-free.

## 2. Methodology

### 2.1 The measurement contract

A contract identifies a repository outcome, an eligible population, an acceptance
rule, a native formula and unit, a direction or explicit target, temporal
semantics, and admissible evidence with provenance. Exactly one metric is
primary; reliability and other guardrails remain separate rather than being
hidden inside a weighted score.

For a fixed population of eligible opportunities, an accepted-share measure is:

```text
V(t) = 100 * accepted(t) / eligible(t)
       if evidence is admissible and eligible(t) > 0;
       null otherwise.
```

Here, the Boolean acceptance indicator is supplied by the contract's evidence
instrument, not by an agent's confidence. A count can validly be zero for a
complete empty population, whereas an empty fraction has no denominator and
remains unavailable. Missing or malformed evidence is not zero.

Snapshot measures describe state at a cutoff; interval measures describe a
bounded period. This distinction must be declared rather than inferred from a
chart. Contract identity, source revision, evidence references, and quality
metadata accompany an observation.

### 2.2 Authoring and execution boundaries

The schema-v3 module exports `definition`, `collectBatch`, and `scoreMetric`.
The score function returns one finite native value or `null`, not a before/after
comparison. The collector supplies evidence for exact requested windows.

The production intake accepts prose, Markdown, or YAML without campaign
enrollment. Source text is bounded, fingerprinted, and explicitly untrusted.
Standalone definitions default to `.github/operational-value/NAME.mjs`.
An optional adapter publishes measurements through CAO; neither that adapter
nor a dashboard is required to evaluate the function locally.

Prospective measurement starts at **contract activation**. This is not evidence
that a workflow was adopted then. A historical adoption comparison instead
requires a separately justified adoption anchor and comparable historical
evidence. Changing the contract changes its identity; it must not silently
rewrite the meaning of earlier observations.

### 2.3 Comparison over time

For comparable native values, the signed delta is the current value minus its
reference. Direction-aware gain reverses that sign for a decreasing metric.
For a target metric, gain is the reduction in absolute distance to its declared
target:

```text
nativeDelta = current - reference
targetGain  = abs(reference - target) - abs(current - target)
```

A numerical difference alone is insufficient. The production timeline builder
requires complete, mature, temporally compatible observations. Recent
comparisons require adjacent periods or cutoffs with matching context and
nonstale assessment. Gaps, overlap, unknown coverage, interim evidence, stale
assessment, and future assessment make the comparison unavailable. A newer
unavailable assessment must not expose an older accepted observation as current.

A finite current observation may still be displayed with unknown coverage or
interim maturity; its comparison remains unavailable. Native values, evidence
quality, and comparison eligibility are separate outputs.

### 2.4 Persistence and presentation

Reviewed definitions live in source control. Accepted evidence belongs in the
existing fingerprint-keyed archive, with exact windows and immutable references.
A dedicated Repo Memory branch is an optional durable producer/consumer
destination. Actions cache is a disposable optimization, not the historical
authority. Bounded JSONL partitions may support sharing, but rotation must not
delete the sole accepted historical evidence.

The existing CAO dashboard is a reconstructable, bounded projection. Its rolling
Activity publication is not a substitute for durable history. A local report
or an explicitly authorized MonitorOps destination can present the same native
values, quality limitations, and eligible movement. No new storage service,
dashboard subsystem, remote run, Discussion, or deployment is needed for this
method or benchmark.

## 3. Research questions and test-set construction

This study asks three bounded questions:

1. Can the production intake preserve the supplied workflow, document, or prose
   intent without requiring campaign membership?
2. Do frozen reference contracts return the independently specified native
   values and reject malformed or missing evidence?
3. Do production temporal comparison and report generation preserve quality,
   chronology, units, and contract-activation semantics?

It does **not** ask whether a generative model can reliably infer those contracts.
That requires a separate repeated-generation experiment with independent
adjudication.

### 3.1 Corpus

The ten cases deliberately cover different input formats, outcome families,
directions, and boundaries. Six use checked-in gh-aw Markdown sources, one uses
a synthetic non-gh-aw YAML document, and three are prose-only. Seven have
executable contracts. The last three are design annotations, not automatically
predicted abstentions.

| Case | Intent source | Reference outcome | Synthetic arithmetic |
|---|---|---|---|
| Dependency security | [Dependabot planner][source-security] | Open security alerts; decrease | 8 to 0; gain 8 alerts |
| Native execution efficiency | [Token optimizer][source-efficiency] | AI Credit per successful run; decrease | 100/10 = 10 to 40/10 = 4; gain 6 |
| Accessibility | [Accessibility checker][source-accessibility] | Pages with confirmed barriers; decrease | 2 of 4 to 0 of 4; gain 2 pages |
| Documentation compatibility | [Multi-device tester][source-compatibility] | Cells passing layout and navigation; increase | 2/4 = 50% to 4/4 = 100%; gain 50 percentage points |
| Verified investigations | [Bug investigation][source-investigation] | Independently replayable accepted investigations; increase | 0/2 = 0% to 2/2 = 100%; gain 100 percentage points |
| Confirmed bug resolution | Prose-only goal | Closed, merged, regression-passing cohort defects; increase | 2/5 = 40% to 4/5 = 80%; gain 40 percentage points |
| API error reference | [Synthetic YAML fixture][source-yaml] | Native error percentage; explicit target 2% | 10/100 = 10% to 2/100 = 2%; gain 8 percentage points of proximity |
| Diagram comprehension | [Diagram workflow][source-diagrams] | Reader understanding | Unresolved: artifact checks are not a comprehension instrument |
| Engineering culture | Prose-only goal | Underspecified | Clarification needed: no population or acceptance instrument |
| Agent PR volume | Prose-only goal | Output activity only | No accepted repository-outcome rule supplied |

The existing security and efficiency modules supply production metric
definitions, scoring functions, and validation examples. The other five
executable contracts are author-written references. **All seven collectors use
synthetic snapshots**; no production remote collector is exercised.

For investigations, independent verification is a proposed instrument for the
source intent, not a claim that the workflow's existing output proves a merged
fix. The raw flags stand in for evidence that a real deployment would have to
acquire and verify.

### 3.2 Why this is a useful test set

The corpus combines count, fraction, native cost ratio, and target-proximity
functions instead of treating every goal as a normalized percentage. It includes
complete zero values, empty denominators, acceptance conjunctions, duplicate
identities, missingness, and a reopening regression. Boundary cases prevent the
paper from treating every readable goal as immediately measurable.

Expected numerical results are handwritten in `corpus.mjs`, not calculated by
the scorer under test. The before/after examples differ from the validation
examples. This provides an independent arithmetic oracle, but not independent
human authorship: the same implementation effort curated the corpus and
reference contracts.

This is a **small public development/regression set**, selected purposively
from one repository. There is no hidden holdout, random sampling, independent
annotation, or statistical estimate of generalization. Its strength is explicit,
reproducible fault coverage, not population representativeness.

### 3.3 Execution protocol

The offline runner reads each source through the production intake helper and
checks its content grounding and source digest. It materializes temporary module
wrappers, runs the production definition/collector verifier, evaluates the
reference functions, then invokes the production timeline builder, report
renderer, and artifact validator. Temporary files are removed after execution.
It makes no remote API calls and uses no generative model.

Seven contracts each receive eleven temporal scenarios: improvement,
deterioration, missing current evidence, unknown coverage, interim maturity,
gap, overlap, stale assessment, future assessment, a newer unavailable
assessment for the same period, and an explicit historical reference. The target
case also approaches its target from below and departs below it, distinguishing
target proximity from simple minimization.

Synthetic activation is October 1, 2026, with nominal cutoffs October 8 and
October 15. Dates are fixture coordinates, not observed repository events.
All-zero and repeated-one commit hashes are synthetic schema sentinels in
temporary definitions, not adoption evidence. Historical-reference tests prove
comparison mechanics only.

Metamorphic probes vary actor labels, output counts, opportunity ordering, and
repeated calls without changing accepted evidence. Five seeded scorer defects
model missing-as-zero, output-volume substitution, arbitrary normalization,
native-value clamping, and ignoring a required regression gate. A defect is
detected when it disagrees with a handwritten expected value. These are targeted
probes, not exhaustive mutation testing.

## 4. Worked example: confirmed bugs over time

The prose goal is “Resolve the fixed cohort of confirmed bugs without introducing
regressions.” The cohort is fixed at five defects. A defect counts only if it is
closed as completed, its linked fix is merged, and required regression checks
pass. The fixture encodes these as three Boolean gates.

| Defect | First cutoff: closed / merged / regression passed | Accepted | Second cutoff: closed / merged / regression passed | Accepted |
|---|---|---|---|---|
| A | true / true / true | 1 | true / true / true | 1 |
| B | true / true / true | 1 | true / true / true | 1 |
| C | true / true / false | 0 | true / true / true | 1 |
| D | false / false / false | 0 | true / true / true | 1 |
| E | false / false / false | 0 | false / false / false | 0 |

The first accepted count is 1 + 1 + 0 + 0 + 0 = 2. Dividing by the fixed
denominator and multiplying by 100 gives 2/5 × 100 = **40%**.
The second accepted count is 1 + 1 + 1 + 1 + 0 = 4, giving
4/5 × 100 = **80%**.

The native delta is 80 − 40 = **+40 percentage points**. Because higher is better,
direction-aware gain is also **+40 percentage points**. This is not a 40% relative
increase and does not attribute the movement to an agent.

If B reopens, it fails the conjunction even if its fix remains merged and tests
remain green. Accepted count becomes 3, so the value is 3/5 × 100 = **60%**.
The additional arithmetic fixture checks this value; it is not a third live
observation. A closed defect without regression proof counts as zero accepted
opportunities when the evidence establishes the failed gate. Unavailable
regression evidence instead requires missingness rather than an asserted
Boolean result.

If the next assessment is unavailable, its value is **`null`**, not 0% and not
the previous 80%. Likewise, an empty cohort cannot produce a percentage. Adding
1,000 generated PRs or changing the actor labels leaves every value unchanged.

For the target case, 10% to 2% reduces target distance from 8 to 0 percentage
points, yielding gain +8. Moving from 0% to 2% increases the raw error percentage
by 2 points but reduces distance to the explicitly chosen target, yielding gain
+2. This unusual reference is deliberate: if a real goal means “at most 2%,”
it needs a decreasing/threshold contract rather than this symmetric target.

## 5. Results

The recorded run used Node.js v25.0.0. The [machine-readable receipt][receipt]
contains all individual expectations and actual outputs, category totals, and
SHA-256 fingerprints for the corpus, driver, reference modules, source
documents, skill contract, and helpers.

| Check family | Passed / total | What the result establishes |
|---|---:|---|
| Intent-source acquisition | 10 / 10 | Supplied prose or source grounding survives bounded intake; document digests match |
| Module interface | 7 / 7 | Reference modules pass production definition and synthetic-collector verification |
| Native scoring | 67 / 67 | Declared arithmetic, missingness, malformed input, and case-specific boundary expectations hold |
| Invariance | 25 / 25 | Tested actor/output changes, applicable row permutations, repeated scoring, and unchanged module files preserve results |
| Collection | 21 / 21 | Synthetic batches preserve order, repeat identically, and leave unknown cutoffs missing |
| Temporal comparison | 79 / 79 | Tested current values, comparison statuses, native deltas, gains, and historical-reference availability match expectations |
| Value review | 79 / 79 | Native current values survive reporting; missing keep bars remain unrated and costs are never invented |
| Report semantics | 7 / 7 | Production reports validate and include intent, acceptance, and contract-activation labeling |
| Seeded mutation probes | 5 / 5 | Each specified faulty scorer is distinguishable from the expected native result |
| **Total** | **300 / 300** | **No failed checks in this fixed local benchmark** |

A check is a runner-defined assertion; some compare several related fields.
Checks are correlated, and this total is not a count of independent tasks or
statistical trials. The seven production artifact-validator invocations also
succeed but are not counted as separate assertions.

The three design-only cases are successfully read, not automatically classified.
No precision, recall, abstention rate, causal effect, production savings, or
model-comparison result can be inferred from this table.

### 5.1 Full external workflow census

A subsequent [complete `github/gh-aw` census](gh-aw-census.md) extends the
study to **344 agentic and 41 native source workflows** at an immutable revision,
with five real historical cutoffs and a bounded run/artifact inventory for every
source. Every workflow has a source-grounded contract proposal or an explicit
outcome-design blocker. Candidate proposals are not independently validated
semantic gold.

The census does not convert abundant runtime metadata into outcome evidence.
Only a narrow native changed-source/lock guard yields numerical observations;
four of its five zeros have no eligible changed sources. Retained Go unit-test
artifacts contain 11 started cases without terminal events, so the complete
regression score remains unavailable rather than being reported as zero
failures. No agentic workflow has an established numerical primary value under
the implemented instruments.

This full-corpus result strengthens the missingness and coverage analysis, not
the claim of translation accuracy or demonstrated benefit. The companion
report distinguishes unresolved designs, unimplemented independent collectors,
historical source absence, and incomplete or unavailable evidence.

### 5.2 Tracking-linked downstream outcomes

A subsequent read-only follow-up uses exact run references and stable GitHub
identities to revisit work after publication. This demonstrates a reconstruction
path not implemented in the original artifact-focused census: run artifacts
can disappear while downstream PRs, merge commits and issue timelines remain
queryable.

The bounded oldest-created cohort begins with 200 of 5,605 repository/body
search candidates in the study interval. After explicit scope and identity
checks, the final snapshot independently verifies **184 run references across
108 workflow identities**. It records **three merged PRs, two closed unmerged
PRs and 179 closed issues with reason `NOT_PLANNED`**. The merge latencies are
34.66, 28.41 and 19.20 hours; these are native elapsed-time diagnostics, not
estimates of time saved. Closed issues with reason `NOT_PLANNED` cannot be
treated as completed repository work.

The implementation separates original-workflow markers from later contributor
footers, resolves old run-only markers through actual execution paths, retains
explicit graph edges and supports later acquisition from preserved identities.
The [census companion](gh-aw-census.md#tracking-based-downstream-follow-up)
contains concrete PRs, arithmetic, acquisition bounds and replay commands.

This selected, exploratory follow-up is not an exhaustive output census or a
new primary measurement. All five PRs have successful current-head check
rollups, but required regression acceptance at the merge revision is not
established. Editable footers are not authoritative creation receipts; graph
association is not causal attribution. The original historical primary
assessments remain unchanged.

### 5.3 From measurement to a keep/change review

The lean authoring skill now produces a native value review through the same
function, timeline and Markdown report, not a second scoring system. It
separates actor-independent repository attainment from an optional diagnostic
for independently accepted workflow-linked contributions. A fixed native keep
bar and review duration can support a repeatable recommendation; absent a bar,
the result remains `not-rated`.

The separate delivery regression example uses two distinct weekly cohorts of
five eligible defects each. Repository attainment rises from 40% to 80%, while the independently accepted workflow-linked
subset rises from one to two defects. Under the **illustrative synthetic**
owner-agreed bar of at least one linked accepted defect in each of two complete
weekly periods, it produces `keep-candidate`. This is neither an empirical
workflow result nor a universal recommended threshold.
Unlike the fixed-cohort snapshots in section 4, these are non-overlapping
delivery intervals: an old accepted fix does not earn fresh contribution credit
just because it stays closed.

Separate focused tests cover all-period attainment and misses, mixed evidence,
repository-only bars that cannot grant workflow credit, malformed policies,
missing or zero opportunities, provisional/stale/future evidence, gaps,
overlapping intervals, newer unavailable assessments and report tampering.
The production verifier also requires the selected review metric to return
null for missing or malformed evidence. A poor-value recommendation cannot
authorize disabling a workflow.

The local benchmark adds 79 report-level checks over the existing temporal
scenarios, bringing the reference receipt from 221 to **300 checks**. Those
checks verify native current values, absence of invented keep bars and absence
of invented costs; they do not provide new semantic-validation samples.
Outcome-matched costs remain explicitly unmeasured. Stable workflow/evaluator
identity, exact periods and native accepted quantities allow a future cost
instrument without inventing dollars, human time saved or a universal score.

### 5.4 Real goal-to-function-to-evidence proof

We now close the missing acceptance link for one deliberately selected case:
`daily-rendering-scripts-verifier`. Its pinned workflow goal is to validate
engine-specific log parsing and rendering and create fixes when needed.
The earlier census had already proposed fixture-relative parser conformance.
This narrower real-input instrument checks a concrete invariant: **an observed
provider failure must survive normalization and appear in the rendered summary**.
It does not use the workflow's own test verdict or successful run conclusion.

The evidence chain is:

1. **Goal:** the workflow source at
   `d3915e4a21040c00a6e11e1acb0aac42605abc4c`, preserved with its SHA-256.
2. **Independent input:** run
   [35497537350](https://github.com/github/gh-aw/actions/runs/35497537350)
   contains an empty-content provider-failure turn with `model_not_supported`.
   We preserve only its allowlisted diagnostic projection, plus the original
   artifact and transcript hashes; no run prompt or actor identity is retained.
3. **Creator connection:** the `safe-outputs-items` artifact of verifier run
   [35497567942](https://github.com/github/gh-aw/actions/runs/35497567942)
   records creation of
   [github/gh-aw#62155](https://github.com/github/gh-aw/pull/62155).
   Its repository, PR node ID, artifact digest, run identity and execution
   source match independently acquired GitHub metadata. This is an Actions
   safe-output result receipt, not an editable PR footer.
4. **Original repair:** the first PR commit,
   `e7ffb1202787a9594837bc90e987fda683da24f8`, is based directly on the
   creating run's source revision,
   `ff2eccd10a30d6a7bfaf0da449194e907a206555`.
   The same input fails both checks at that parent and passes both in the
   original commit, before later contributors' changes.
5. **Acceptance and persistence:** the actual merge revision,
   `7c2a123b7b0f16f19440bcde72da505ad65352b9`, also passes. Replaying the
   frozen input at five weekly main revisions tests whether the repair persists.

The importable schema-v3 function is
`tests/fixtures/operational-value-proof/rendering.mjs`. Its primary native value
is `100 * faithfully preserved cases / eligible observed cases`, regardless of
who changed the code. A separate diagnostic counts the receipt-linked accepted
repair only in the seven-day window containing its merge, and only while the
cutoff revision passes. Keeping the same fix does not generate another delivery.

| Retrospective replay cutoff, UTC | Primary conformance, percent | New receipt-linked repairs in window |
|---|---:|---:|
| September 19, 10:16:09 | 0 | 0 |
| September 26, 10:16:09 | 100 | 1 |
| October 3, 10:16:09 | 100 | 0 |
| October 10, 10:16:09 | 100 | 0 |
| October 17, 10:16:09 | 100 | 0 |

Each percentage has exactly one eligible real-input case: `0 / 1 * 100 = 0`
before the repair and `1 / 1 * 100 = 100` afterwards. The repair merged on
September 21 at 18:42:00 UTC, inside September 19–26, so its delivery count is
one in that window and zero in the other windows **for this selected cohort**.
Those zeros say nothing about other work the workflow may have delivered.

The [preserved proof index](proof/rendering.json.gz) references digest-checked
source partitions. It includes the minimal input, creation receipt, immutable
parser sources and dependencies with the upstream MIT license, PR/run identities,
and exact replay results. The pure parser is exercised with its real helpers;
the unused Actions I/O entry point is disabled. Both historical result events
and newer canonical session error/result events are recognized, so a data-format
migration alone is not classified as a lost diagnostic.
The production module verifier, timeline builder, renderer and artifact validator
produce the [value report](proof/reports/daily-rendering-scripts-verifier-definitions.md)
and adjacent timeline JSON without CAO publication or network access.

This is **retrospective and selected after a known merge**, not a pre-registered
or blinded test of automatic intent translation. The contract was activated on
October 18. Earlier cutoffs are controlled replays on a later-discovered input,
not claims that this cohort or these measurements were known at those dates.
The original census results remain unchanged. We establish a concrete functional
repair, creator connection and retained conformance, not all required CI checks,
deployment benefit, complete workflow coverage, savings, causal workflow impact
or economic break-even. Without an agreed keep bar, the report is `not-rated`;
costs remain `not-measured`.

### 5.5 File Diet: correct detection, an unmerged proposal, no established delivery

The user-selected `daily-file-diet` case tests a different outcome: identifying
oversized production Go files and promoting behavior-preserving decomposition.
The pinned workflow defines the threshold itself: regular non-test Go files under
`pkg/` are oversized at **800 or more lines**, using `wc -l`. Below 800 is healthy.
Its declared output is a refactoring issue, not an automatically merged fix.
Its proposed refactor acceptance requires new files below 500 lines, passing
`make test-unit`, `make lint` and `make build`, at least 80% new-file coverage,
and an unchanged public API.

We established that source-defined instrument before acquiring this case's
results. The primary function counts distinct eligible files meeting the
800-line condition at each immutable repository revision, regardless of actor.
It is a structural outcome, **not proof of maintainability or preserved behavior**.
A diagnostic counts receipt-linked issues that actually identify a largest
oversized file at the producing run's exact revision. A separate diagnostic
credits only completed, merged refactors with all independent safeguards
established. Missing required acceptance evidence yields unknown, not success.
The importable function is `tests/fixtures/operational-value-proof/file-diet.mjs`.

The acquisition reconstructed complete Git inventories at five weekly main
revisions, all seven producer revisions, and the downstream proposal's head.
Every distinct raw Go blob's SHA-1 identity was verified; its byte-counted newline
total was independently compared with system `wc -l`: **2,845 distinct blobs**.
An unterminated final line does not add a newline. Generated production Go is
included; test files, non-Go files and symlinks are excluded. GitHub acquisition
used 32 requests within a 120-request budget.

| Replay cutoff, 2026 UTC | Eligible files | Files at or above 800 lines | New correctly targeted issues | New accepted linked refactors |
|---|---:|---:|---:|---:|
| September 19, 10:16:09 | 1,374 | 40 | 0 | 0 |
| September 26, 10:16:09 | 1,381 | 42 | 2 | 0 |
| October 3, 10:16:09 | 1,413 | 45 | 2 | 0 |
| October 10, 10:16:09 | 1,496 | 49 | 2 | 0 |
| October 17, 10:16:09 | 1,575 | 53 | 1 | 0 |

For example, the last primary calculation visits all 1,575 eligible paths,
assigns one when the preserved newline count is at least 800 and zero otherwise,
and sums those indicators: **53 files**. The previous cutoff gives 49, so the
latest movement is **four more oversized files**, while the full observed
movement is `53 - 40 = 13`. These are repository-wide structural changes, not
changes causally attributable to File Diet. Contributions use non-overlapping
seven-day windows and only the selected issue cohort. The initial row is the
starting repository snapshot; its contribution zeros follow from the cohort
starting there, not a claim of no earlier workflow activity.

The exact-marker search found nine items. Seven were the source-declared
`[file-diet]` refactoring issues; two failure/terminal-output alerts were excluded.
All seven have verified Actions `create_issue` receipts and correct targets:
[github/gh-aw#62653](https://github.com/github/gh-aw/issues/62653),
[github/gh-aw#63443](https://github.com/github/gh-aw/issues/63443),
[github/gh-aw#64012](https://github.com/github/gh-aw/issues/64012),
[github/gh-aw#64770](https://github.com/github/gh-aw/issues/64770),
[github/gh-aw#65858](https://github.com/github/gh-aw/issues/65858),
[github/gh-aw#66888](https://github.com/github/gh-aw/issues/66888), and
[github/gh-aw#68437](https://github.com/github/gh-aw/issues/68437).
The first six repeatedly identify `pkg/cli/add_workflow_resolution.go` at
1,214 lines; the last identifies `pkg/cli/token_usage_subagent_session.go` at
1,427 lines. Each was a largest eligible file at that run's revision.

Following ordinary PR cross-references, not just explicit closing links, reveals
an actual attempt: issue 64770 is referenced by
[github/gh-aw#64854](https://github.com/github/gh-aw/pull/64854),
“Split workflow resolution into focused modules.” Its immutable head reduces
the original file to **370 lines** and introduces production files of **331,
147, 226 and 181 lines**. Those sizes meet the proposed structural limits.
However, the PR is **closed without merging**, so it earns no delivered-refactor
credit, irrespective of its plausible implementation or any passing checks.
We do not fabricate test, coverage, lint, build or API acceptance.
The original 1,214-line file remains unchanged at all five main cutoffs.

At the October 18 follow-up, all seven issues are closed `NOT_PLANNED` and none
has an explicit closing PR. Those are acquisition-time graph facts, not states
retroactively assigned to every earlier cutoff. Thus the evidence establishes
**seven correct detections, one connected but unmerged proposal, and zero
established accepted refactors in this cohort**. It does not establish zero
benefit everywhere, that the workflow caused the backlog to grow, or that a
workflow tasked with creating issues failed its own output contract. It
distinguishes successful task conformance from demonstrated downstream delivery.

The [proof index](proof/file-diet.json.gz) links complete compressed inventories,
Git blob identities, source intent, graph observations, proposal metadata and
creation receipts. Offline replay reaggregates preserved complete per-file
counts; independently rechecking raw source bytes requires reacquiring those
immutable Git objects. Unlike the rendering capsule, it does not archive all
source text. Compact report evidence carries the per-file count vectors and
inventory digests rather than duplicating full paths and blob metadata.
The production pipeline produces the
[File Diet value report](proof/reports/daily-file-diet-definitions.md)
and adjacent observations/timeline. Without an agreed keep bar the result remains
`not-rated`; matching costs remain `not-measured`. This retrospective,
human-reviewed case does not validate automatic goal translation or establish
causal workflow value.

### 5.6 Safe-output execution and agent handoff follow-up

Reinvestigating the same seven issues changes the interpretation of the
bottleneck, **not the accepted-refactor count**. The earlier graph projection
retained cross-references and closure but not assignments, connected subjects,
Copilot work events or expiry explanations. The supplementary
[handoff archive](proof/file-diet-handoffs.json.gz) preserves those bounded
REST timeline projections, final-head check results, and allowlisted evidence
from two pinned `gh aw audit` captures. The original File Diet proof and
its measurement function remain unchanged.

The source separates producer and consumer. File Diet imports
`shared/daily-issue-base.md` with a `cookie` label and `expires: 2d`; the bundle's
default assignee list is empty. Issue Monster separately searches eligible
cookie-labeled issues and requests Copilot assignment. At the exact revision of
run 36868583966, `58d82e5e33cba7a0abf6e7c57bc3b62197cbb176`, its
`assign-to-agent` safe output allows Copilot and sets `ignore-if-error: true`.
Declaring or queueing that operation is not evidence that GitHub accepted it.

| File Diet issue | “Selected for Copilot” comments | Observed Copilot assignments | Directly connected PRs | Explicit automatic expiry |
|---|---:|---:|---:|---|
| 62653 | 6 | 0 | 0 | yes |
| 63443 | 3 | 0 | 0 | yes |
| 64012 | 12 | 0 | 0 | yes |
| 64770 | 10 | 1 | 1 | yes |
| 65858 | 0 | 0 | 0 | yes |
| 66888 | 0 | 0 | 0 | yes |
| 68437 | 13 | 0 | 0 | yes |

Thus there are **44 selection/assignment-claim comments on five issues**, not
44 established assignments. All seven visible issue timelines were completely
paginated within the bounded acquisition. These are observed events and direct
connections, not an exhaustive search for every indirectly related change.
Six issues repeat the same unchanged target, so seven correct reports also
must not be described as seven distinct structural problems.

For issue 64770, the evidence is unusually specific:

1. Issue Monster run
   [36868583966](https://github.com/github/gh-aw/actions/runs/36868583966)
   queues `assign_to_agent` for that issue. Its safe-output job reports an
   authentication/permission failure with **Bad credentials**, skipped under
   `ignore-if-error=true`. Nevertheless the run conclusion is `success`, with
   zero agent and gateway errors in the audit summary.
2. The last selection-comment run,
   [36934343299](https://github.com/github/gh-aw/actions/runs/36934343299),
   likewise fails assignment at **22:25:20 UTC on October 1**. The comment and
   queued safe output cannot be promoted to a successful handoff.
3. An actual Copilot assignment appears at **22:30:11**, with a user-account
   actor. A user account may represent a person or automation using that
   account; this does not establish a manual intervention or successful
   execution by the failed Issue Monster run.
4. Copilot creates PR 64854, and an explicit connected event appears at
   **22:31:02**. Its timeline contains Copilot work-started/work-finished events.
   Those establish agent activity, not independent functional acceptance or
   separate delivered refactors.
5. At the preserved final head,
   `335787d8ed9d3f5d48d026739c04ac59b12096fb`, three check runs fail:
   `Unit tests (A-C)`, `Unit tests (D-G)` and `Unit tests (N-R)`.
   Build and several other checks pass. We do not establish whether the failed
   tests were caused by the refactor, and we do not infer why the PR was closed.
   The PR closes unmerged on October 2 at **00:14:49**.
6. The original issue closes on October 3 at **14:19:21**, with an explicit
   GitHub Actions comment explaining that it expired. **All seven**
   `NOT_PLANNED` issue closures have such expiry explanations; these are not
   seven documented human rejections of the suggestions.

Fourteen assignment-failure reports are cross-referenced from the cohort, and
their current error lists report bad credentials. They are not immutable
per-attempt ledgers: some current bodies name different issues than the
earlier cross-reference. A missing issue number in a current report body does
not erase an earlier reference or prove that its assignment succeeded.
Likewise, the ordinary reference from semantic-analysis issue
[github/gh-aw#64384](https://github.com/github/gh-aw/issues/64384)
merely contrasts issue-title prefixes while discussing different files; it is
not a File Diet implementation handoff.

The appropriate evidence funnel is **created output -> requested handoff ->
executed assignment -> agent work -> candidate PR -> accepted result**,
retaining failure, expiry and unknown states at each transition. Keep the
originating detector, routing workflow and implementing agent separate.
In this cohort, correct detection is established; an authentication failure is
directly established for two audited routing attempts; one later agent
assignment and candidate PR are established; accepted delivery remains zero.
This is stronger evidence of a downstream handoff/acceptance bottleneck, not
evidence that File Diet's detection is useless or that every unassigned case
has the same cause.

### 5.7 File Diet across its full elapsed lifetime

The four-week cohort above is not a lifetime assessment. A separate read-only
capture covers **November 15, 2025, 13:36:21 UTC through October 18, 2026,
11:54:09 UTC**. Both the source and compiled workflow were introduced at
`1186030a620f4113f655c156bedf70cf2c164f79`; its first parent is
`fc43d399fbe304278d3920906b90413db31184b8`. The first referenced run started
23 seconds after introduction and the first discovered output was
[github/gh-aw#4058](https://github.com/github/gh-aw/issues/4058).
Contract activation in October is not workflow adoption.

The historical goal was not constant. The introduction required **1,000-line**
files. On December 14 at 12:43:11 UTC,
`9c55cedfa6a493259d84bd5a23ab073e086e501b` changed the healthy threshold to
800 but retained 1,000 in issue-creation instructions. On December 15 at
17:52:23 UTC, `8fa8a6d9d069b077feba922add936394c014c800` consistently used
800. The transitional source is ambiguous, not retrospectively assigned one
threshold. All 58 source revisions were inspected. A temporary campaign phase
in December does not make campaign enrollment a prerequisite for measurement.

Five completely paginated searches discover **95 surviving File Diet issue
outputs**, referring to **54 distinct production-Go paths**, plus related and
excluded items. One output is explicitly titled `[file-diet] test`, with no
production-Go target; output volume is not useful detection. The acquisition
validates 94 producer-run references; one returns HTTP 404. GitHub confirms
that the historical `githubnext/gh-aw` name redirects to the same immutable
repository ID, `1036865607`, as `github/gh-aw`, before accepting that alias.
All 95 issue REST timelines fit complete pagination. Related PR expansion is
bounded to one hop: **73 candidate PRs**, of which 57 merged. Six of those
merges have no qualifying explicit File Diet issue link and receive no
workflow contribution credit.

The [lifetime proof index](proof/file-diet-lifetime/proof.json.gz) links
**274 complete Git inventories**. Acquisition verified Git blob identities
and independently checked all **13,236 distinct raw Go blobs** against
`wc -l`. Thirteen snapshots cover adoption, every subsequent UTC month boundary,
and the final partial month. The same existing `scoreMetric("oversized", ...)`
function calculates the fixed 800-line reference throughout; a separately
labelled 1,000-line curve preserves comparability with the original goal.
These reference curves do not imply the 800-line policy existed at adoption.

| Period, UTC | Retained runs | Issue outputs | Explicitly linked merged PRs | Immediate net reduction in 800+ files at those merges | 800+ files at period end |
|---|---:|---:|---:|---:|---:|
| November 15–30, 2025 | 16 | 5 | 1 | 0 | 19 |
| December 2025 | 35 | 14 | 10 | 8 | 18 |
| January 2026 | 26 | 16 | 11 | 11 | 13 |
| February 2026 | 23 | 10 | 2 | 2 | 14 |
| March 2026 | 34 | 7 | 6 | 6 | 22 |
| April 2026 | 22 | 0 | 0 | 0 | 24 |
| May 2026 | 22 | 0 | 0 | 0 | 32 |
| June 2026 | 21 | 2 | 1 | 1 | 37 |
| July 2026 | 25 | 15 | 10 | 10 | 33 |
| August 2026 | 21 | 14 | 10 | 10 | 29 |
| September 2026 | 23 | 8 | 0 | 0 | 43 |
| October 1–18, 2026 | 12 | 4 | 0 | 0 | 53 |
| **Total** | **280** | **95** | **51** | **48** | — |

November and October are partial periods. All execution counts enumerate
**currently retained metadata**, not every execution that ever occurred.
One referenced run is absent from that enumeration; a complete lifetime run
denominator remains unknown. April has 22 successful retained runs, and May has
21 successes and one failure, despite no discovered issue outputs. Those
periods cannot be called inactive or credited as successful inspections merely
from run conclusions; their output-free cause is not established.

For contribution, the evaluator requires a current explicit closing reference
or an observed connection that had not been disconnected before merge.
An incidental cross-reference or matching PR title is insufficient. It then
compares each target at the merge commit's **immutable first parent** and the
merge commit, not the mutable base-branch SHA returned in current PR metadata.
Delivery is counted only in its merge period, with duplicate issue reports for
the same PR and target deduplicated.

Of the **51 explicitly linked merged PRs**, 49 linked targets become smaller
than 800 lines or disappear. However, the immediate repository-wide net decrease
at these merges is **48 oversized files**, not 49:

- [github/gh-aw#4059](https://github.com/github/gh-aw/pull/4059) reduces
  `frontmatter.go` from 1,907 to 1,165 lines. This is real partial structural
  progress, but it does not eliminate an oversized file.
- [github/gh-aw#6094](https://github.com/github/gh-aw/pull/6094) reduces
  `logs.go` from 1,620 to 1,339 lines, also remaining oversized.
- [github/gh-aw#6145](https://github.com/github/gh-aw/pull/6145) reduces the
  original `safe_outputs.go` to eight lines but introduces
  `safe_outputs_config.go` at 1,024 lines. Retiring the original path is
  **not** a net reduction in oversized files.

This distinction prevents “merged” and “target path disappeared” from becoming
success-shaped proxies. Thirteen linked merged PRs have a new or renamed
production file at least 500 lines long and therefore do not satisfy that
size safeguard. The lifetime capture does not independently establish all
historical tests, lint, build, new-file coverage and public-API preservation.
The full behavior-preserving acceptance quantity remains **unknown**, not zero
and not 51.

Creation attribution has its own coverage. **32 outputs retain exact
safe-output creation receipts**, including the test output. Thirty satisfy
the strict largest-eligible-file targeting predicate. Another targets a real
935-line file while a 1,141-line eligible file exists: it may still be useful,
but does not satisfy “largest.” Older receipt formats lack node IDs; their
identity is checked by issue number within the verified immutable repository,
URL, artifact digest, run ID and producer revision. Newer receipts additionally
match the issue node ID. Missing receipts are not reconstructed from editable
footers.

Within that stronger-attribution subset, **13 receipt-linked merged PRs**
independently eliminate an oversized target; 11 also satisfy the measured
under-500 new/renamed-file safeguard. For example:

1. File Diet run
   [32850038837](https://github.com/github/gh-aw/actions/runs/32850038837)
   produces a retained, digest-verified `create_issue` receipt for
   [github/gh-aw#55776](https://github.com/github/gh-aw/issues/55776).
2. Copilot PR [github/gh-aw#55785](https://github.com/github/gh-aw/pull/55785)
   explicitly references that issue and merges on August 25 at 16:35:32 UTC.
3. Immutable pre-merge and merged inventories show `pkg/cli/add_command.go`
   changing from **1,129 to 248 lines**. Four new files contain
   **250, 280, 86 and 328 lines**, all below 500.
4. The fixed native function decreases by **one oversized file at that merge**.
   It receives one August delivery credit, not fresh credit every later month.
   Functional preservation and the coverage requirement remain unverified.

The last qualifying linked merge is August 25. September and the observed
part of October contain 12 new outputs but **no discovered explicitly linked
merged refactor**. That is a recent delivery decline after substantial earlier
structural contribution, not lifetime zero value. The seven-issue handoff audit
in §5.6 helps explain part of the recent chain; it does not establish a common
cause for every older gap.

Across the whole period, eligible production files grow from **216 to 1,592**,
800+ files from **16 to 53**, and 1,000+ files from **6 to 15**. Repository
growth and the 48 immediate merge-local reductions are distinct observations.
Neither estimates what would have happened without File Diet, measures
maintainability itself, or establishes exclusive causal credit. Costs remain
unmeasured and a keep/retire recommendation remains not rated.

**Operational-value interpretation:** the 48 measured native reductions are
workflow-enabled value, not progress held at zero until every other safeguard
is established. File Diet receives shared enabling credit; implementing agents
and maintainers also contribute. The 13 receipt-linked structural deliveries
are a stronger-attribution subset, not the only work with possible workflow
credit. The remaining explicit historical links are corroborated rather than
receipt-verified.

Full acceptance remains a distinct, stricter measure. A refactor that falls
short of the 500-line safeguard can still deliver a verified size improvement.
The two partial refactors above demonstrate reductions in their target sizes
without a decrease in the frozen oversized-file count; they are not credited
as threshold eliminations or retroactively assigned an invented score.
Missing functional evidence does not negate measured structure, and measured
structure does not prove functional preservation. These distinctions retain
useful workflow contribution without treating all 51 merges as equally valuable.

The [machine-readable lifetime report](proof/reports/file-diet-lifetime.json)
preserves every monthly result, issue targeting evaluation, explicitly linked
delivery, native before/after count, receipt-coverage distinction and unknown
acceptance. Replay is offline; reconstructing raw-byte counts requires Git
reacquisition. This covers the full elapsed lifetime with surviving bounded
evidence, not an assertion that deleted outputs or expired receipts were
recovered. The frozen recent proof and its conclusions remain unchanged.

## 6. Reproduction and extension

From the repository root with dependencies available:

```sh
npm run benchmark:operational-value -- --output docs/operational-value/benchmark-results.json
node --test tests/unit/cao-operational-value-benchmark.test.mjs
```

The runner exits nonzero on failed expectations or execution errors. Its receipt
does not contain random temporary paths or timing-dependent measurements. The
regression test compares the current corpus fingerprint and aggregates with the
paper's recorded receipt so changes require an explicit refresh.

The source corpus is
`tests/fixtures/operational-value-benchmark/corpus.mjs`; executable references
are in the adjacent `reference.mjs`. The driver is
`scripts/benchmark-operational-value.mjs`. Add a new family by supplying a
source or prose goal, reviewed population and acceptance semantics, an
independently calculated oracle, and adversarial temporal/evidence cases.
Do not make the oracle call the scorer being evaluated.

Replay the complete real case offline, including execution of the preserved
parser code and regeneration through the production report pipeline:

```sh
node scripts/prove-workflow-operational-value.mjs --replay \
  docs/operational-value/proof/rendering.json.gz --output-dir .tmp/operational-value-proof
node --test tests/unit/cao-operational-value-proof.test.mjs
```

A separately requested fresh acquisition uses `--acquire NEW.json.gz`.
It is read-only, bounded to 160 GitHub requests and this exact case, and refuses
to replace an existing proof index. It does not deploy or dispatch anything.
Five focused tests exercise real replay, single-credit delivery, absent creator
evidence, incomplete evidence, independent acceptance, source/receipt/result
tampering, partition round-trips and production report generation.

## 7. Limitations and next empirical study

The primary limitation is construct validity: a deterministic function can
faithfully calculate the wrong notion of “good work.” Human review must connect
intent, population, acceptance instrument, and consequences. The synthetic benchmark
assumes acceptance flags are already trustworthy; it does not run accessibility
audits, reproduce bugs, validate fixes, or acquire authoritative cost evidence.
Section 5.4 supplies independent functional replay for one real defect, not
a general acceptance instrument for all outcome families.

Synthetic collectors bypass authentication, API pagination, retention expiry,
permissions, historical reconstruction, and real evidence ambiguity. The study
does not exercise the full Activity publication or dashboard pipeline. It also
does not show that separate reliability guardrails are enforced operationally
just because a cost ratio improves.

The reference contracts and examples are visible and author-curated, so agreement
is vulnerable to shared assumptions and selection bias. The small seeded-mutant
set cannot establish resistance to gaming or broad fault detection. Native
metrics remain intentionally incomparable across outcome families; their gains
must not be added into a universal score.

A next study should freeze an independently selected, cross-repository holdout
before generation, stratified by source format, outcome family, evidence
availability, and ambiguity. Generate contracts repeatedly using recorded model
and prompt versions. Independent reviewers should adjudicate intent fidelity,
population validity, proxy misuse, warranted abstention, and collector
feasibility before running executable hidden evidence cases.

Report semantic agreement, invalid-contract rate, appropriate clarification,
determinism, missingness correctness, and collection success separately. Evaluate
real longitudinal outcomes only after stable contracts and contemporaneous
evidence capture exist. Causal attribution requires an additional design, such
as a justified comparison group or controlled intervention; before/after
movement alone is insufficient.

## 8. Conclusion

Goal-first operational value can be implemented without campaign enrollment
while retaining deterministic evidence semantics. The local benchmark
demonstrates arithmetic, temporal, and report behavior for seven explicit
reference contracts. The central unresolved research problem is not computing
the frozen function; it is reliably choosing and validating the right function
from open-ended intent, then implementing independent evidence collection.
The full external census reinforces that distinction: broad source coverage
and syntactically valid candidate functions do not by themselves supply the
missing outcome definitions or accepted longitudinal observations.
Tracking-linked follow-up supplies real downstream merge and closure
milestones, demonstrating that the collection gap is partly addressable.
Accepting those milestones as good work still requires the appropriate
independent population and outcome contract.
The selected real proof completes that chain for one observed parser defect:
real input, original creator receipt, failing parent, passing original and
merged patch, and retained correctness across later revisions. Generalizing
this result requires additional independently chosen cohorts and instruments,
not reinterpreting this one successful case as coverage of every workflow.

## References

1. GitHub Agentic Workflows. [MonitorOps pattern][monitorops].
2. GitHub Agentic Workflows. [MemoryOps pattern][memoryops].
3. Jimenez et al. [SWE-bench: Can Language Models Resolve Real-World GitHub
   Issues?][swebench] arXiv:2310.06770.
4. CAO. [Operational Value operator guide](../operational-value.md) and
   [measurement skill](https://github.com/githubnext/gh-aw-cao/blob/main/.github/skills/add-operational-value/SKILL.md).
5. This study's [results receipt][receipt], corpus, reference functions, and
   executable runner named above.

[monitorops]: https://github.github.com/gh-aw/patterns/monitor-ops/
[memoryops]: https://github.github.com/gh-aw/patterns/memory-ops/
[swebench]: https://arxiv.org/html/2310.06770v3
[source-security]: https://github.com/githubnext/gh-aw-cao/blob/main/.github/workflows/dependabot-update-planner.md
[source-efficiency]: https://github.com/githubnext/gh-aw-cao/blob/main/.github/workflows/optimization-token-optimizer.md
[source-accessibility]: https://github.com/githubnext/gh-aw-cao/blob/main/.github/workflows/self-care-accessibility-checker.md
[source-compatibility]: https://github.com/githubnext/gh-aw-cao/blob/main/.github/workflows/multi-device-docs-tester.md
[source-investigation]: https://github.com/githubnext/gh-aw-cao/blob/main/.github/workflows/bug-bash-investigation.md
[source-diagrams]: https://github.com/githubnext/gh-aw-cao/blob/main/.github/workflows/docs-explanatory-diagrams.md
[source-yaml]: https://github.com/githubnext/gh-aw-cao/blob/main/tests/fixtures/operational-value-benchmark/service-monitor.yaml
[receipt]: https://github.com/githubnext/gh-aw-cao/blob/main/docs/operational-value/benchmark-results.json
