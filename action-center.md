# System Action Center

**Status:** proposed computation/query/view contract; not an implemented dashboard.
**Goal:** one prioritized system-wide action list; domain views become evidence drill-downs.
**Basis:** [Research and action rules A01-A25](./knowns.md).
**Frontier check, 2026-10-15:** an action inbox alone is not novel. Differentiate through a change brief, challengeable evidence, decision sensitivity, conditional replay and verified follow-through; [research and limits](./knowns.md#frontier-check-decision-experience-not-a-prettier-dashboard).

## 1. Dashboard intent

```json
{
  "intent": "Which system condition needs action next, why now, and what is the smallest authorized next step?",
  "subject": "Enrolled campaigns and workflow obligations at one evidence revision; current state plus a selected UTC window.",
  "objective": "Choose the next bounded action on a phone; inspect why and what could change it.",
  "acceptance": "Rank P0-P3 with scope, owner, urgency and evidence. Show changes, unknowns and competing explanations. Preserve focus during refresh. No universal score, invented coverage or dispatch. Drill down for proof; verify outcomes."
}
```

## 2. Execution boundary

`authoritative inputs -> adapters/normalization -> canonical storage -> Dashboard Language queries + registered measures -> bounded payload -> declarative views`

- Extend current `runtime-health`/`intelligence`; new measures and `system-*` sources are proposed.
- Selection, joins, aggregation, ordering and pagination execute declaratively; interval/statistical functions are registered/versioned measures. No presenter queries, whole-database reads or persisted computation-result stores.
- Preserve SQL/IndexedDB parity and abort-scoped subscriptions. Refresh on evidence/provider/deadline boundaries; show stale until refreshed.
- Advisory only: no approval, dispatch, authority or live-mode changes.
- Historical review/intervention receipts are new authoritative inputs, not browser authority or cached computation tables.

## 3. Inputs and measurement conventions

**C:** current canonical records when collected. **U:** retained upstream/supplemental evidence. **H:** authorized hosted provider. **P:** new contract/instrumentation/computation.

| Relation | Binding / required grain |
| --- | --- |
| `R` | C `$runs` LEFT JOIN `$workflows` (`workflowId=id`) LEFT JOIN `$campaigns` (`campaignId=id`); retain unclassified rows/quality. |
| `E` | C `$audits/$tools/$domains/$friction/$issues`, owning `runId=R.id`; deduplicate events and match attempt provenance. |
| `V` | C `$operationalValues`, partitioned by repository/campaign/`valueId`/evaluator/unit/direction/evidence cut; preserve maturity/nulls. |
| `X` | C assignments and grader/eval observations joined to definition/run; reject workflow/evaluator mismatches. |
| `I` | U/H/P expectations, installation/deployment/dispatch/effect receipts, verdicts, progress/waits, requests/pools, work signatures and owner/service contracts. |

Include operational, standalone and Activity/Dashboard variants; current runtime-health does not cover them all. Preserve control/target/review roles.
`T=[from,to)` UTC; `asOf` + evidence revision freeze evaluation. Include unresolved obligations older than T.
`Q(inputs)` checks scope/freshness/completeness/provenance/maturity. Missing required evidence -> unknown + acquisition/repair; retain independent facts.
Unknown denominator -> unknown coverage; zero -> not applicable/unavailable. Configured workers x targets is not expected work.

## 4. Concrete query/calculation plans

Relational/pure-measure contracts, not executable SQL/DSL. Results include units, numerator/denominator, window, quality and bounded evidence references. Apply Q to every row.

| ID / rules | Query and calculation | Action produced / prerequisites |
| --- | --- | --- |
| **M01 Readiness** A02/A14 | Required-input dependencies JOIN source quality; typed gaps, `gapAge=asOf-expectedArrival`, distinct decisions blocked. | Repair first critical gap. C+U/H/P expectations; missing intent is not an ingestion outage. |
| **M02 Assurance** A01 | Obligations JOIN verdict/enforcement/effects; `coverage=usableRequiredVerdicts/expectedApplicableAttempts`. | Contain exposure / hold assurance. C findings + U/P verdicts; empty findings are not clean coverage. |
| **M03 Shared failure** A03/A04/A18 | Group equivalent signatures by phase/dependency/revision/window; distinct workflows/campaigns/obligations, unaffected comparisons. | One root investigation, retain children. C candidates + U/P equivalence; wrappers do not prove cause. |
| **M04 Missing progress** A05/A17 | Expected obligations LEFT JOIN registry/run/progress/waits; overdue arrival, unexpected disability, exceeded phase-progress contract. | Inspect activation/admission/stall. C+U/P; distinguish intentional idle, known waits and unknown progress. |
| **M05 Factory service** A17/A20 | Validated interval union: `on=unionActive/duty`; bounds `[knownOn/duty,(knownOn+unknown)/duty]`; utilization `activeSlotTime/availableSlotTime`. | Inspect blocked/starved service. U/H/P; `in_progress` is insufficient. Report committed-capacity loss separately. |
| **M06 API pressure** A19 | Group confirmed requests/limiting episodes by host/principal/resource/window; each count/covered pool-hours, throttled/request fraction, union backoff, retry amplification. | Backoff/shared acquisition/staggering. U/H/P coverage; snapshots do not prove hits or fleet-wide rates. |
| **M07 Flow/balance** A10/A20 | Group flows/age/waits/compatible capacity by stage/pool/campaign; reconcile depth; `netFlow=arrivals-dispositions`, `slack=dueBy-asOf`. | Repair bottleneck / trial placement. U/H/P; preserve minimum service, approvals and downstream headroom. |
| **M08 Portfolio overlap** A12 | Match compatible opportunity/outcome/intervention/input/window; group duplicate units once. `netSaving=recoverableDuplicateCost-coordinationCost`. | Share preparation/review or arbitrate conflicts. C+U/P; retain complementarity/assurance; no pairwise triple counting. |
| **M09 Harness/state** A06/A07/A08/A21/A23/A24 | Ordered E JOIN setup/tool/skill/model/endpoint/memory; reconstruction, loops, child fallback, stale state, payload/context and attributed cost. | One boundary fix / bounded trial. U/P; no default budget increase or memory deletion. |
| **M10 Delivery/value** A11/A15/A22/A25 | Expected/observed revision mismatches; effects JOIN requests/staging/receipts/CI/review/mature outcomes; compare V within definition/evaluator/cohort, retaining confounders. | Fix first installation/delivery/value gap. C+U/P; output acceptance is not operational value or causality. |
| **M11 Optimization gate** A13 | X JOIN full-path cost/frozen quality; require `LCB(costControl-costVariant)>minSaving` and higher-is-better `LCB(qualityVariant-qualityControl)>-margin`. | Reviewed promotion after safety/coverage/maturity/valid uncertainty gates. U/P design/costs; inconclusive is not non-inferior. |
| **M12 Cadence/investment** A09/A16 | Opportunities/novelty JOIN cadence/no-ops/cost/attainment/capacity; compare untreated cohorts; replay proposed delay. | Trial relevance/cadence/investment. C+U/H/P; preserve assurance. Average value is not marginal benefit. |

Include failed/retried work, routing/children, precompute/detection/verification once; disclose missing costs. Keep AIC, Actions minutes, reviewer effort and native values separate.
Owner contracts supply thresholds, deadlines, duty, margins, sample requirements and fairness; no invented defaults or universalized current heuristics.

## 5. Deterministic action selection

1. Evaluate `true/false/unknown`; observed threats remain actionable despite missing unrelated cost.
2. Enforce hard gates; replace infeasible interventions with visible hold/authorization/evidence steps.
3. Coalesce exact root/duplicate groups; retain contradictions and affected children.
4. Apply fingerprint-bound feedback/cooldowns/recovery; never hide new safety breaches.
5. Order prerequisite DAG; expose cycles; select the smallest feasible prerequisite.
6. Assign lanes: **P0 exposure/hard gate; P1 current blocker/deadline-critical evidence; P2 supported improvement/trial; P3 watch/discriminating evidence**.
7. Sort within lane: consequence -> latest useful start -> obligations unblocked -> comparable benefit/resources -> stable ID. Unknowns remain explicit; incomparable choices need owner preference.
8. Respect executor/quota/review/human capacity and minimum service. Count/select full scope before pagination.

**No universal health/value/priority score.** One immediate next action plus a bounded ordered backlog.

## 6. Five differentiating computations

Apply across M01-M12; each needs versioned U/H/P inputs and production-boundary tests. These are proposals, not proven market-first features.

| ID | Calculation / decision experience |
| --- | --- |
| **D01 Change brief** | Compare current and same-scope last-reviewed evidence cuts: new/worse/recovered/still-blocked, quality and material deadlines. Missing baseline -> unavailable. Deterministic, cited brief first; optional AI prose cannot alter facts/ranking. |
| **D02 Evidence certificate** | Package trigger/gates/order, support/contradictions, alternatives and disconfirming observation. Preserve originating evidence/relay lineage, not report-count corroboration. Label observed/inferred/assumed/verified; no decorative confidence percentage or hidden-reasoning requirement. |
| **D03 Decision boundary** | `rankRange(a)=[min_theta rank(a),max_theta rank(a)]` over declared admissible completions. Certify stable-first only with exhaustive/sound bounds; otherwise indeterminate. If ranking reverses, request the smallest authorized discriminating observation; never hide independent P0. |
| **D04 Conditional replay** | Compare do/wait/acquire sequences; re-evaluate AND/OR prerequisites, count distinct unlocked obligations. Respect pool/review/attention limits and acquisition deadlines; busy reviewers never justify bypassing assurance. Without validated resource/causal models, show conditional reach, not forecast savings. |
| **D05 Decision episodes** | JOIN condition -> reviewed decision -> authorized external intervention -> receipt -> mature verification. Retrieve matched failures/disconfirmations; revalidate across revisions. Learn from verified outcomes, not clicks; rule changes require review/shadow evaluation. |

## 7. Action payload

| Group | Required fields |
| --- | --- |
| Identity | `actionId`, `ruleIds`, `ruleVersion`, `inputFingerprint`, `evidenceRevision`, `asOf`, `window`, `subjectIds`, `rootOrOverlapGroupId` |
| Decision | `lane`, `class`, `state` (`ready/evidence-needed/held/in-progress/watch`), `title`, `whyNow`, `nextStep`, `ownerRole`, `dueBy`, `latestUsefulStart`, `orderingReason`, `prerequisiteIds`, `resourceRequirements` |
| Evidence | `facts` with units/numerators/denominators, `quality`, `missingInputs`, `contradictions`, `expectedBenefit` with uncertainty or unknown, `evidenceRefs`, `omittedRefCount` |
| Follow-through | `verification`, `stopCondition`, `rollback`, `reconsiderAt`, `drilldownRoute` and scoped parameters |

When supported, add `reviewBaseline`, `delta`, typed `claims` with origin/relay references, `alternatives`, `decisionBoundary`, `scenarioAssumptions`, `conditionalEffects`, `decisionEpisodeRefs`; otherwise unavailable. References stay bounded.

`actionId=hash(ruleFamily, sortedSubjectIds, conditionIdentity, intervention)`; `inputFingerprint=hash(measureVersions, relevantInputRevisions, queryParameters, contractVersions, materialTimeState)`.
Reconsider on material changes, not every tick. Missing owner/time stays unassigned/unknown. Return eligible/held/suppressed counts, coverage and cursor; unavailable counts stay unknown. Default overview page shows 10 actions.

## 8. Four overview surfaces

Sources are proposed. Define queries/templates/marks/encodings/controls/routes in Dashboard Language before renderer changes.

| Surface / query | At-a-glance output |
| --- | --- |
| **1. Now / `system-actions`** | Changed-condition brief + one next step, then ranked cards. Why now, owner/deadline, scope, quality; proof/decision boundary on expansion. Scope/lane/state filters and cursor. |
| **2. Factory service / `system-service`** | Execution/wait/blocked/unknown swimlanes; on-time bounds, utilization, deadlines, coverage. Unsupported comparisons show unavailable, never healthy-zero charts. |
| **3. Shared blockers / `system-blockers`** | Campaign x dependency matrix/table: distinct blocked obligations, failing phase, recurrence, gaps; root selection opens action/affected paths. |
| **4. Value and waste / `system-opportunities`** | Ranked duplicate groups, trials, unmet opportunities; native trends faceted by compatible contract/unit. Savings are estimates; no incompatible value sums. |

Drill-down: action -> measure -> exact episode/run/phase/effect -> receipt. Reuse domain routes; choosing the next step must not require them.

**Phone contract:** at 360x640 CSS px/default text, scope/age/quality + brief + next card in the first viewport; Now/Flow/Blockers/Improve navigation. Phone evidence sheet / desktop side panel. Update facts immediately; defer engaged-list rank movement behind a notice. Surface new P0 without moving controls. Preserve focus/scroll/scope; resolved/stale items cannot stay actionable.

**Visual/accessibility contract:** Primer tokens, typography, restrained elevation, light/dark and reduced motion; no ornamental animation/health dial. Reflow at 320 CSS px; primary targets 48x48 CSS px; unobscured focus. Graphs/timelines require equivalent semantic lists/tables, explicit gaps and no hover/swipe/color-only facts. Field p75 targets: LCP <=2.5s, INP <=200ms, CLS <=0.1; separately measure settled-evidence-to-usable-action time.

## 9. Delivery and acceptance

**First:** M01/M03; M02/M04 only with usable obligations/verdicts/expectations; ranked list with unknowns.
**Next:** instrument M05-M07; add M08-M10. **Then:** calibrated M11/M12; advisory/shadow mode before work admission.
Ship D01/D02 and phone interactions first; bounded D03/D04 next; verified D05 before any learned sequential policy.

Before implementation: normative source/identity/parity/retention/failure contracts, registered measures and production-boundary fixtures.

- Reproducible predicate/next step/evidence/verification/ordering per item; all 25 rules map to M01-M12.
- Missing/partial/unauthorized never means healthy zero; distinguish empty/not-applicable/unavailable/suppressed.
- Three campaigns repeating one task -> one duplicate group; one parent blocker retains children without manufacturing failed attempts.
- Active intervals `[0,20]` and `[10,30]` in 60 minutes -> 30 on-minutes (50%); two-slot utilization 40/120 (33.3%).
- Same revision/asOf/contracts -> identical backend results; material changes refresh views/feedback.
- Desktop/mobile parity; four surfaces maximum; no presenter queries/dispatch/authority expansion.
- Backtest precision/recall, duplicate alerts, diagnosis delay, review burden and realized native outcomes.
- Compare current views, ranked inbox and enhanced experience on identical evidence; measure correct acceptance/rejection, missed critical conditions, task time and workload. Test each D addition; clicks/trust surveys are not effectiveness.
- Stability needs sound/exhaustive bounds; another unsatisfied prerequisite prevents an unlock; missing review history cannot mean no change. Shared-pool interference invalidates unqualified per-campaign causal effects.

**Implementation references:** [Data](./specs/dashboard-data.md), [Computations](./specs/computations.md), [Intelligence](./specs/intelligence.md).
