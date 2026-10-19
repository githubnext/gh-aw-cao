# Operational-value module contract

The goal/outcome module is the authority for collection and scoring. Historical
reports and the standard CAO adapter import the same module. No campaign is
required. Use the existing schema version 3; do not invent a second interface.
Internal CLI helpers run through the current Node executable; copying the skill
does not require preserving Unix executable permission bits.

## Authoring versus routine execution

Interpret the goal and resolve measurement tradeoffs once when generating each
explicit contract version. That agentic work chooses native quantities,
eligibility, acceptance, evidence authority, deduplication, windows, safeguards
and any agreed policy. Implement those choices in the existing exports below.
Afterwards, authorized acquisition/harvesting, verification, collection, scoring,
comparison, rendering and replay run deterministic code without model calls.
Do not use model judgments to accept new observations or silently revise the
function. A material goal, acceptance or evidence-interface change requires a
new version with predecessors and limitations preserved.

Discovery commands supply intent candidates, not a generated native collector.
`evaluate.mjs` requires an existing reviewed module and usable evidence; it does
not implement arbitrary workflow-specific postconditions on demand. The generic
runner imports JavaScript, not a sandbox that enforces model-free behavior.
Review/test that property and pin helper/oracle dependencies explicitly: the
archive's module-file SHA-256 alone does not identify the transitive closure.
See [the operator guide's calculation pipeline](https://github.com/githubnext/gh-aw-cao/blob/main/docs/operational-value.md#internals-author-once-harvest-deterministically)
for stage boundaries, native calculations, scheduling, outputs and current commands.

## Exports

`definition` is JSON-compatible and contains:

- `schemaVersion: 3`, `slug`, `repository` (`OWNER/REPO`), `workflowName` (the
  human-readable goal or workflow label), `sourcePath` (a non-empty intent
  source reference: workflow, README, specification, or this definition itself
  for a prose-only goal). Legacy field names do not require a workflow.
- New goal definitions include `intent: { goal, acceptance, temporalAnchor }`:
  the natural-language goal, independently observable acceptance rule, and
  `contract-activation` or `workflow-adoption`. Intent guides contract design;
  it is never passed to an LLM during scoring.
- `adoption: { commit, adoptedAt, baselineCommit, baselineAt }`: immutable
  40-character Git SHAs and UTC `YYYY-MM-DDTHH:MM:SSZ` timestamps. Baseline fields
  are both null when absent. For `contract-activation`, these legacy adoption
  fields identify the frozen contract's activation revision and time, not a
  workflow installation. A prospective goal may use `attainment-only` with no
  historical reference; do not assert that history is unreconstructable without
  investigating it. Do not fabricate a commit when no immutable revision exists.
- `evaluation: { mode }`: `baseline-comparable` or `attainment-only`.
- `evidence: { key, repositories, opportunity, filters, collection,
  measurementKind, window: { durationDays, cadenceDays, maturationDays } }`:
  explicit population and collection plan, `snapshot` or `interval`, positive
  integer duration/cadence and non-negative integer maturation.
- `model: { architecture, recommendation, presentation: { label, betterLabel } }`
  and `summary: { nativeLabel }`: concise explanation and native-unit labels.
- `metrics`: unique `id`, `name`, `role` (`primary` or `diagnostic`), native
  `formula`, `direction` (`increase`, `decrease`, `maintain`, `target`), `unit`,
  and `presentation: { name, legendLabel, transform: "identity" }`.
  Exactly one metric is primary; legend labels are at most 24 characters.
  `maintain` and `target` require a finite numeric `target`.
- `validationExamples: { targetAttained, targetMissed, missing, malformed }`:
  evidence objects exercised against every metric. Attainment must be better in
  the declared direction (not always numerically higher). Missing and malformed
  primary evidence must score null.
- Optional `review`: a native keep/change policy, described below. It does not
  change scoring, grant authority or add a second module interface.
- Optional `signal: { metricId, basis }` selects an existing metric for the
  interactive pulse; basis is `repository-outcome` or `workflow-contribution`.
  Contributions must be diagnostic metrics. Without it, use the review's
  selection, otherwise the actor-independent primary. No keep bar is inferred.

`collectBatch(requests, context)` accepts an array of
`{ windowStart, windowEnd, observedAt, repository? }` requests. Starts are
inclusive and ends exclusive. It returns one `{ evidence, provenance, commit? }`
per request, in the same order. Provenance is a non-empty array of
`{ repository, kind, ref }` with immutable source references. A supplied `commit`
is a full Git SHA. `context.database` optionally identifies a canonical SQLite
snapshot; no database is required for repository-local evidence.

Use bounded canonical queries, preserved evidence or local immutable repository
facts. Do not call GitHub APIs per historical or interactive window; acquisition
belongs in a separately bounded producer, not scoring. Reuse reads across the
batch. Missing source facts produce missing evidence with a reason; inaccessible
sources or collector defects are explicit errors, not success-shaped fallbacks.
Repository-state snapshots use the last immutable commit at or before
`windowEnd`; `observedAt` is when matured evidence becomes available.

`scoreMetric(id, evidence)` returns a deterministic finite native-unit number or
null for missing/malformed evidence. It scores one window, never `{before,after}`
or improvement. Do not normalize to 0..1, clamp values, complement decrease
goals, invent weights, or tune targets to later results.

## Shared repository acquisition

Establish evidence authority before reading a source-linked target. Under a
public-only scope, verify repository metadata says public before fetching its
contents, PR bodies or trees. An authenticated API success proves access, not
public visibility or authorization. Conflicting configured and prose targets
remain an explicit authority gap; do not follow credential reach into a private
alternative or publish private responses in the evidence archive.

For a workflow batch, run the skill's `collect-output-history.mjs --until UTC
OWNER/REPO ARCHIVE` once. It pins an immutable source inventory, then exhausts
separate issue and pull-request GraphQL cursor connections without Search's
1,000-result ceiling or REST page-number limits. Do not stop at the first
post-cutoff object: imported objects can appear in approximate creation order.
Only entities created before the explicit cutoff are retained. State and
editable-marker facts are observed at acquisition, not backdated to that cutoff.

The archive contains digest-checked gzip partitions and an index, with stable
GitHub IDs, body digests, author roles and candidate references, not raw prompts,
bodies or usernames. `readOutputHistory()` verifies partitions and totals before
replay. A failed or budget-limited traversal remains incomplete; use `--resume`
with exactly the same scope. `--alias OLD/NAME` is allowed only after GitHub
confirms the same numeric repository identity. Deleted/transferred objects,
edited-away markers, comments and Discussions remain outside this instrument.

Share this acquisition, not outcome semantics. Review each frozen source goal;
implement and validate its independent native check, then export its evidence
through the same `collectBatch`/`scoreMetric` interface. An unresolved goal or
unimplemented checker is **not measured**, never a zero-value observation.
An editable marker, related PR or merge is still only a discovery candidate;
validate the actual graph, execution identity where retained, and native
before/after facts. Keep original producer and later contributors separate.

Use the File Diet evidence ladder: discover an output, follow its actual
downstream implementation, and measure the independently established native
change. Do not stop at either a proposed fix or a requirement for perfect
end-to-end attribution. An immutable before/after repository change can establish
a structural improvement without proving every behavioral safeguard or the
original workflow's exclusive contribution. Stronger creation receipts refine
attribution; their absence does not erase an already verified weaker claim.
Keep the stricter frozen acceptance metric separate and name partial facets
explicitly. Conversely, a narrower claim still needs its defining evidence:
unknown native effects cannot become accepted work through a merge, fixture,
source declaration or caller-supplied authentication flag.

Investigate the existing goal's source and policy history before defaulting to
`contract-activation`. Use a verified workflow-adoption anchor when applicable;
instrument-authoring time is not evidence that an existing goal began then.
Historical reconstruction must use contemporaneously applicable rules or an
explicit fixed-reference assessment, never silently backdated current policy.
Preserve actual unknown adoption and incompatible eras. Do not change dates just
to make a frozen-cutoff evaluation run.

Candidate descriptions are already outcome exposure. Freezing a new predicate
after reading PR bodies or result summaries is outcome-informed retrospective
authoring, even before inspecting immutable before/after bytes. Preserve that
ordering, the original frozen contract and any rejected observations. Label the
new assessment explicitly; do not claim blind or ex-ante acceptance.

For source changes, `git-evidence.mjs` acquires bounded immutable first-parent
changes and digest-checked blobs once; a versioned native oracle supplies facts,
not another scoring API. Preserve its source/toolchain identity and use the
same frozen `collectBatch`/`scoreMetric` function for every period. Test syntax
and scope handling before collection. Invalid syntax is unavailable evidence,
not an empty valid population. A structural facet does not establish every
behavior, race-safety or regression safeguard.

For native lint facets, read the actual rule, exclusions and suppression
semantics before selecting a counter. A successful pre-check can merely mean
diagnostics were captured; a printed line count can include setup failures.
Use parsed native opportunities and exact boundary fixtures instead. Preserve
raw structural burden separately from suppressed diagnostics so a new waiver
cannot masquerade as a repair. State whether replay covers all platforms or
historical build selection, retain changing opportunity counts, and do not
equate one source facet with complete lint or behavior acceptance.

Validate a checker report and its aggregation with positive and negative native
fixtures before collecting real outcomes. Field names are not semantics:
CSpell's `isFlagged: false` still describes an ordinary unknown-word diagnostic,
and jq's `//` defaults false as well as null. Execute a source-language filter
with its native interpreter rather than assuming JavaScript semantics.
For document or manifest goals, distinguish actual consumer readability from
explicit-format conformance and semantic accuracy. Preserve consumer quirks,
including permissive cases; do not silently replace them with a stricter ideal.
Count independently established before/after transitions as delivery, not every
surviving readable document again in each period.
For capability goals, freeze the operation, path, expected native bytes,
producer and independent capture for each claim. Interpret actual compound
execution without inventing standalone arguments. Preserve the source's output
projection, such as an INFO prefix, rather than fabricating unobserved bytes.
Deduplicate each delivered case within its service lifetime before assigning
disjoint periods; repeated tool calls are not repeated improvements.
Keep exact-tool conformance separate from independently captured operation
effects: a native Python filesystem read is not a `read_file` invocation.
Console-derived tool-shaped entries do not prove native arguments or returned
bytes. Likewise, a host gateway's tool listing is not agent-usable MCP or
request/response correlation when original envelopes omit the shared ID.
Resolve the effective executor before interpreting prose: command overrides and
deterministic sample replay can bypass the agent. Version historical source-era
predicates separately; an unused prompt and replay success are not output effects.
For memory goals, separate same-run readback from independently restored
cross-run bytes. Protected proof that execution never started establishes
nonattainment in that attempt, not loss or correctness of stored state.
For retrospective spelling or other dictionary-based checks, pin the complete
tool/dependency identity and one explicit reference vocabulary. Separate
unknown-word diagnostics from linguistically established defects. Preserve
source-internal waivers and mark policy-changing intervals non-comparable;
waivers are not automatically repairs.
Acquire the start of each compared interval as well as its endpoint when
policy continuity matters. Two known endpoint values alone do not establish
that continuity. Preserve the predecessor before extending evidence context;
the frozen function and established native observations must remain unchanged.

Verify adoption as an actual source/compiled-workflow addition against its real
parent. A shallow Git boundary can falsely appear to introduce every existing
file; never use that boundary or the oldest observed output as adoption.

For condition-changing workflows, acquire historical state transitions once,
not current labels or assignments backdated into old periods. Reconcile each
history with its observed terminal state. Unknown transfers, missing events and
deleted identities stay explicit. Preserve native subtotals through gaps and
keep classification correctness separate from mere label coverage. Period
counts can reference digest-checked shared event partitions rather than copying
the same events into every report.

For example-coverage goals, validate actual root-frontmatter documents against
the schema at the same immutable revision before counting native property
coverage. Prose, nested keys and invalid documents are not usable examples.
Pin parser/validator identities and prohibit remote schema retrieval. Keep
structural validity, compiler acceptance and imported-fragment support separate.
Show changing population sizes alongside coverage; snapshots are not delivery.
For operation/tool coverage, intersect authoritative registered capabilities
with their canonical configuration vocabulary. Configuration-only fields and
dynamic tools outside a frozen partial facet must not create invented gaps.
Declaration coverage, including valid disabled configurations, is not execution.
For permission examples, inspect the compiled agent-job map, not just source
frontmatter; a job-level map replaces rather than merges workflow permissions.
Keep agent grants separate from safe-output and conclusion-job grants.
Explicit configuration is not proof of token reach, MCP enforcement or live
access. Track changed intent eras: an intentional warning/failure demonstration
must not become a retrospective failure of a later successful-example goal.
Preserve known native configuration quantities but mark incompatible intent
eras non-comparable, with a visible reason rather than an invented zero.
For schema consistency, resolve references with the pinned native schema
library and keep missing targets separate from unused definitions. Definition
usage follows schema evaluation structure and references: annotation strings,
self-contained definition cycles and ignored Draft-7 `$ref` siblings do not
establish root reachability. Refuse unsupported external/resource scopes instead
of fetching schemas or reporting clean results. Do not penalize intentionally
optional properties. Local unreachability does not prove a public definition
is unused externally or safe to delete; full schema/implementation agreement
and compatibility remain separate acceptance evidence.

For generated arguments, join the actual immutable payload to its source-bound
upload receipt and independent protected consumer readback. A successful job or
an agent's explanation does not prove the arguments met the goal. When multiple
artifacts merge into one destination, require agreeing payloads unless an
independently verified merge order establishes the consumed value. Bind original
artifact/run/head identities and provider digests; preserve safe projections and
whole-payload hashes rather than raw agent prose. For date-dependent rules, pin
the source's clock context and reject ambiguous dates or producer/consumer
ordering. A configuration readback is not proof that tests or deployment ran.
Keep ineligible opportunities, unassessed receipts and verified incorrect
outputs separate. Missing history must not erase established deliveries or
manufacture a comparable trend. Before extending historical source profiles,
preserve the complete predecessor and review source differences before outcomes;
retain each actual original profile hash rather than relabeling it as current.

For explicit size budgets, reproduce the source's native command semantics:
`wc -l` counts newline characters, not rendered lines, words or an unterminated
last line. Match its exact file/glob scope, including hidden-file exclusions;
unsupported symlinks or modes are not empty files. Distinguish an `over N`
audit ceiling from stricter layout targets. Pin the native binary and boundary
probes, retain the changing population, and mark policy-changing intervals
non-comparable. Smaller files alone do not establish preserved information,
accuracy, deduplication or workflow contribution.

For formatter goals, use the pinned native formatter's fixed-point check,
not JSON reserialization or a successful command. Discover exact target paths,
configuration precedence and ignore behavior from the source. Reject executable
configuration and plugins; a closed JSON-only profile can be evaluated without
running repository code. Use native ignore semantics, preserve original and
formatted-output hashes, and distinguish invalid input from clean formatting.
Changing unrelated ignore patterns need not break comparison when native scope
checks establish the same eligible targets. Formatting conformance does not
establish semantic correctness, regression safety or successful CI recovery.
Retain whole source identities as provenance, but bind comparability to the
goal-dependent source unit: unrelated commands in a recipe need not invalidate
an unchanged measured invocation. Preserve the predecessor and every established
native observation before extending historical compatibility; genuine
configuration changes still require separate comparison eras.

Large acquisition records may use bounded, digest-checked archive parts.
Partitioning must reconstruct identical facts without changing contract identity,
observation timestamps or scores; corrupted, missing or unsafe parts fail closed.
Timelines and version-keyed evidence archives use that same portable JSON codec
when a plain or compressed file exceeds 256 KiB. Read them through `readJson`
from `scripts/common.mjs`, not direct `JSON.parse`; preserve every referenced
part when copying a report. The evaluator publishes parts before their manifest
and resumes from the same accepted snapshots without reacquisition.
Interval evaluations use cutoff-aligned, non-overlapping cohorts. A leading
partial cohort retains early observations without inventing a full period.
Maturation shifts every cohort consistently. When report cadence exceeds the
measurement duration, the intervening gaps prevent a complete-history claim.
Earlier overlapping evaluation windows remain in the evidence archive; they
are not reintroduced into the current delivery series or added into totals.
Snapshot sampling retains its original cadence and historical observation times.
Use explicit `--refresh` to reacquire the selected function's currently scheduled
observations from its collector. This does not waive archive integrity checks or
discard accepted historical observations. Large predecessor closures can be sealed as digest-checked
packed archives rather than silently truncating files at a copy-count limit.

The repository's `collect-workflow-value-graph.mjs` seeds graph follow-up from a
validated retained inventory instead of repeating Search or fabricating a prior
archive. Explicit downstream graph evidence can corroborate native improvement
when a run receipt has expired; it must not be promoted to creation proof.

For host-verified monitoring, distinguish actual assertions from successful
runs. A protected checker report supplies individual outcomes. An authoritative
successful assertion-step record can prove a conjunction only after checking
the exact reviewed script, protected environment and absence of tolerated
failures; an overall job/agent conclusion cannot. A failed conjunction does not
identify which assertion failed. Keep unknown decompositions unknown and retain
independently demonstrated partial cases. Follow legitimate dispatch branches,
including immutable work-queue references, rather than filtering on branch name.
Inspect conditional returns: a successful negative-control or skipped branch
does not establish positive capability. Bind the selected branch to an
independent protected producer receipt, not agent-authored output. Pin the
selection policy and log decoder in the exported definition; preserve only
allowlisted assignment facts, step metadata and digests, never whole agent logs.
Missing or expired selector evidence remains unknown. When historical checker environments
differ, review and pin complete coherent source profiles; never combine a job
from one version with another version's dependencies. Explicitly version the
expanded contract and retain its previous definition and observations unchanged.
Include accepted source/profile identities in the exported definition, not only
closure variables: historical evaluation can reuse observations for equal
definitions. Coverage must verify current evaluation provenance and actual native
values, not just the producer's positive-proof count.

For durable-memory goals, inspect the authoritative Git-backed records rather
than disposable caches or an agent's status report. Replay through the pinned
production decoder/materializer, then independently compare expected native
fixtures against actual read-only rows. Preserve a safe bounded fixture/source
closure for offline replay. Distinguish replayable repository state from proof
of historical agent use, and scope unsupported formats, other memory operations
and branch recreation explicitly.

For freshness goals, compare immutable source pins to independently dated
official publications, not today's mutable `latest` tag. Use native semantic
version ordering, real timestamp arithmetic (including subsecond boundaries),
and any source-defined release cooldown. Freeze the tool cohort: absent earlier
tools or publication evidence must not manufacture an improving trend by
shrinking the denominator. Expose partial evidence separately, and do not equate
currency with compatibility or exclusive workflow contribution.

For npm, compare actual direct lock pins, not declaration lower bounds; require
manifest and root-lock declarations to agree and validate supported ranges.
Retrieve missing immutable blobs explicitly with bounded requests and verify
their Git identity before retention; disable implicit partial-clone fetches.
State the release-reference policy precisely: the greatest numeric stable
publication can belong to an older package lineage and is not necessarily an
actionable upgrade or a historical `latest` channel. Preserve that limitation
instead of silently retuning the frozen comparison after seeing results.

For visual-layout goals, freeze the renderer, browser, platform and geometry
predicate before measuring. Use actual native element/section rectangles,
count affected documents separately from nested offending elements, and retain
source identities (including hash-verified Git LFS content) plus normalized
geometry. Disable untrusted scripts and external network access. Record missing
assets, font fallback and any deliberately different theme/configuration;
static replay does not prove historical agent inspection, interactive behavior
or content correctness. Missing input is unknown, not zero overflow.

For bounded-search goals, measure independently evidenced native exploration
separately from exhaustive proof. Pin the model, configuration, tool and search
settings; use the largest distinct-state search per unchanged configuration,
not the sum of repeated runs. A fixed cohort prevents missing configurations
from improving the denominator. Independently confirm no-error, zero-queue
exhaustion before crediting a finite-state proof; timeout, setup failures and
unvalidated checkpoints cannot establish one. A useful diagnostic search need
not complete the full proof to count as demonstrated partial work.

For versioned capability goals, distinguish a proof at the runtime actually
declared by that historical source from certification of today's runtime.
Review the exact changed assertion and dependency semantics before accepting a
historical profile. A pin-only assertion change does not make all parser changes
equivalent: retain any weaker historical guarantees and keep their unsupported
claims unknown. Explicitly archive and version a current-only contract when
extending it; do not silently reinterpret its prior observations.

Update batch coverage as work advances: function, native evidence, evaluation
and plot. Distinguish unimplemented instruments from functions blocked on
unavailable evidence. Do not mark an empty unknown plot as a completed native
measurement. Definitions that import a shared interpreter must pin that
interpreter in their version identity so later helper changes cannot silently
reuse old evidence under new semantics.

Parallel authoring can assign one workflow per worker. Share the frozen inventory,
source revision, cutoff and immutable discovery evidence, not outcome semantics.
Use isolated worktrees, scratch directories and writable acquisition caches;
shared Git objects must remain read-only. Each worker owns its definition,
instrument, retained evidence, evaluation and native plot. Keep shared helpers,
skill edits and coverage publication with one integrator. Transfer only owned
changes with digest-checked manifests, preserving predecessor definitions and
receipts. Assignment is an in-progress milestone, not a ready function or measured
value. Integrate replayable results before advancing those flags; surface blocked
evidence explicitly. Fold validated, goal-independent lessons back into the skill
and rerun its benchmarks instead of accumulating workflow-specific instructions.
Parallelism must not reduce the declared analysis scope. Use bounded, resumable
requests to cover the complete eligible inventory; reaching a request or worker
budget does not establish completeness. Preserve unresolved requirements as open
evidence gaps rather than dropping scenarios or substituting an easy sample.
Coordinate provider request budgets across workers and reuse verified read-only
run/job/artifact responses instead of repeating acquisitions. Check the actual
failed response's quota resource, remaining/reset headers and `Retry-After`;
an available `/rate_limit` bucket does not disprove secondary throttling or a
different worker context. Pause affected requests, preserve resumable cursors and
continue offline verification. A quota interruption is incomplete acquisition,
not unavailable historical evidence, zero opportunities or a finished analysis.

## Portable plots and attention

`evaluate.mjs` also writes `NAME-pulse.html` and `NAME-pulse.json`. Render an
existing timeline with `render-pulse.mjs TIMELINE.json PULSE.html`. These are
local, self-contained projections of the same frozen evidence, not a new
scoring API or a CAO dashboard store. The browser only draws computed payloads;
it never collects evidence or calculates business measures.

Each measure gets its own native plot. Snapshot movement compares cadence-aligned
observations; interval movement compares adjacent, non-overlapping, equal-duration
complete mature periods. Neither is summed into cumulative delivery. `improving`,
`worsening` and `steady` use the sign of direction-aware change, ignoring only
floating-point roundoff, not domain-specific changes or significance.
Missing/stale/interim evidence produces `insufficient-evidence`.
For declared contribution, zero in both periods with known positive opportunities
is `stalled`; known zero opportunities is `no-opportunity`. Unknown opportunities
and no observed delivery request evidence rather than assert workflow failure.
Attention is `review` for worsening/stalled delivery or a missed agreed bar,
`evidence-needed` for insufficient context, otherwise `not-indicated`.
Only `review` supplies keep/change thresholds; a signal never authorizes action.

For event-level rates, cumulative steps and clickable evidence, a bounded
producer may export the following **additive view projection** instead of
reconstructing events from aggregate snapshots:

```json
{
  "schemaVersion": 1,
  "kind": "operational-value-events",
  "repository": "OWNER/REPO",
  "workflowSlug": "verify-bugs",
  "workflowName": "Verify bugs",
  "sourcePath": ".github/workflows/verify-bugs.md",
  "observedAt": "2026-05-01T00:00:00Z",
  "cadenceDays": 7,
  "metric": {
    "id": "linked-fixes",
    "name": "Demonstrated workflow-linked fixes",
    "unit": "defects",
    "direction": "increase",
    "version": "frozen-contract-v1"
  },
  "basis": "workflow-contribution",
  "window": { "startAt": "2026-01-01T00:00:00Z", "endAt": "2026-05-01T00:00:00Z" },
  "coverage": [
    { "startAt": "2026-01-01T00:00:00Z", "endAt": "2026-05-01T00:00:00Z", "status": "complete" }
  ],
  "opportunities": 5,
  "events": [
    {
      "id": "stable-underlying-improvement-id",
      "at": "2026-04-20T00:00:00Z",
      "value": 1,
      "attribution": "corroborated",
      "label": "Verified fix",
      "detail": "Native improvement and independently verified acceptance.",
      "evidence": [{ "label": "Accepted revision", "url": "https://github.com/OWNER/REPO/commit/IMMUTABLE-SHA" }]
    }
  ],
  "limitations": ["Coverage and attribution describe the declared evidence population, not exclusive causation."]
}
```

Values must come from the frozen outcome function and underlying evidence,
not a second LLM evaluation or a merge-count proxy. Define the stable event as
the underlying improvement, not each run/issue/PR reference to it. Never mix
units or metric versions. Corrections to conflicting native facts fail explicitly;
resolve them in the producer. An attribution upgrade can replace the same event
with a later `observedAt`; it does not change delivery time or add value.
Receipt-backed and corroborated contributions both count without weights;
`not-applicable` attribution is allowed only for repository outcomes.

Coverage intervals are ordered, non-overlapping and explicitly `complete`,
`partial`, `missing` or `unknown`; omitted spans are gaps. A complete scope
must be independently justified, not inferred from an empty event list.
Report missing/deleted historical populations as a limitation, not reconstructed
zero work. The observed subtotal survives gaps, but a complete cumulative total
and rates crossing them are unknown. Preserve signed effects.

`render-pulse.mjs EVENTS.json PULSE.html` computes calendar-week bars,
trailing 28-day and 91-day native rates/week and cumulative event steps.
Trend uses two **non-overlapping 28-day windows**, not the overlapping 91-day
baseline. These are declared descriptive presentation horizons, not learned
decision thresholds. Cold starts are unknown until both windows are covered.
Partial weeks use actual exposure and are marked. Event projections require an
additive, direction-oriented quantity (`increase` or `decrease`); ratios and
`target`/`maintain` state measures use the standard timeline instead.
The saved HTML needs no server or network; the adjacent JSON supports MonitorOps
attention checks. Regenerate it on the declared cadence to monitor new work.

## Quality and comparisons

Operational value includes independently demonstrated incremental improvement,
not only complete satisfaction of every goal safeguard. Define verification for
each native quantity separately from full goal completion. Preserve measurable
progress when a different quality dimension is unknown or a stretch criterion
is unmet. A known structural improvement is not zero merely because coverage
or public-API preservation has not been established. Do not relax evidence
intrinsic to the claimed outcome: an untested merge is not a confirmed defect
resolution, and size reduction is not proof of behavior preservation.

Give workflow-enabled improvements shared contribution credit when another
agent or person implements them. Keep the original workflow, router and
implementer identities separate. Report receipt-verified creation, corroborated
explicit links and unverified claims as different attribution strengths;
expired receipts do not erase independently observed improvements or surviving
links. These are not exclusive causal or authorship claims.

Use separate existing metrics and preserved evidence fields for native
improvement, full acceptance, safeguard results and attribution. A metric with
all its required facts may remain numeric while another returns null. Do not
return zero for a missing dimension or apply its unknown value as a blanket
gate to independently established progress. A contract that explicitly measures
fully accepted work still requires all its frozen checks; add a separately
reviewed progress measure rather than silently weakening that contract.

Count outcome attainment regardless of actor. The primary measure must still
work when workflow-generated outputs are removed. Preserve workflow-native
metrics only when they measure the repository problem directly, or explicitly
classify them as diagnostics, gates or rejected proxies.

Evidence must distinguish zero eligible opportunities, zero attained outcomes
and missing facts. Preserve exact windows, maturity, coverage, missing reasons,
lineage and available cohort counts. A successful query or non-null score alone
is not proof of complete coverage.

Return `coverageStatus` (`complete`, `partial`, `missing`, `unknown`),
`missingReason` where applicable, and any actual `eligibleCount` and
`populationDigest`. Do not infer coverage or denominators from a number.
Early attainment-only observations use the bounded post-adoption partial window
and frozen formula; mark `maturityStatus: "interim"` and `dubious: true`.
Do not collect a pre-adoption window for an attainment-only smoke test.

Freeze formula, eligibility, filters, window and missingness across observations.
For baseline-comparable designs, collected baseline evidence must yield a
non-null score for every retained metric; empty populations do not establish a
baseline. Do not confuse workflow adoption with creation of the measured
phenomenon. Reclassification requires a reviewed contract change.

Recent movement needs a complete mature latest period and the immediately
preceding equal-duration period, under the same evaluator, population rule, unit,
direction, cadence and measurement kind. Compare abutting non-overlapping
intervals or declared snapshot cutoffs; never average ratios or add overlapping
rolling totals. Do not fall back to an older accepted value across a gap or hide
a newer unavailable assessment. Two observations are not a sustained trend,
anomaly or causal finding. Adoption association requires separately comparable
complete pre/post windows; attainment-only has no invented baseline.
Zero change does not imply a healthy outcome. A display horizon must not change
the measurement duration or frozen formula.

## Optional standard CAO adapter

Use `templates/campaign-operational-value.mjs` for both workflow-local and
campaign placement. It discovers slug-named modules in the adjacent
`operational-value/` directory. Do not duplicate measurement logic.

It reads `{ schemaVersion: 1, timestamp, repositories, database? }` from stdin,
calls each module once for its supported repositories, and emits:

1. An `operational_value_definition` record with workflow slug, adoption,
   evaluation mode, cadence, supported repositories and namespaced metric IDs.
2. JSONL assessments with `timestamp`, `repository`, `valueId: "NAME.METRIC"`,
   numeric `value` or explicit null, native `metricUnit`, direction/role/name,
   workflow identity, evaluator fingerprint, maturity and period metadata.

Null assessments carry `maturityStatus: "unavailable"` and a non-empty
`missingReason`; interim numbers remain provisional. Emit exact `windowStart`,
`windowEnd`, `measurementKind`, `coverageStatus` and `evidenceDigest`. Preserve
collector-supplied counts, not invented ones. Routine collection produces only
the current cadence-aligned observation; historical evaluation is explicit.

A metric may declare `rollup: { numeratorField, denominatorField }` only when
non-negative additive evidence values with a positive denominator yield the
native metric exactly for the combined population. Emit both rollup fields
together and never average repository ratios.

For contract-activation goals the adapter omits the workflow-adoption marker
from numeric assessments; its internal scheduling still uses the contract's
activation timestamp. Activity omits campaign metadata for the `.github` adapter. Its internal
discovery partition is `.github`, not a campaign enrollment or authority record.
Transport envelopes carry `definition_scope: "standalone"` so retention never
reinterprets ambiguous older campaign-less records as goal measurements.
The same workflow/metric names in a real campaign remain separate identities.
Unsupported repositories emit no assessments; invalid requests fail closed.

## Persistence

The evaluator writes a contract-fingerprint-keyed evidence archive, a timeline
and a Markdown report. Reuse preserved snapshots rather than reinterpret them
under a newer contract. Reconstruct immutable facts where possible; expired
ephemeral facts are missing unless contemporaneously preserved. The dashboard's
rolling 30-day Activity projection is not the durable since-adoption archive.
Do not silently discard accepted history to satisfy a display/cache budget.
JSON reports use compact serialization. Archives larger than 256 KiB are
losslessly stored as `.json.gz` and reused directly; a successful migration
removes only the replaced plain-JSON representation. Corrupt preserved archives
fail explicitly instead of being replaced with a fresh, empty history.

Query retention is a source limitation, not the operational-value history
window: expired facts are missing unless a contemporaneous accepted snapshot
was preserved.

## Authoring and optional historical comparison

State the pre-existing repository problem where one exists, not just the
automation's proposed actions. Count outcome attainment regardless of actor.
Do not derive the primary measure from a gh-aw workflow's own output. For
example, measure security-alert backlog rather than remediation reports.
A separate diagnostic can measure accepted workflow-linked contributions:
apply the independent outcome checks first, then match exact run/subject
identities. Output count and actor identity cannot substitute for acceptance.
Do not credit another actor's outcome to a workflow or count contributor
footers as original creation receipts.

Use a declarative query over canonical CAO data when it has the required facts.
Read the relevant specification with `cao_dashboard_read_data_specification`
and evaluate with `cao_dashboard_execute_query`; do not reimplement query
semantics. Otherwise use immutable Git/GitHub facts or a temporary checkout of
the target repository at the immutable cutoff. Bound acquisition and keep it
outside scoring. A successful query or non-null score alone is not proof of
complete evidence.

Prospective goals do not require adoption history. Freeze contract activation
with an actual repository revision and UTC timestamp; it is not workflow
adoption. Only an explicitly requested adoption comparison needs
`scripts/extract-workflow-intent.mjs OWNER/REPO .github/workflows/NAME.md`.
Read adoption-time sources, imports and compiled instructions. The earliest
compiled commit is adoption; its first parent supplies the baseline reference.

For a full-lifetime assessment, cover every elapsed period rather than extending
a recent cohort's conclusion backward. Version historical goals and acceptance
changes; contradictory transition instructions remain ambiguous. Keep fixed
reference curves separate from the policy actually active at each time.
Separate currently discoverable outputs from receipt-verified creation and
accepted outcomes. Expired evidence and unlisted runs are missing history, not
zero value or a complete execution denominator.

Apply an **antecedent-existence test**: could the same native formula, unit,
population, grain, filters, and window exist without this workflow?
Classify a historical measure as:

- `pre-existing-and-reconstructable`: probe an immutable pre-adoption window;
  accepted baseline evidence is required for `baseline-comparable`.
- `pre-existing-but-not-reconstructable`: document the historical sources
  exhausted; use `attainment-only` and make no adoption-relative improvement claim.
- `created-at-adoption`: explain why the outcome itself, not merely the
  collector, is new; use `attainment-only`.

For a claimed adoption assessment, attainment-only is a fallback after an
explicit failed reconstruction of a pre-existing outcome; "the workflow did
not exist yet" is not sufficient. Do not confuse workflow adoption with
creation of the measured phenomenon. Goal-only prospective measurements need
no failed historical investigation or invented baseline.

## Optional keep/change review

Every newly generated timeline contains `valueReview`: native period values,
evidence status, eligible opportunities, recent comparable movement, a decision
and explicit unmeasured costs. The Markdown report shows its latest twelve
periods. Display length does not alter the function or its evidence archive.
No policy means **not-rated**, not zero value or a failed workflow.

For an agreed keep bar, add an optional policy to `definition`:

```js
review: {
  metricId: "accepted-contributions",
  basis: "workflow-contribution",
  periods: 3,
  minimum: 1,
  rationale: "Owner-approved minimum of one independently accepted contribution per eligible weekly cohort."
}
```

This is an illustrative bar, not a default or a recommended universal threshold.
The selected metric must exist. `minimum` and/or `maximum` are finite bounds in
that metric's native unit; when both exist, minimum must not exceed maximum.
`periods` is a positive integer. The non-empty rationale records the goal or
agreed standard behind the bar. Freeze it before inspecting results.

`basis: "workflow-contribution"` selects a **diagnostic** accepted-contribution
metric, separate from the actor-independent primary repository outcome. It must
score null for missing and malformed examples, just like the primary metric.
The collector must establish independent acceptance and exact workflow linkage;
it must not turn produced artifacts into accepted work.
`basis: "repository-outcome"` may select the primary, but can only report
`goal-met`, `goal-missed` or `mixed`; it cannot recommend keeping or retiring
the workflow on the strength of other actors' work.

Decisions require the declared number of fresh, complete, mature consecutive
periods, finite reviewed values, and an explicit positive `evidence.eligibleCount`
in each period. Unknown counts, zero opportunities, provisional evidence,
missing values and stale or future assessments produce
`insufficient-evidence`. Interval periods must abut without overlap; snapshot
cutoffs must follow the declared cadence. **Workflow-contribution decisions
require interval measurements.** Count independently accepted work within each
declared interval; retaining an old fix in a later snapshot is not new delivery.
Snapshot measures can describe health or goal attainment, not incremental
workflow production. A newer unavailable assessment masks
an older accepted value for the same period. No averaging ratios, summing
rolling windows, arbitrary weights or universal score is introduced.

Meeting the contribution bar in every reviewed period gives `keep-candidate`;
missing it in every period gives `change-or-retire-candidate`; otherwise the
result is `mixed`. These are inspectable review advice, not causal proof,
economic break-even, rollout policy or permission to disable an operation.
The report must display the evidence and policy alongside the decision.

Costs deliberately remain `not-measured`, with null total, unit and
cost-per-accepted-outcome. Future cost collection must join the same repository,
workflow/evaluator revision and exact periods, record its actual currency or
native cost unit, and include all relevant execution costs without
double-counting. Unknown cost is not zero; a zero or unknown accepted count
cannot produce a finite cost-per-outcome. Never infer money or human time saved
from tokens, output volume or an uncalibrated score.
