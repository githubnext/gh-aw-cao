# Connected evidence and actionable system insights

**Status:** research synthesis and proposed advisory contracts, not an implemented dashboard or a grant of operational authority.
**Research cut:** 2026-10-15. Normative repository specifications remain authoritative; availability, assumptions and proposed capabilities are distinguished below.
**Implementation companion:** [System Action Center](./action-center.md).

# Core model

- Every provenance-backed dashboard observation or reproducible measurement is an evidence item: a metric, row, event, status, chart point, relationship, observation time, explicit zero, or explicit missing/partial/unavailable state. Presentation defaults, decorative indicators, simulations, predictions, and agent-written interpretations are not additional observed facts.
- Evidence is not automatically a signal. A signal is an interpretation produced by applying a disclosed rule to evidence within a declared subject, scope, time window, and comparison baseline.
- A signal is not automatically a cause. Several signals can form a pattern, and a pattern can support an investigation or optimization hypothesis, but causal claims require a defensible counterfactual, experiment, or equivalent attribution evidence.
- Derived dashboard measures are evidence, but they remain derived evidence. They do not replace their canonical inputs and must retain their provenance, quality, measurement contract, and links to supporting records.
- Missing data is itself important evidence. Where data is missing, why it is missing, how long it has been missing, and which subjects are affected can reveal collection failures, instrumentation gaps, expired history, unsupported conclusions, and high-value acquisition opportunities.
- Deterministic precomputations can turn a large evidence corpus into bounded, versioned facts and measures before an agent runs. This is a testable way to improve reproducibility and reduce reconstruction work, not a guarantee of better judgment. Source content can remain untrusted even when its acquisition and computation are trustworthy.
- The useful chain is:

```text
canonical observations
  -> bounded measurements
  -> contextual signals
  -> temporal or relational patterns
  -> investigation hypotheses
  -> optimization opportunities
  -> bounded decisions and experiments
  -> observed outcomes and feedback
```

- Every step should be reversible: an operator must be able to move from a signal or recommendation back to the exact runs, events, tools, outputs, observations, and quality states that support it.
- Intelligence derived from evidence can recommend, prioritize, or request more evidence. It cannot grant authority, widen rollout, promote review work to live mode, bypass approval, or prove an outcome that was not measured.

# Implementation and evidence boundaries

The graph and episode vocabulary below is an analytical design, not a claim that every node, edge, measurement, or rule already exists in the dashboard.

Repository inspection establishes these important limits:

| Evidence class | Current usable surface | Important limit |
| --- | --- | --- |
| Inventory, runtime, cost, tool, skill, friction, and audit facts | Canonical collections and declared queries | Read availability and grain before using a field; not every run has every evidence class. |
| Missing-data flags | Run-linked `audit.missing_data` records and source quality | A reported gap is positive evidence of missingness. No flag does not prove complete instrumentation. |
| Experiments, graders, evals, and operational values | Separate canonical definitions/observations and query sources | Assignments are not effects; a grader is not automatically an outcome contract; maturity and evaluator versions matter. |
| Retry history | Upstream attempt-keyed observations when retained | Canonical Run identity is GitHub run ID, with its winning `attempt`. A current snapshot does not guarantee complete earlier-attempt history. |
| Workflow activation | Inventory `workflow-active`, `workflow-registry-state`, and observation time | Disabled is a workflow-level state, not a failed-run conclusion. A current snapshot does not establish when or why activation changed. |
| Factory progress and stalls | Run/job status plus retained phase, progress, and wait evidence | Current runtime-health includes queued/waiting/pending in its active set. Its `running` answer is not measured productive time, a heartbeat, or proof that nothing is stalled. |
| API quota snapshots | Run-context-linked `github_api_rate_limit` Audit records | A remaining-capacity snapshot is not a request-denial event or request denominator. The current adapter also marks unknown remaining capacity `exhausted`; that status alone cannot establish an actual rate-limit hit. |
| Complete security verdict coverage | Detector job/artifact evidence when available | `detection-observations` projects security findings. Its constant applicability/execution fields do not establish coverage of every run or clean verdicts. |
| Per-call tokens, turns, routing, raw diagnostics, and tool schemas | Bounded upstream audits/artifacts when retained | Several diagnostics are not stored directly on canonical Run. Never fabricate invocation counts or tool registrations from aggregate summaries. |
| Collection queues, quota, dead letters, and hosted health | Authorized hosted runtime providers | Not available merely because a static dashboard has the corresponding page. |
| Durable Decision -> Work -> Attempt coordination | Proposed state-mediated coordination contract | Do not infer that the entire proposed coordination store or episode graph is already implemented. |
| Current intelligence | Runtime-health correlation, advisory decisions, fingerprinted feedback and suppression | Current implementation is narrower than the research-backed rule catalogue proposed below. |
| Resolved prompt, imported capability, memory, route, and setup provenance | Retained activation/agent artifacts, lock metadata, and scoped configuration | Several required details are U inputs, not canonical Run fields. Local CLI version alone does not identify a historical run's compiler or harness. |
| Native gh-aw work queue | Upstream version-3 protocol when explicitly installed and integrated | Work, Claim, reservation, Completion, and verified Result are distinct. Upstream support does not establish a CAO deployment, replace CAO policy, or authorize worker fan-out. |
| OpenTelemetry and provider traces | Retained local mirrors or an authorized backend when configured | No spans can mean no export, denied access, sampling/retention, or broken correlation. Span sums and inferred lineage do not establish complete elapsed time or complete episode coverage. |

Use four input-availability labels in action rules:

- **C:** available through canonical evidence/query boundaries when actually collected.
- **U:** requires retained upstream or explicitly declared supplemental evidence.
- **H:** requires an authorized hosted provider.
- **P:** requires a new deterministic computation, declared semantic contract, or missing instrumentation.

These labels describe acquisition requirements, not trust scores. A C input can still be stale or incomplete; a U input can be authoritative but unavailable.

# Concrete decision playbook

**Goal:** publish a short ordered list of next actions, not a dashboard-sized collection of interesting correlations.

**Status:** proposed advisory rule contract. The combinations below are concrete CAO applications to implement and validate; they are not claims of existing automatic diagnosis, causality, or calibrated benefit.

## Research findings that change the design

The literature supports the mechanisms below, not a universally optimal signal combination or priority threshold for CAO. These rules are a falsifiable synthesis of the sources and the actual CAO evidence boundaries.

| Research basis | What is supported | Concrete CAO consequence |
| --- | --- | --- |
| [OCEL 2.0](https://arxiv.org/abs/2403.01975) and the [OCEL standard](https://www.ocel-standard.org/) | Typed event-to-object and object-to-object relationships with role qualifiers preserve many-to-many processes. | One review/output may link several runs/opportunities. Count each real object/event once; build bounded object-centric episode projections for A03-A05/A12. |
| [PM4Py conformance diagnostics](https://processintelligence.solutions/pm4py/api/api/pm4py.conformance.html) | Replay and alignment methods compare recorded behavior against a reference process model. | Use explicit expected stages and legitimate variants before diagnosing skipped stages or loops in A05/A06/A15. Expensive alignments are a bounded drill-down, not mandatory portfolio work. |
| [Google SRE: Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/) | Human alerts should distinguish symptoms from causes and support useful action with low noise. | Rank observed harm, blocked execution, and missed outcome/deadline symptoms; use internal retries, centrality, or tool counts to diagnose them, not as independent pages. |
| [Google SRE: Alerting on SLOs](https://sre.google/workbook/alerting-on-slos/) | Paired windows improve detection/reset behavior; the chapter explicitly discusses low-traffic failure modes and adaptations. | Use multiwindow burn only with adequate event coverage and an applicable SLO. For sparse campaigns use contractual overdue checks or calibrated failure-count/streak rules; do not copy continuous-service constants. |
| [Why am I Waiting?](https://arxiv.org/html/2212.01392v1) | Event-log analysis can distinguish batching, contention, prioritization, resource unavailability, and unexplained waiting using enablement/start/resource evidence. | A10 should identify the waiting mechanism, not recommend more workers because one stage has the highest elapsed time. Unmeasured resource availability remains unknown. |
| [Little's queueing relationship](https://doi.org/10.1287/opre.9.3.383) and [NIST Kaplan-Meier estimation](https://www.itl.nist.gov/div898/handbook/apr/section2/apr215.htm) | Flow accounting and censored time-to-event estimation provide different tools for backlog and latency. | Use direct arrivals/departures/depth for growing queues. Use censor-aware latency estimates only under their assumptions; do not infer steady-state latency from a transient overloaded queue. |
| [Howard: Information Value Theory](https://doi.org/10.1109/TSSC.1966.300074) | Information has value when it can improve the chosen action under a specified decision model. | A02 should ask the smallest decision-changing question; numeric EVSI requires disclosed probabilities, utilities, and acquisition/delay cost. Otherwise use qualitative dependency and consequence ordering. |
| [FDA non-inferiority guidance](https://www.fda.gov/regulatory-information/search-fda-guidance-documents/non-inferiority-clinical-trials) | A justified margin and a proper non-inferiority hypothesis differ from merely failing to find a difference. | A13 requires an a-priori quality margin and adequate evidence. This imports a statistical distinction, not a clinical standard or evidence that an automation is effective. |
| [Interrupted time series tutorial](https://pmc.ncbi.nlm.nih.gov/articles/PMC5407170/) | A dated intervention can be evaluated against an explicit counterfactual trend with an a-priori impact/lag model and checks for seasonality, autocorrelation, and recording changes. | A15 needs a qualified pre/post design, not two averages or an adoption marker. Prefer randomized exposure when feasible. |
| [Benjamini-Yekutieli: dependent multiple testing](https://doi.org/10.1214/aos/1013699998) | False-discovery control depends on the validity and dependence structure of the tests; a conservative correction is available for arbitrary dependence. | Test distinct hypotheses, not every retry/chart. Predeclare test families and evaluation times; use a justified dependency-aware method and do not treat repeated peeking as one fixed test. |
| [gh-aw DeterministicOps](https://github.github.com/gh-aw/patterns/deterministic-ops/) and [MonitorOps](https://github.github.com/gh-aw/patterns/monitor-ops/) | Deterministic preprocessing can feed bounded artifacts to agents; recurring observability can produce durable investigations. | A07 can replace repeated reconstruction with a versioned evidence packet, then measure quality and whole-path cost. Neither pattern automatically validates agent conclusions. |
| [GitHub REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) and [GraphQL limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api) | Authentication scope, API resource, primary quota, secondary throttling, and response diagnostics matter; REST requests and GraphQL points are different units. | A19 correlates confirmed denials and waits by shared quota pool instead of treating every 403 or low quota snapshot as throttling. |
| [GitHub workflow activation](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows) and [concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency) | Disabled workflows do not trigger; concurrency settings can serialize, queue, replace, or cancel work. | A17 distinguishes intentional inactivity from broken service; A20 inspects the compiled admission/concurrency contract before proposing balancing changes. |

The strongest practical recommendation is **symptom + evidence readiness + relational/temporal contrast + one next test**, rather than graph complexity or the number of correlated signals.

The starting policy is:

1. Protect against observed harm or a breached hard gate.
2. Restore decision-critical missing evidence and blocked execution.
3. Remove demonstrated recurring friction and human/collection bottlenecks.
4. Test cost, cadence, acquisition, and model changes against outcome and assurance constraints.
5. Invest or consolidate only when opportunity, outcome, marginal cost, and overlap evidence support it.
6. Watch, defer, or acquire one discriminating fact when stronger action is not yet justified.

## Signal evaluation, not signal counting

A candidate action should satisfy:

```text
applicable contract
AND usable required evidence
AND typed symptom
AND compatible temporal/relational context
AND rule-specific prerequisite
AND feasible next action
```

- Each predicate has `true`, `false`, or `unknown`, with its input references and reason.
- All required predicates true: publish the supported candidate.
- A required predicate false: do not publish that intervention; retain the evaluated result when useful.
- No false predicate but at least one unknown: publish an evidence-acquisition candidate if the missing fact is decision-relevant; otherwise watch.
- A directly observed threat or authority breach remains actionable even if unrelated outcome or cost evidence is missing.
- Do not add "one point" for every chart, audit, or measurement. Several observations can be different views of the same underlying event.
- A symptom establishes the operator problem. A mechanism or contrast establishes the investigation direction, not a proven root cause.

## Shared measurements and parameters

| Symbol or parameter | Definition and use |
| --- | --- |
| `Q(requiredInputs)` | All rule-required inputs meet their own availability, grain, scope, freshness, completeness, and provenance requirements. |
| `coverage` | Measured eligible subjects / authoritatively expected eligible subjects. Unknown denominator means unknown coverage. |
| `n` | Distinct eligible episodes or independent assignment units, not rows, tool events, or repeated observations. |
| `T_short`, `T_long` | Recent and sustained comparison windows selected for the campaign cadence and sample density. |
| `bad_fraction(T)` | Contract-defined bad eligible events / observed eligible events in window T. Zero denominator is unavailable, not zero failure. |
| `burn(T)` | `bad_fraction(T) / allowed_bad_fraction`, only when an applicable non-perfect SLO and usable denominator exist. |
| `due_by` | Contracted expected arrival or completion deadline, including allowed source-observation lag. |
| `overdue` | Current time exceeds `due_by`, with the episode still eligible and the required observation absent. |
| `lambda`, `mu` | Distinct admitted items and terminally discharged items per unit time, with the same scope and accounting boundaries. |
| `backlog_growth` | Net change in ready/in-flight or review-required work; cumulative backfill admissions are not live backlog. |
| `delta_cost` | Cost difference between comparable variants/cohorts at the same cost grain. |
| `delta_quality` | Difference in a frozen outcome/grader measure, with direction and acceptable degradation margin declared in advance. |
| `delta_novelty` | Change in opportunity identity or task-relevant canonical evidence, not merely a changed ingestion timestamp/hash. |
| `min_evidence`, `max_lag`, `cooldown` | Rule-specific calibrated evidence floor, expected source delay, and reconsideration interval. Not universal magic numbers. |

Freshness and maturity differ: a newly collected outcome may still be too immature to evaluate. `computedAt` is not source observation time.

The deployed token-optimizer's three-run eligibility floor and five-run tool-removal inspection guidance are workflow selection policies, not statistical proof of efficacy. No fixed sample count guarantees adequate power.

## Calibrating rules without inventing thresholds

1. Owner contracts define hard limits first: permitted authority, required verdict, expected dispatch arrival, freshness, maturity, maximum detection delay, outcome target, and review deadline.
2. Statistical comparisons then define a practical minimum effect, quality non-inferiority margin, evaluation unit, dependency structure, observation cadence, and minimum evidence based on an appropriate precision/power calculation.
3. Normal-behavior baselines use comparable target/workload/revision cohorts; median, tails, or change-point features are not meaningful with inadequate samples.
4. Historical replay and advisory shadow mode tune alert burden and detection delay. Reserve held-out episodes or a later validation period so tuning and validation are not the same test.
5. Escalation/recovery conditions and cooldowns are versioned together. A resolved historical spike should not remain an active incident solely because the long window still contains it.

For a dense stream with a valid SLO, a proposed paired-window predicate is:

```text
Q(eventCoverage, SLO, sourceTimes)
AND events(T_short) >= n_short
AND events(T_long) >= n_long
AND burn(T_short) >= b_short
AND burn(T_long) >= b_long
```

For a sparse periodic campaign, a different proposed predicate is:

```text
Q(schedule, expectation, scopedHistory)
AND (
  required_observation_overdue
  OR contract_failure_condition_on_last_n_eligible_episodes
)
```

`n_short`, `n_long`, burn thresholds, and the last-n failure condition require local calibration. Missing windows are not healthy windows. A single high-consequence failure may justify action without a statistical recurrence threshold.

The request-based burn ratio remains mathematically defined with one observed event, but can be extremely noisy; it is undefined with no eligible events. Google explicitly warns about low traffic. Do not describe burn-rate methods as inherently inapplicable to all low-volume systems, and do not manufacture agent runs or pool unrelated targets just to obtain a smooth denominator.

## Graph and temporal discrimination

Prefer this order before learned graph similarity:

1. Exact canonical edges and hard-gate conformance.
2. Required transitions, elapsed deadlines, and typed gaps.
3. Repeated local motifs with distinct-episode support and unaffected comparisons.
4. Revision-linked contrasts adjusted for workload, target, schedule, and evidence coverage.
5. Learned similarity only to propose a bounded question for the preceding checks.

A dependency appearing in every failure is not discriminating if it also appears in every healthy episode. Where comparable exposure exists, report:

```text
affected_exposed / eligible_exposed
affected_unexposed / eligible_unexposed
risk_difference = first_fraction - second_fraction
```

Preserve counts, uncertainty, missing exposure, and cohort differences. A zero denominator prevents this contrast; high lift or a risk difference is still association, not causal proof.

Maintain two different graphs:

- An **observed evidence graph** links actual objects, events, and documented dependencies; it is used for diagnosis.
- A **decision prerequisite DAG** orders the proposed next actions; it is used for scheduling.

A dependency DAG cannot be created by simply orienting every observed graph edge. If proposed actions have a cycle, expose the circular prerequisite and identify a bounded evidence/test step that breaks it; do not issue impossible instructions.

## Flow and outcome timing

- Partition delay into waiting and active processing only when enablement/start/end evidence exists.
- Distinguish batching, unavailable quota/resource, contention, prioritization, retries, and human review. Elapsed time alone does not choose among them.
- Over a finite window, reconcile start backlog + admitted arrivals - terminal discharges + documented transfers/corrections = end backlog. Explicit cancellations/expiry are dispositions, not successful outcomes.
- `L = lambda * W` is a long-run flow relationship under its applicable finite-limit assumptions, not proof of a root cause or a reliable stationary forecast for a growing backlog.
- Report completed-item latency as completed-item latency. For a population estimate, include still-open items as censored observations and document the estimator's assumptions.
- Kaplan-Meier requires defensible non-informative censoring for its usual interpretation. Retention that selectively loses difficult/failed work may violate that condition.
- Rejection, cancellation, and expiry may be competing terminal events, not interchangeable censoring. Use separate disposition reporting or an appropriate competing-risk method rather than implying eventual acceptance.
- Left-truncated history, lost start times, and expired follow-up limit what the system can estimate. Do not fill those gaps with a synthetic episode start.

## Cost superiority with quality non-inferiority

Predeclare the intervention, exposure unit, cost grain, quality metric, evaluator version, maturity rule, minimum useful saving, degradation margin, interval method, sample design, and evaluation time.

For a higher-is-better quality metric:

```text
quality_delta = quality_optimized - quality_control
quality passes if lower_confidence_bound(quality_delta) > -allowed_degradation
cost passes if lower_confidence_bound(cost_control - cost_optimized)
               > minimum_useful_saving
```

Use the corresponding upper-bound test for a lower-is-better quality loss. Zero-tolerance policy/security gates remain hard gates, not statistical margins. Passing a sample-based statistical test never proves zero risk.

- Prefer frozen random assignment to the optimization/control variants when feasible.
- Choose an assignment unit that avoids cross-variant interference; shared repository changes or reused evidence packets may require repository-level or time-block assignment.
- If randomization is unavailable, use a disclosed matched/control or interrupted-time-series design and retain its assumptions and causal limits.
- A grader passing is evidence about its tested contract, not coverage of every relevant repository outcome.
- Account for clustering and temporal dependence. Repeated events within one episode are not independent sample size.
- Correct for multiple tested variants/motifs at prespecified evaluations. Benjamini-Hochberg supports independence and certain positive-dependence conditions; arbitrary dependence may require Benjamini-Yekutieli or another justified method with valid p-values.
- Do not keep checking ordinary fixed-horizon intervals until they pass. Use a fixed evaluation plan or a valid sequential method.
- "No significant degradation" and "non-inferior within the margin" are different claims.

## Factory health: execution is not the same as progress

Analyze the control plane as a factory with several coupled stages: trigger/admission, orchestration, dispatch, worker setup, agent/tool execution, assurance, safe output, review, and outcome. Include compiler/validation and collection dependencies even when they fail before a worker run exists.

Keep workflow activation, run lifecycle, job/step phase, observed progress, wait cause, and outcome as separate dimensions:

| Observation | Interpretation and next diagnostic |
| --- | --- |
| Failed or timed-out eligible run | Preserve the native conclusion and failed phase; examine first failure, retries, and downstream blocked obligations. Failure is not the same as a legitimate no-op. |
| Cancelled run | Determine superseded work, manual stop, concurrency replacement, dependency failure, or other recorded reason. Cancellation alone proves neither incident nor harmless recovery. |
| Disabled workflow | Compare registry state with intended activation, effective policy, and an accepted pause/maintenance record. Unexpected disability can cause unmet work without any failed run. |
| Queued, pending, or waiting run | Separate runner/concurrency admission, environment approval, API backoff, external dependency, and human wait. These are not execution-active intervals. |
| `in_progress` without phase/progress evidence | Execution activity is unknown. A long model/tool call can be legitimate; unchanged coarse status is not proof of a stall. |
| Suspected stalled job | Fresh collection, an observed last-progress point, an exceeded phase-specific progress/deadline contract, and no explained wait justify investigation, not an invented root cause. |
| Confirmed blocked job | A recorded unmet prerequisite or wait reason explains the blocked edge. Trace to that prerequisite rather than opening one unrelated incident per child. |
| No runs or no workers | Establish authoritative expected work first. Policy-disabled, not-selected, idle, missing dispatch, and failed collection have different meanings. |
| Healthy idle period | No eligible work is due and required observation/assurance obligations remain met. Do not manufacture work to maximize occupancy. |
| Compiler or validation failure | Attach evidence to the exact source/import/manifest/compiler revision and pre-run obligation. No worker may have been admitted; do not fabricate failed worker attempts. |
| Stale or incomplete observations | Report unknown progress and state-history coverage. Dashboard ingestion timestamps do not prove that the factory made progress. |

GitHub can disable scheduled workflows automatically in some circumstances. Preserve the registry state and obtain history/reason where available; do not infer an operator's intent from the state alone.

Retain failure frequency, consecutive eligible failures, timeout/cancellation dispositions, recovery duration, unexpected disabled obligations, age since observed progress, and blocked critical paths. Show counts and duration alongside rates so a sparse but consequential failure is not hidden by a portfolio average.

## Measuring factory "on" time

Define the scope first: which campaigns, stages, execution resources, service calendar, and admitted/expected work constitute the factory? Collection-only housekeeping, failed retry loops, and legitimate no-ops must not be silently presented as useful task execution.

Let `T` be the declared service-duty interval set in the reporting window. Exclude approved off-duty periods under the frozen service contract, not unexpected outages or unexpected disability. Define `A_i` as validated execution-active intervals for task/job i, clipped to T; never assign an entire `in_progress` span to A_i just because it has start/end timestamps.

```text
factory_on_time = duration(union_i(A_i))
factory_on_fraction = factory_on_time / duration(T)

pool_active_slot_time = sum_slot(duration(validated_active_intervals(slot)))
pool_capacity_slot_time = integral_over_T(approved_available_slots(t) dt)
pool_active_utilization = pool_active_slot_time / pool_capacity_slot_time
```

These are different quantities. The first asks whether at least one scoped task is executing; the second asks how much comparable execution capacity is used. An almost-always-on factory can still have a starved campaign, a dead critical dependency, or mostly idle slots. Track capacity outages separately against committed capacity so reducing available slots does not conceal lost service.

Report a vector, not one health score:

- execution-active time and on-fraction;
- runnable queued time, explicit dependency/API/approval wait, suspected stalled time, and unknown time;
- required-stage availability and deadline attainment;
- capacity utilization/headroom by comparable pool;
- admitted arrival/discharge rates, oldest ready item, and blocked critical-path age; and
- verified outcomes, quality, and cost per eligible/mature opportunity.

Assign mutually exclusive time states at the chosen job/slot grain before aggregating. Parallel jobs can be active and waiting at the same wall-clock instant; do not sum those states into a fictitious factory-time partition. Interval evidence, phase semantics, collection cadence, and clock quality must be declared. Point heartbeats alone do not measure continuous execution between observations without an explicit measurement model.

Where the full-scope timeline can be partitioned into known-on, known-off, and unknown:

```text
on_fraction_lower_bound = known_on_time / duration(T)
on_fraction_upper_bound = (known_on_time + unknown_time) / duration(T)
```

Known-off requires adequate evidence that no scoped task was executing; absence of a heartbeat is not enough. If evidence cannot support interval classification at all, on-time is unavailable rather than an invented bound. A zero duty or capacity denominator is unavailable.

For average factory on-fraction across days, use total on-time / total duty-time, not an unweighted average of unequal-duty daily percentages. Separately report duration of continuous on-spells and off/stalled spells; preserve boundary-censored spells and sample counts.

**Worked example:** in a fully observed 60-minute duty window with two available slots, job A is execution-active from minute 0 to 20 and job B from 10 to 30. Factory on-time is 30 minutes, or 50%, not 40 minutes. Active slot-time is 40 slot-minutes out of 120, or 33.3%. If a different window has 30 known-on, 20 known-off, and 10 unknown minutes, its on-fraction is bounded by 50%-66.7%, not measured as 50% or 100%.

The objective is useful service under deadlines and quality constraints, not maximum "on" time. Lower occupancy with unchanged mature outcomes can be an efficiency gain; high occupancy spent retrying or duplicating work can be waste.

## API pressure and resource-aware load balancing

Define an opaque non-secret quota-pool identity from provider/host, authentication principal or installation, API protocol/resource, and applicable quota window. Do not store tokens or assume each campaign owns an independent budget.

| Measurement | Evidence and limitation |
| --- | --- |
| Confirmed throttle-hit count and episode frequency | Structured response/error evidence, request identity, time, affected campaigns, and primary/secondary classification where supported. Coalesce one shared limiting episode without discarding the request-level count. |
| Throttled request fraction | Confirmed throttled request attempts / all observed eligible request attempts in the same scope/window. With an incomplete denominator, publish a lower-bound observed count, not a fleet-wide rate. |
| Quota headroom | Valid numeric remaining/limit at an observation time, resource, and principal. It is a snapshot, not time spent blocked or proof that a request was denied. |
| Backoff and delayed-work time | Explicit wait/retry-after/reset evidence and linked runnable obligations. Union overlapping intervals at the reporting grain; disclose censored recovery. |
| Retry amplification | Total correlated request attempts / distinct initial logical requests. Do not compare this to campaign run counts or fabricate identity from similar text. |
| Quota consumption per useful unit | Requests or API-specific points per comparable eligible episode/outcome, with cache and failed/retried work included. Keep REST requests, GraphQL points, and other provider units separate. |
| Blast radius | Distinct campaign/workflow/target obligations actually blocked by the shared pool or dependency, not all configured targets. |

```text
throttle_episode_frequency = distinct_confirmed_limiting_episodes
                             / fully_observed_pool_duty_hours
affected_episode_fraction = eligible_episodes_with_confirmed_throttle
                            / eligible_episodes_with_complete_API_evidence
```

Define episode onset/recovery and coverage before calculating these. The second fraction applies only to its evidence-complete cohort; publish that cohort's coverage of expected eligible work. A frequency from partial observation is not a fleet-wide estimate. Request-hit count, shared throttle-episode count, and affected work-episode count are three different numerators.

Classify permission denials, authentication errors, quota exhaustion, secondary throttling, and query/resource/time limits separately. For REST, 403/429 alone is insufficient without rate-limit headers or a supported diagnostic. Positive primary headroom does not exclude secondary throttling; missing numeric remaining does not prove primary exhaustion. Follow provider-specific response semantics for GraphQL and other APIs.

Respect retry-after/reset evidence and bounded backoff. Prefer response headers to extra quota polling; polling itself can add secondary-limit pressure. Do not infer exact consumption from differences between arbitrary snapshots: reset, regional handling, principal changes, and other clients can invalidate that arithmetic.

Load balancing needs the resource graph: ready work -> eligible executor -> concurrency group -> API/quota pool -> downstream review/assurance capacity.

- Distinguish admission imbalance from physical capacity shortage, disabled workflow, approval wait, quota backoff, and a stalled executor.
- A saturated pool plus a compatible idle pool plus runnable eligible work supports a balancing hypothesis only if authority, credential reach, network, concurrency, and downstream constraints permit reassignment.
- Compare queue age, deadline slack, service share, and execution-active utilization across comparable pools/campaigns. Account for workload size and unequal resource cost; raw job-count equality is not fairness.
- Shared schedule peaks plus confirmed throttling support staggered admission, a bounded token/point-aware budget, or shared acquisition/precompute rather than more simultaneous workers.
- Inspect the deployed compiled concurrency behavior: waiting work may be replaced/cancelled, not durably queued. Never assume FIFO by dispatch time or that a suggested queue option is supported by the installed gh-aw/compiler version.
- Preserve declared campaign priority, minimum service, maximum wait, and downstream headroom. Do not starve a low-volume or high-consequence campaign to improve aggregate throughput.
- Observe recovery/catch-up after throttling: synchronized retries can recreate the bottleneck.

Any balancing intervention is a reviewed scheduling/resource change, not permission to rotate credentials to evade rate limits, redispatch from a worker, widen scope, or admit unbounded work.

## Correlated campaign failures and overarching blockers

Analyze related workflows within a campaign before assuming every worker failure is independent. Then test shared components across campaigns. A03 handles the cross-campaign case; A18 handles a campaign-local common blocker.

Construct a failure matrix at campaign/workflow/target/phase/revision/time grain, preserving direct error evidence, blocked dependencies, absent-but-expected work, and collection gaps. Match structured underlying diagnostics, not generic `failure`, `driver_exit`, or similar narrative wording.

| Candidate common cause | Discriminating evidence |
| --- | --- |
| gh-aw compiler or shared import incompatibility | Equivalent compile/validation diagnostic, exact compiler/flags/source/import/lock revisions, onset after exposure, and comparable unaffected or prior passing checks. Runtime failures alone do not prove compiler failure. |
| Campaign manifest, installation, or policy mismatch | Expected-versus-installed workflow identity, source/lock mismatch, envelope/worker capability mismatch, or an exact validation/admission failure at the effective policy SHA. |
| Shared orchestrator/dispatch blocker | Failed or held parent obligation plus authoritative child/dependency mapping; missing workers alone do not establish dispatch failure. |
| Shared credential, API, firewall, or tool integration | Matching actor/access or structured quota/network/tool diagnostics on related paths; separate intentional security blocks from incorrect configuration. |
| Shared runner/concurrency or approval constraint | Compatible queued obligations, actual executor/group/approval state, and a measured delay contract; coarse pending state is insufficient. |
| Collection/schema regression | Source runs exist but mapped evidence is missing/stale across related workflows after collector exposure; do not label this an execution outage. |
| Target/content-specific issue | Same workflow exposure with unaffected targets and a supported repository-specific difference; campaign membership alone is not a shared cause. |

Publish one root-investigation candidate with affected child obligations, representative failures, unaffected comparisons, onset/recovery timeline, dependency evidence, and contradictory observations. Retain the child symptoms; inherited blockage is not an observed child failure.

Rank common blockers by current consequence, latest safe start, and distinct obligations unblocked. Do not multiply the same parent failure by its fan-out, and do not collapse unrelated failures just because they share campaign membership. Verify a correction on the affected sibling workflows as well as a representative unaffected path.

## Portfolio overlap: intent similarity is only the first screen

Compare campaign intent and individual worker work at portfolio grain, including overlap between workers within one campaign. Build a declared work signature:

```text
campaign + worker + target/object/opportunity identity
  + intended outcome + intervention/action class
  + input revision/fingerprint + observation window
  + authority/mode + required assurance role
```

Campaign/worker identifiers retain producer provenance; they are not an equality requirement for cross-campaign matching. Comparison sets use a declared projection onto the compatible opportunity, outcome, intervention, input, and time dimensions, after authority/assurance checks. Otherwise every producer's signature would be artificially unique.

Start with candidate pairs/groups using compatible intent, subjects, and timing; prove or reject duplication with actual acquisition, outputs, interventions, and outcome contracts. Similar wording or a shared target is not sufficient.

| Overlap class | Combination and appropriate next action |
| --- | --- |
| Repeated acquisition/preparation | Same scoped input revision and equivalent deterministic query across episodes -> test one bounded shared precompute/cache without changing each consumer's authority or freshness contract. |
| Duplicate investigation/output | Same opportunity, problem, intended outcome, and time window, with substantially the same evidence/action and no required independent judgment -> coalesce investigation or review. |
| Competing interventions | Same object/opportunity with incompatible proposed actions or mutations -> surface the conflict, sequence or arbitrate under the owner contract, and prevent duplicate application. |
| Complementary work | Same repository but distinct opportunity/outcome or sequential prerequisite -> retain both, connect the dependency, and share only permitted preparation. |
| Independent assurance | Similar evidence/outcome but separately required assurance role -> retain independence. Shared acquisition must not violate assurance independence or create an undisclosed common-mode failure. |
| Unknown semantics | Similar intent without native opportunity/action/outcome identity -> request the contract or corroboration; do not label waste or disable a campaign. |

For completely observed work-signature sets, Jaccard overlap and directional coverage can screen pairs:

```text
pair_overlap = size(S_a intersect S_b) / size(S_a union S_b)
coverage_of_a_by_b = size(S_a intersect S_b) / size(S_a)
```

Empty or incompletely observed sets cannot establish zero overlap or redundancy. Declare the signature matching contract; semantic similarity scores are hypotheses, not observed intersections.

At portfolio grain, group a duplicated work unit across every participating campaign/worker and allocate its attributable cost once. Three campaigns repeating one task create one duplicate group, not three independent pairwise savings estimates. Conversely, one workflow can be redundant for one opportunity and valuable for another; prefer opportunity-level coalescing to blanket removal.

Estimate only recoverable duplicate acquisition/execution/review cost, subtracting coordination/precompute cost and preserving distinct value/assurance. Track unique opportunities covered, duplicate outputs/approvals, intervention conflicts, native attainment, and affected reviewers. Do not add incompatible campaign values into one portfolio score.

Optimization choices are shared preparation, admission deduplication, coordinated ordering, coalesced review, narrower worker responsibility, or owner-approved retirement. Verify each choice against coverage, delay, outcome, assurance, and authority gates; neither intent similarity nor a graph cluster grants permission to disable work.

## Action-rule catalogue

Each rule below defines a combination, the next bounded action, and how that action is verified.

### A01 - Contain a security or authority breach

- **Combine:** structured threat/authority evidence + exact run/policy/capability revision + output/application state.
- **Sources:** C audit/findings; U full detector verdict, enforcement and application evidence when required.
- **Act:** if a breach or unsafe application is observed, route to the responsible operator for authorized containment and inspection of the implicated output. If the detector successfully blocked it, keep the gate active and investigate that output; a functioning block is not itself an uncontrolled incident.
- **Unknown route:** missing mandatory verdict -> hold the dependent approval/application and request the exact detector artifact or failure diagnostic.
- **Exclude:** warnings, execution failures, parse errors, and verified threats are distinct. No finding row is not a clean verdict.
- **Priority/verify:** P0 for actual exposure/breach; P1 for safely blocked findings or assurance restoration, subject to consequence/deadline. Verify containment, a usable verdict, and enforcement; never optimize by disabling detection.

### A02 - Restore decision-critical missing evidence

- **Combine:** explicit missing-data flag or failed source-quality contract + required input dependency + affected decision/episode + gap age.
- **Sources:** C missing-data Audit, quality/provenance; H ingestion state if configured; P dependency/gap computation.
- **Act:** locate the first broken evidence edge and acquire or repair only that source, subject, field, relationship, denominator, or interval.
- **Unknown route:** if no authoritative expectation exists, first establish the expectation; do not classify an arbitrary absent field as a defect.
- **Exclude:** intentionally unmeasured, not-applicable, censored, and retention-expired evidence are separate. Preserve valid upstream facts while withholding unsupported downstream conclusions.
- **Priority/verify:** inherit the consequence and latest useful acquisition time of the blocked decision, not a blanket top priority for every gap. Verify a rerun of the dependent measure resolves the gap or honestly narrows the conclusion.

### A03 - Investigate a shared-platform failure once

- **Combine:** equivalent structured error + current failures in at least two distinct campaigns + comparable windows/phases + a shared dependency or runtime observation.
- **Sources:** C runtime-health, errors, versions, tools/domains; U detailed shared setup evidence if needed; P cross-campaign equivalence.
- **Act:** form one shared-platform investigation with representative failed and unaffected episodes; test the common compiler, gateway, firewall, integration, or control component.
- **Unknown route:** generic `failure` or `driver_exit` alone is not error equivalence. Request the bounded structured underlying diagnostic.
- **Exclude:** repeated runs in one campaign do not meet the two-campaign scope rule; a common version may simply be universal exposure.
- **Priority/verify:** P1 for current execution impact. Verify the proposed correction across affected and unaffected campaigns under the same safety gates.

### A04 - Investigate a target-specific failure

- **Combine:** same workflow/revision and operation + failing subset of expected targets + unaffected comparisons + complete expected-target evaluation.
- **Sources:** C target associations, native conclusions, structured audit facts; U target-specific permissions/content comparisons.
- **Act:** inspect the smallest target-specific difference in repository content, branch, language/layout, permissions, tool behavior, or network input.
- **Unknown route:** partial target coverage -> evaluate the missing comparison target; do not conclude "all targets" or target specificity.
- **Exclude:** control repository, review destination, and dispatched target are not interchangeable; one target's success cannot reset another's streak.
- **Priority/verify:** P1 for blocked eligible work, otherwise P2 investigation. Verify recovery on affected targets and unchanged behavior on comparisons.

### A05 - Resolve a confirmed dispatch gap

- **Combine:** authoritative confirmed dispatch/work admission + exact target/worker correlation + elapsed `due_by` + usable worker-discovery coverage + no associated worker run.
- **Sources:** C run/admission evidence where retained; U dispatch receipts; P authoritative deadline/lineage; future durable Work state when implemented.
- **Act:** inspect admission outcome, envelope, actor access, concurrency, and workflow activation for that one dispatch.
- **Unknown route:** request the dispatch receipt or deadline contract before calling an absent worker a failure.
- **Exclude:** requested dispatch, configured target, `not-selected`, and `no-eligible-work` do not prove expected execution.
- **Priority/verify:** P1 if a deadline or operational dependency is affected. Verify a linked admitted worker or an explicit legitimate denial/cancellation, without silently redispatching.

### A06 - Break a repeated tool or fallback loop

- **Combine:** correlated tool/command errors or denials + repeated attempts/reads + measured turn/cost/duration growth or steering + missing required result.
- **Sources:** C tool errors, firewall, friction, steering, cost; U ordered calls, turns, command policy, and full attempt history when necessary.
- **Act:** compare the failed invocation with the reviewed capability and actor contract. Propose one bounded correction, alternate supported acquisition path, or explicit stop/backoff.
- **Unknown route:** aggregate co-occurrence supports a hypothesis; request ordered call evidence before asserting the loop sequence.
- **Exclude:** a deliberate security denial should remain denied. In particular, a GitHub-App role denial from `logs`/`audit` is an unavailable fallback, not a missing tool to retry.
- **Priority/verify:** P1 for an active blocker, otherwise P2 friction reduction. Verify no repeat of the invalid call, required result availability, and preserved authority; do not just increase budget.

### A07 - Precompute repeated deterministic reconstruction

- **Combine:** repeated identical joins/grouping/filtering across episodes + stable task-relevant input fingerprint + no new judgment requirement + material acquisition/reconstruction cost.
- **Sources:** C tools, bytes, cost, inputs; U task/query call traces; P versioned deterministic precompute and dependency declaration.
- **Act:** propose a bounded precompute and agent evidence packet for one operation; include missingness, contradictions, comparison cohorts, and drill-down references.
- **Unknown route:** use a replayable quality evaluation before claiming the packet makes the agent stronger.
- **Exclude:** a hash proves identity/integrity, not truth. Untrusted content remains untrusted; omit no required context or contradictory evidence.
- **Priority/verify:** P2. Compare precompute + agent cost against raw-path cost, and verify reproducibility, sufficiency, decision quality, invalidation, and failure-on-missing-input behavior.

### A08 - Test tool pruning or filtered acquisition

- **Combine:** configured capability inventory + complete representative call coverage + unused registrations or high deterministic call/response volume + measured context/cost contribution.
- **Sources:** C observed tools/bytes; U compiled tool inventory, schemas, per-call context; P exposure/coverage comparison.
- **Act:** test removing one unneeded registration or fetching/filtering one stable input outside the reasoning loop.
- **Unknown route:** inspect source/compiled inventory or missing call coverage. A zero-call dashboard row cannot establish that a tool was registered.
- **Exclude:** rarely used recovery/safety paths and tools used in successful runs need stronger contrary evidence before removal. Pruning can yield no measurable cost change.
- **Priority/verify:** P2; favor frequency times plausible per-episode savings. Verify required tasks, safety/recovery paths, quality, and total-cost reduction in a controlled comparison.

### A09 - Reduce low-yield cadence safely

- **Combine:** frequent scheduled episodes + complete legitimate no-op rate + low opportunity/evidence novelty + measured recurring cost + explicit delay/assurance contract.
- **Sources:** C runs, no-ops, cost; U schedule/trigger; P novelty and allowed detection-delay contract.
- **Act:** propose a deterministic relevance gate, batching, adaptive backoff, or a lower schedule frequency for one campaign.
- **Unknown route:** obtain maximum acceptable delay and assurance requirements before recommending fewer runs.
- **Exclude:** missing-data no-ops, failed acquisition, and recurring independent assurance are not redundant no-work episodes.
- **Priority/verify:** P2. Replay historical opportunities under the proposed schedule; verify missed-opportunity/delay constraints and compare actual cost and outcomes in a bounded trial.

### A10 - Address a collection or review bottleneck

- **Combine:** positive backlog growth + increasing oldest-item age + distinct arrivals at or above discharge throughput + stage-specific capacity/failure evidence.
- **Sources:** H collection queues/quota; C linked outputs/work states where authoritative; U review dispositions; P flow/censoring computation.
- **Act:** identify whether the limiting stage is capacity, quota, retries, failed processing, or human review. Choose one intervention at that stage.
- **Unknown route:** request arrival, departure, or state-transition instrumentation; output count alone does not measure acceptance or throughput.
- **Exclude:** current depth, cumulative admissions, retries, and completed items have different accounting meanings. A stable queue with old stuck items still needs inspection.
- **Priority/verify:** P1 for overdue critical work, otherwise P2. Verify age/depth improve with no loss of opportunities, assurance, or outcome quality; do not accelerate generation into a review bottleneck.

### A11 - Diagnose reliable but ineffective production

- **Combine:** reliable execution + reported outputs + mature, sufficiently covered outcome evidence that misses its frozen target or worsens + opportunity/target attribution.
- **Sources:** C conclusions, outputs, native operational values; U explicit review/acceptance evidence; P outcome target and maturity/attribution contract.
- **Act:** investigate the first unsupported transition: output -> acceptance, acceptance -> outcome, or outcome -> measured attainment. Propose a targeting/intervention change, not more output.
- **Unknown route:** restore acceptance, maturity, baseline, or opportunity evidence before declaring ineffectiveness.
- **Exclude:** no output can be the correct outcome; primary measures differ by campaign, and native values must not be averaged across incompatible contracts.
- **Priority/verify:** P1 if a declared high-consequence outcome is threatened; otherwise P2. Verify attainment under the same contract, not a higher successful-run or output count.

### A12 - Consolidate genuinely overlapping portfolio work

- **Combine:** campaign/worker intent comparison + same opportunity/subject identity + equivalent intended outcome + temporal/intervention overlap + observed duplicate acquisition/output/work + compatible authority and assurance requirements.
- **Sources:** C campaign/target/tool/output facts; U source/intent/intervention detail; P declared work-signature, opportunity, overlap, and assurance contracts.
- **Act:** group actual duplicate work across the portfolio, including sibling workers. First test shared preparation, admission deduplication, coordinated ordering, or coalesced review; propose removal only when distinct outcomes and required independent assurance are preserved.
- **Unknown route:** collect semantic contracts and repository-native corroboration instead of treating similar descriptions as redundancy.
- **Exclude:** complementary interventions and independent assurance. Incompatible interventions require explicit conflict handling, not blind merging. Shared preparation must not broaden credential, visibility, retention, or target scope; count each duplicate group once, not once per campaign pair.
- **Priority/verify:** P2 for consolidation; route an actual dangerous intervention conflict through A01 and its owner. Verify fewer duplicate calls/outputs/approvals, net recoverable savings, and preserved distinct outcomes, coverage, deadlines, and assurance.

### A13 - Promote a cost optimization only after quality validation

- **Combine:** valid comparable assignment/cohort + lower total cost at a fixed grain + quality within a predeclared non-inferiority margin + acceptable reliability/security/coverage + mature outcomes where required.
- **Sources:** C assignments, cost, graders/evals, values; U complete attempt/auxiliary costs; P powered evaluation design and effect estimates.
- **Act:** promote a reviewed variant only if the cost and quality decision criteria pass; otherwise continue a bounded trial, reject, or collect a discriminating observation.
- **Unknown route:** incomplete cost/assignment/outcome evidence means insufficient evidence, not a winning cheap variant.
- **Exclude:** "no statistically significant quality difference" does not prove non-inferiority. Include failed attempts and precompute/detector costs; do not select only successful runs.
- **Priority/verify:** P2 after hard gates. Verify uncertainty bounds, maturation, total-cost savings, and rollback criteria; keep the evaluator/contract frozen.

### A14 - Restore a stale evidence pipeline before trusting trends

- **Combine:** source activity or expected fresh observations + missed freshness deadline + missing/failed record phase, dead letters, or acquisition diagnostics + dependent stale measures.
- **Sources:** C transactions, quality, run/detail coverage; H collection health; U artifact availability; P source-to-view dependency map.
- **Act:** repair or reacquire the narrowest broken source/phase, then recompute the affected dependent measures.
- **Unknown route:** distinguish source inactivity from acquisition failure with an authoritative source observation.
- **Exclude:** an intentional bounded-age query cache is not an invalidation bug. Display original evidence time/revision and apply the consumer's freshness contract.
- **Priority/verify:** P1 when decisions are blocked; otherwise P2. Verify restored freshness, correct run/detail coverage, and no falsely healthy empty results.

### A15 - Investigate a revision-linked regression

- **Combine:** known workflow/model/tool/compiler/policy change + comparable pre/post episode features + sustained practical degradation + unchanged or controlled workload/coverage.
- **Sources:** C revisions/versions, cost, errors, values; U complete revision/route exposure; P matched comparison/change-point computation.
- **Act:** inspect the exact changed capability or process edge and the smallest affected/unaffected contrast; propose a reversible review-mode test.
- **Unknown route:** workload mix, rollout, schedule, or collector changes require stratification or a better comparison.
- **Exclude:** simultaneous movement is association. A model name is not complete route/effort exposure; missing old artifacts invalidate detailed historical claims.
- **Priority/verify:** P1 for current material harm, otherwise P2. Verify recovery under a qualified comparison; leave causal strength explicitly labeled.

### A16 - Consider investment without confusing averages with marginal value

- **Combine:** untreated eligible opportunities + demonstrated mature attainment on comparable targets + sufficient capacity/budget/review headroom + explicit authority and blast-radius ceiling.
- **Sources:** C native value, target/runtime/cost inventory; H capacity when applicable; P opportunity counts, marginal scenario, and intelligence contract.
- **Act:** propose a small authorized review trial or obtain the next target's missing evidence. Do not automatically expand rollout or live authority.
- **Unknown route:** no opportunity denominator or target comparability -> acquire that evidence, not more runs.
- **Exclude:** high mean value does not establish the next target's marginal benefit; resource forecasts are scenarios, not proven future outcomes.
- **Priority/verify:** P2 with explicit cost/value trade-offs, or P1 for a contracted urgent unmet outcome. Verify new opportunity attainment and actual marginal resource/attention demand.

### A17 - Investigate unintended disability or stalled execution

- **Combine:** fresh workflow/job state + authoritatively expected service/work + absent execution progress or unexpected disabled activation + exceeded phase/deadline contract + collection readiness and pause/wait evidence.
- **Sources:** C registry/runtime observations; U activation history, job/step progress, wait/approval/concurrency diagnostics; H executor state if available; P service-duty, progress, and state-interval contracts.
- **Act:** classify intentional pause, healthy idle, admission wait, explicit blocker, and suspected stall first. Inspect the exact activation or blocked/progress edge; route to its owner for an authorized reversible correction.
- **Unknown route:** missing progress/history/intent -> acquire that observation and report unknown activity. Missing collection -> A14. Never infer a stall from `in_progress` age alone.
- **Exclude:** disabled workflow is not a disabled/failed run; legitimate maintenance, no eligible work, long permitted calls, and known recovery are not unexplained inactivity. Do not auto-enable or redispatch.
- **Priority/verify:** P1 when required work or a deadline is blocked, otherwise P2 investigation/P3 observation. Verify observed progress and eventual contracted completion; compare on-time, waits, and unknown coverage without rewarding useless work.

### A18 - Investigate a campaign-wide common blocker once

- **Combine:** failures or supported inherited blockage on at least two distinct related workflows in one campaign + comparable phase/window/revision + an exact shared parent/dependency or equivalent structured underlying diagnostic.
- **Sources:** C campaign/workflow/runtime/error associations; U compilation, manifest/installation, policy, envelope, import/version, and job diagnostics; P phase-aware failure matrix and dependency correlation.
- **Act:** open one bounded campaign-level investigation, retaining child symptoms. Test compiler/shared-import exposure, campaign configuration, or the observed common admission/runtime dependency with failed and unaffected representatives; widen to A03 only when cross-campaign evidence supports it.
- **Unknown route:** generic error text, campaign co-membership, or absent workers -> obtain the underlying diagnostic and expected dependency/dispatch evidence.
- **Exclude:** legitimate sibling variants, unrelated target failures, and collection outages. One failed parent can explain many blocked children but cannot manufacture child attempts or multiply root-incident counts.
- **Priority/verify:** P1 for current required execution blockage, otherwise P2. Verify the corrected compiler/configuration/dependency path and recovery across affected sibling workflows, with unchanged policy/safety boundaries and an unaffected comparison.

### A19 - Relieve a confirmed shared API bottleneck

- **Combine:** confirmed quota/throttle diagnostics + shared non-secret quota-pool identity + linked retry/backoff/queued obligations + increasing wait/deadline pressure or repeated limiting episodes.
- **Sources:** C run-linked quota snapshots and correlated tool errors where present; U request-level headers/diagnostics, logical request identity, and API units; H provider/queue telemetry when authorized; P pool-level throttle and wait computation.
- **Act:** respect provider backoff/reset, stop invalid repeated retries, and propose bounded shared acquisition/precompute, staggered admission, or a quota-aware service budget at the limiting pool.
- **Unknown route:** snapshot-only or `exhausted` with unknown remaining -> request exact numeric/response evidence. Missing request coverage -> report observed hit counts and incomplete frequency/rate evidence, not a fleet-wide zero.
- **Exclude:** permission/authentication denial, query/time/resource limits, and low primary headroom without confirmed throttling. Do not rotate credentials, poll aggressively, increase parallelism into the same limit, or widen authority.
- **Priority/verify:** P1 for active critical blockage, otherwise P2 prevention. Verify fewer confirmed limiting episodes, lower backoff/retry amplification, and improved deadline attainment with preserved outcome/assurance and no starvation.

### A20 - Rebalance eligible jobs at the actual limiting resource

- **Combine:** runnable admitted/expected work + uneven queue age/deadline pressure + saturated/idle comparable resource evidence + feasible executor compatibility + measured downstream and quota headroom.
- **Sources:** C run/job/target/concurrency observations where retained; U compiled concurrency, job phases, and resource compatibility; H runner/queue/capacity providers; P resource graph, service allocation, and time-weighted utilization.
- **Act:** test one reviewed admission, schedule-staggering, priority-share, or compatible placement change. If a shared dependency/quota is limiting, repair that prerequisite rather than adding workers.
- **Unknown route:** absent capacity/phase/compatibility telemetry -> acquire it; raw run duration or job-count differences alone cannot justify rebalancing.
- **Exclude:** intentionally unequal service, security isolation, different job size, required serialization, human approval, and idle periods without ready work. Do not promise durable/FIFO queues from coarse pending status.
- **Priority/verify:** P1 for threatened critical deadlines, otherwise P2. Verify lower wait and tail age, fair contracted service, fewer admission cancellations where relevant, and unchanged outcomes/security within each constrained resource pool; increased utilization alone is not success.

### A21 - Restore the first broken activation or harness boundary

- **Combine:** eligible expected execution + exact first failed/skipped required phase + source/lock/runtime/import/checkout provenance + structured setup/authentication/endpoint diagnostic.
- **Sources:** C conclusions and bounded errors where collected; U activation/agent/job artifacts, resolved prompt, compiled job DAG, version pins, trust filters, and non-secret credential-flow metadata; P expected-phase contract.
- **Act:** distinguish activation exclusion, stale configuration, wrong checkout/ref, missing runtime/skill/plugin, MCP startup, inference authentication, API authentication, and model/endpoint compatibility. Propose one correction at the observed boundary before changing the prompt or budget.
- **Unknown route:** request the owning job/step and actual resolved version/configuration. Model alias, local CLI version, or final wrapper error alone is insufficient; do not inspect secret values or start MCP servers merely to discover capabilities.
- **Exclude:** intentional role/fork/integrity/cooldown/stop conditions, custom host jobs outside the agent sandbox, and unverified provider/runner readiness. A local compile or mock does not prove hosted authentication.
- **Priority/verify:** P1 for current required execution blockage, otherwise P2. Verify the exact corrected phase on an authorized test path and subsequent required phases, preserving trust, network, credential, and policy boundaries.

### A22 - Reconcile requested outputs with actual effects and follow-through

- **Combine:** required output/action contract + emitted request/item manifest + validation/staging/detection/approval/handler evidence + exact native destination/action identity + observed downstream CI/review/outcome state.
- **Sources:** C outputs/findings/values where mapped; U safe-output items/errors, temporary-ID resolution, actual write receipts, CI actor/commit, and native outcome evidence; P action-specific state reconciliation.
- **Act:** identify whether work was not requested, intentionally no-op, previewed, rejected, capped, deduplicated, blocked, failed to apply, applied without expected CI, or still pending review/outcome. Correct only the broken required transition.
- **Unknown route:** target existence alone does not prove the intended action or acceptance. Missing artifact, unsupported evaluator, or unavailable CI/review evidence -> A02/A14 and retain unknown.
- **Exclude:** staged previews are not applied writes; green agent/run state is not delivery; lifecycle-bot closure is not necessarily rejection. Default-token event suppression may explain absent CI, but enabling extra effects requires explicit authorization.
- **Priority/verify:** P1 for a current critical delivery/verification blocker; P0 containment only for observed exposure under A01; otherwise P2. Verify exact action receipt, required CI/review, and mature native outcome without widening safe-output destinations or bypassing gates.

### A23 - Diagnose memory, cache, or persistent-state corruption

- **Combine:** repeated/skipped/contradictory work + restore/save/validation/merge evidence + exact state key/branch/revision/schema + changed input/task fingerprint or concurrent writer.
- **Sources:** C repeated-work/error/quality signals; U cache-memory/repo-memory artifacts, retained checkpoints, restore/save and conflict evidence; P scoped state-consumer contract.
- **Act:** distinguish eviction/cold start, stale fallback restore, invalid schema, cross-scope reuse, missed save, lost cursor advancement, or concurrent overwrite. Test a bounded rebuild/repair against authoritative input; preserve useful history and approved persistence boundaries.
- **Unknown route:** absent state history means unknown continuity. Do not infer that the previous task completed or that clearing all memory is safe.
- **Exclude:** Actions cache-memory, Git repo-memory, reusable evidence cache, and provider prompt caching have different semantics. Retention settings, successful restore, or a matching hash do not prove semantic correctness.
- **Priority/verify:** P1 when required work is incorrectly skipped or blocked, otherwise P2. Verify state validation, correct replay/recovery, cursor fairness, no duplicate effects, and preserved assurance/outcomes; do not hide corruption by deleting evidence.

### A24 - Optimize the full model, context, and delegation harness

- **Combine:** comparable eligible tasks + actual model/effort/endpoint/router exposure + parent/classifier/sub-agent/caching/setup costs + context/tool-response and fallback evidence + frozen quality/coverage contract.
- **Sources:** C compact usage/tools/assignments/graders where retained; U per-request routing, resolved prompt/skills, delegation/session events, prompt-cache usage, and provider pricing; P full-path comparison.
- **Act:** choose one measured intervention: early deterministic triage, bounded acquisition, on-demand skills, tool/CLI proxy, stable prompt prefix, bounded batching, compatible delegated extraction, or task-sensitive route. Repair failed/incompatible delegation before interpreting a cheap-model trial.
- **Unknown route:** missing child/classifier costs, resolved model, registration/activation evidence, or quality coverage -> obtain it; do not price the run from the configured model name.
- **Exclude:** engine aliases and sub-agent frontmatter are not portable; unsupported endpoints, hidden parent fallback, and model-policy denials are not prompt-quality problems. Prompt-cache discounts and cheaper tiers are provider/version dependent, not guaranteed savings.
- **Priority/verify:** P2 optimization, or P1 via A21/A06 for an active harness failure. Measure total Actions/inference/assurance path and escalate through A13 only after quality, outcome, safety, coverage, and uncertainty gates pass.

### A25 - Reconcile campaign installation, deployment, and work delivery

- **Combine:** declared campaign/package intent + expected owned sources/resources/imports/workers + installation/update/deployment revision + observed trigger/admission/dispatch/delivery state.
- **Sources:** C inventory/policy/runtime associations; U manifests, ownership/materialization receipts, source/lock/worker profiles, native queue/Claim/effect receipts when used; P lifecycle reconciliation and expected-obligation contract.
- **Act:** locate incomplete root/component installation, incompatible minimum version, source/lock/import drift, partial rollout, orphaned ownership, unresolved deployment, or completion-without-delivery. Propose an owner-reviewed package/campaign operation or repair at that boundary.
- **Unknown route:** missing ownership/deployment/Claim lineage -> acquire it; a configured worker, backing issue, or absent queue before first accepted submission does not establish failed admitted work.
- **Exclude:** raw Actions YAML and deterministic infrastructure do not inherit all agent-job controls. Native queue adoption does not replace CAO scope/mode policy, grant target-file authority, or permit CAO workers to dispatch children. Claim scheduling fairness is not CPU-time or outcome fairness.
- **Priority/verify:** P1 for current contracted blockage, otherwise P2 lifecycle repair. Verify owned-file/materialization consistency, exact deployed revisions, and required native delivery/outcomes; retain uncertain launch/termination reservations until trusted resolution.

## Prioritizing the next actions

Separate **urgency**, **decision class**, **evidence strength**, and **execution eligibility**. For example, an urgent safety hold can be justified while its proposed remediation remains unauthorized.

| Priority | Meaning | Typical next action |
| --- | --- | --- |
| P0 | Current exposure, authority breach, or imminent failure of a non-compensable gate | Contain/hold and involve the responsible authority now. |
| P1 | Current blocked operation, overdue critical outcome, or decision-critical evidence outage | Restore the prerequisite or investigate the bounded failure. |
| P2 | Supported improvement, capacity adjustment, investment, simplification, or validation trial | Schedule the smallest feasible reversible action. |
| P3 | Weak/incomplete nonurgent hypothesis or observation without a practical threshold breach | Watch, defer, or acquire one discriminating fact. |

This is an explicit proposed service policy, not a scientifically universal severity scale. Consequence classes, due dates, delay budgets, and escalation paths must be declared by owners.

Use this deterministic sequence:

1. Remove infeasible interventions that fail policy, authority, security, approval, prerequisite, or capacity gates. Retain the explanatory hold/evidence action.
2. Coalesce candidates using exact subject, episode, condition, dependency, and intervention identities. Do not merge unrelated errors merely because their text or generic code matches.
3. Suppress equivalent active work, unchanged terminal feedback, legitimate recovery, and declared cooldowns; disclose why and when to reconsider. Never suppress a new safety breach behind an ordinary recovery cooldown.
4. Attach prerequisite edges to actions. A broken evidence provider that blocks three decisions becomes one repair prerequisite, not three independent diagnoses. A campaign/compiler/API root blocker likewise retains its affected children without counting each child as a separate cause.
5. Assign P0-P3 from observed consequence and deadline, independently of raw cost.
6. Within a priority lane, consider declared consequence, time remaining before the latest safe/useful start, and distinct eligible decisions/opportunities actually unblocked.
7. For comparable interventions, eliminate Pareto-dominated options: no better on any material dimension and strictly worse on at least one, with uncertainty and safety held constant.
8. Compare defensible conservative benefit and resource requirements only within compatible units/contracts. Keep AIC, native value, reviewer time, delay, and risk separate when they are incomparable.
9. If remaining candidates are incomparable, expose the trade-off and request a recorded owner preference; do not invent conversion weights. Unknown deadlines/severity/benefits remain unknown.
10. Select only actions that fit declared executor, concurrency, shared API/quota, downstream review, and human-capacity ceilings, preserve dependencies, and use stable IDs to break otherwise equivalent ties. Enforce declared minimum service/maximum wait so throughput optimization cannot silently starve a campaign.

The output is a constrained ordered portfolio, not a single universal score. Publish the immediate next action plus a bounded backlog with its ordering rationale.

## Missing evidence and the value of the next question

An evidence action should name two or more competing explanations and the one observation that would change the decision.

Example: "Are workers absent because dispatch was denied, or because collection missed the run? Inspect the authoritative dispatch receipt and corresponding run registry, not all historical tool logs."

Prioritize an acquisition when:

- its answer can change a pending feasible decision;
- the decision has meaningful consequence or avoidable recurring cost;
- the source can answer before the decision deadline or retention expiry;
- acquisition is authorized and bounded; and
- a cheaper already-available observation cannot discriminate the explanations.

If probabilities and utilities are defensible in common units, expected value of sample information is:

```text
EVSI = E_over_possible_observations[max_action E[utility(action) | observation]]
       - max_action E[utility(action)]
net_information_value = EVSI - acquisition_and_delay_cost
```

Do not assign invented probabilities to calculate this. Without calibrated probabilities or comparable utilities, use the qualitative decision-changing test and preserve trade-offs.

## Cost accounting that cannot reward doing less work

- Keep **cost of successful attempts / successful attempts** separate from **total scoped spend / successful episodes** and **total attributed spend / mature accepted opportunities**.
- The successful-attempt metric currently used by some views excludes failed-attempt cost. It is useful diagnostic evidence, not an end-to-end unit-economics measure.
- For an optimization trial, account for precompute, main agent, retries, threat detection, verification, and incremental collection/coordination cost where attributable. Also disclose reviewer effort and outcome delay.
- Do not add invocation AIC and its matching run-aggregate AIC. Do not count `tool.call` and `tool.result` as two independent invocations.
- Allocate shared orchestrator/collection cost once under a disclosed rule; never charge the whole shared cost to every target or quietly exclude it.
- Observed friction cost is not guaranteed recoverable savings.
- Forecast recurring savings as comparable per-episode cost reduction times future eligible episode count, with workload/cadence assumptions and uncertainty. Subtract intervention and operating costs when their units permit it.
- Missing cost components create a partial estimate, not a measured zero or a savings guarantee.
- AIC is a provider/model-aware best-effort pricing measure, not an invoice. Retain pricing/catalog version and custom rates; a catalog change can move reported AIC without changing token work or billed spend. Include Actions runner/setup minutes separately instead of treating inference savings as whole-system savings.

## Worked prioritization example

The following is synthetic, not a finding about the current dashboard:

| Candidate | Evidence | Next action | Priority and ordering rationale |
| --- | --- | --- | --- |
| Unsafe output | Threat confirmed and an application edge exists despite a required gate | Authorized containment and inspect the implicated application | P0: current exposure outranks every efficiency opportunity. |
| Missing usage evidence | 40 known completed runs; only 30 have usable cost evidence; three optimization comparisons depend on that source | Recover the ten missing artifacts or record their expiry; recompute only affected comparisons | P1 when these decisions are due: one prerequisite repair unblocks three decisions; totals/savings remain unavailable. |
| Shared tool failure | Equivalent structured MCP failure affects two campaigns; unrelated campaign still succeeds | Inspect the shared integration with failed/unaffected representatives | P1: active execution blocker; shared scope is supported, root cause is not yet proved. |
| Campaign compiler blocker | Two related workflow checks fail with the same shared-import diagnostic after a compiler change; another campaign's comparable check passes | Inspect the exact compiler/import/flags/revision combination, retaining blocked worker obligations | P1 when contracted work is blocked: one campaign-level investigation, not invented failed runs for every absent worker. |
| Unexpected disabled worker | Fresh registry says disabled, admitted work is due, and no accepted pause explains the mismatch | Inspect activation history and the declared service contract with the owner | P1 if required work is blocked; do not automatically re-enable or redispatch. |
| Shared API throttling | Confirmed throttling and explicit backoff on one installation/resource pool delay three campaigns; request enumeration is incomplete | Respect backoff and inspect pooled admission/shared acquisition | P1 for critical blockage: observed hits are real, fleet-wide hit rate remains unknown. More workers may worsen the problem. |
| Portfolio duplicate work | Three workers address one native opportunity with equivalent outcomes, duplicate reads/reviews, and no separate assurance requirement | Trial one shared preparation/coalesced work group | P2: one group-level recoverable-cost estimate, not three pairwise savings claims. |
| Review backlog | Distinct output arrivals exceed dispositions and oldest review age passes the declared deadline | Adjust review or output admission at the limiting stage | P1 if contracted critical work is overdue; otherwise P2. Faster generation does not fix it. |
| Cadence waste candidate | Complete legitimate no-op episodes, no novelty, high frequency; no allowed-delay contract | Obtain the delay/assurance requirement before testing a relevance gate | P3 evidence action: no supported schedule intervention yet. |
| Precompute trial | Repeated deterministic joins, complete inputs, cheaper replay cost, preserved graders; live outcome evidence not mature | Continue the bounded quality/outcome trial | P2: do not promote on grader/cost evidence alone when the outcome contract requires maturation. |

After containment, independent P1 investigations can proceed within capacity. A missing-cost prerequisite blocks affected optimization claims, not a security finding or unrelated reliable runtime fact.

## Action receipt

Every published action should carry:

- stable action ID, rule ID/version, input fingerprint, and computation version;
- class, priority, state (`act-now`, `decide-soon`, `investigate`, or `watch`), and execution eligibility;
- subject, exact episode/revision scope, observation window, and evidence cut;
- predicate results with measured numerators/denominators;
- observed symptom, supported hypothesis, and explicitly unproven cause;
- supporting/contradictory references, missing inputs, maturity, and truncation;
- one next action, responsible role, deadline, prerequisites, budget, and stop condition;
- alternatives: defer, do nothing, obtain evidence, and narrower reversible test;
- native expected benefit and costs, with uncertainty/assumptions or `unknown`;
- hard gates, chosen ordering rationale, and capacity trade-offs;
- shared root-blocker/duplicate-group identity, affected child obligations, quota/resource pool, and declared service/fairness constraints where relevant;
- verification, non-regression, rollback, and reconsideration criteria; and
- disposition/feedback bound to the same fingerprint.

An insight that cannot name its required input, next action, owner role, and verification condition is not ready to enter the action queue.

## Minimum useful implementation and validation

Do not start with embeddings, an unrestricted graph traversal, or a learned priority score.

1. **Evidence readiness:** implement A02/A14 with explicit required fields, typed gaps, expected arrival, source scope, retention, and dependency references.
2. **Hard-gate visibility:** implement A01 from authoritative enforcement/verdict evidence, without treating the findings-only view as complete detector coverage.
3. **Runtime scope:** implement A03/A04/A05 and A17/A18 from exact campaign, workflow, target, run, dispatch, and pre-run check relationships. Emit `unknown` when activation intent, progress, complete scope, or lineage is missing.
4. **One friction improvement:** implement A06/A07 against a bounded, recurrent episode; measure the full precompute + agent + assurance path.
5. **Promotion guard:** implement A13 before automatically recommending adoption of cheaper variants; add A08/A09/A10/A11/A12/A15/A16 only as their input contracts become available.
6. **Factory service and pressure:** instrument validated state intervals, quota/request scope, admission waits, and resource compatibility before A19/A20 or on-time/utilization claims. Retain unknown-time bounds and service deadlines.
7. **Portfolio coordination:** build A12 work signatures and duplicate/conflict groups across campaigns and sibling workers; begin with shared preparation before proposing retirement.
8. **Lifecycle completeness:** add A21/A22/A23/A24/A25 only with phase, effect, state, harness, and deployment evidence. Prefer this boundary coverage to adding sophisticated anomaly models over ambiguous observations.

For each initial rule, replay labeled historical episodes and run in advisory shadow mode before using it to admit work. Human review is a useful label but not automatic ground truth for an outcome.

Required behavioral fixtures include:

- true complete zero versus absent field versus explicit unavailable source;
- known run summaries with missing usage artifacts;
- canonical attempt 2 without retained attempt 1;
- empty threat-finding results without full detector-verdict coverage;
- two campaigns with the same generic wrapper but different underlying failures;
- complete target-specific contrast versus incomplete expected-target coverage;
- requested dispatch versus confirmed dispatch with an expired expected-arrival deadline;
- optional skipped stage versus a missing required stage;
- active legitimate recovery versus a new independent safety breach;
- review/application absence before maturity versus genuine overdue outcome;
- expired artifacts and left/right-censored episode history;
- missing hosted telemetry in a static deployment;
- correlated tool call/result and several audit views of the same source event;
- changed input fingerprint after prior accepted/rejected feedback;
- authorized bounded-age cache reuse versus violated consumer freshness;
- aggregate cost drop explained by changed workload mix;
- insufficient quality power versus evidence of acceptable non-inferiority;
- incompatible native operational-value measures;
- a prerequisite repair that coalesces several dependent evidence alerts without hiding unrelated failures;
- failed/timed-out execution versus intentional cancellation, healthy idle, and unexpectedly disabled service;
- queued/waiting versus validated execution-active intervals versus unknown progress;
- suspected stall with fresh observation and an exceeded phase contract versus a long legitimate call or stale collector;
- concurrent active jobs whose union on-time differs from summed slot-time;
- known-on/off/unknown intervals, zero duty/capacity denominators, and censored on-spells;
- canonical quota `exhausted` with unknown remaining versus a confirmed response-level primary/secondary throttle;
- shared quota pools, incomplete request denominators, overlapping backoff, and synchronized catch-up retries;
- same-campaign shared compiler/configuration blocker with no admitted worker attempts;
- saturated and idle resources that are incompatible or held by a real downstream/authority constraint;
- concurrency replacement/cancellation versus durable waiting, unequal job size, and campaign starvation;
- three-way overlap counted once versus inflated pairwise savings;
- similar intent with distinct outcomes/independent assurance versus duplicate or conflicting work on the same native opportunity;
- body-only instruction change without a lock change versus stale frontmatter/import configuration;
- activation PR-base configuration versus agent PR-head/target checkout;
- inferred lineage and partial upstream episode rollup versus authoritative dispatch and complete costs;
- engine auth success with API/safe-output auth failure, or a model/endpoint 400 with a green parent fallback;
- integrity-filtered input versus true no eligible work versus acquisition failure;
- staged built-in output with custom or persistent side effects versus verified applied delivery;
- detected threat versus missing verdict in warn/strict mode versus intentionally disabled analysis;
- fallback/unified/legacy artifact presence, delayed upload, expiry, and denied audit access;
- cache eviction versus stale fallback restore, invalid memory, concurrent overwrite, and lost task cursor;
- complete trace continuity versus sampled/missing spans and overlapping phase durations;
- native Work/Claim assignment versus uncertain launch, Completion without Result, and unresolved reservation;
- legitimate lifecycle closure versus rejection, weak existence evidence versus accepted action; and
- achieved campaign goal/deadline with continued production versus required ongoing assurance.

Measure rule precision, high-consequence condition recall, false escalations, time to diagnosis/recovery, duplicate actions, missing-evidence resolution, reviewer demand, and native outcomes. Ground-truth coverage and unlabeled cases must be reported separately; selective human feedback cannot establish overall recall.

For optimization rules, also measure cost, coverage, assurance, quality, and outcome degradation. Record the realized result of the recommended action, not merely whether the user clicked or accepted it.

Changing a predicate, input meaning, threshold, missingness rule, priority ordering, or evaluator requires a version change and replay of the affected fixtures. Recompute changed partitions rather than rescanning the whole portfolio.

# Frontier check: decision experience, not a prettier dashboard

**Research cut:** 2026-10-15. **Verdict:** the Action Center is a strong deterministic foundation, but a ranked card list plus four charts is not, by itself, frontier UX or a unique product. "Mobile-first" also needs an interaction contract, not merely a responsive layout.

This check combines current primary product documentation, original process-monitoring/RCA research, human-AI research, and accessibility/performance guidance. It is not an exhaustive market or patent search. Living product documentation establishes documented capabilities, not independent effectiveness. Preprints and preliminary evaluations retain those labels.

## What is already available, and what recent research actually adds

| Primary source / date | Supported finding | Design consequence / limit |
| --- | --- | --- |
| [Datadog Bits investigations](https://docs.datadoghq.com/bits_ai/bits_investigation/investigate_issues/), living docs | Alert-triggered/manual investigations, cross-telemetry analysis, likely-cause findings and recommendation-card entry points are documented. | AI summaries and investigation cards are not a sufficient differentiator. Documentation is not a controlled comparison of operator outcomes. |
| [Grafana Assistant Investigations](https://grafana.com/blog/grafana-assistant-ga-assistant-investigations-preview/), 2025-10-08 announcement | Specialized agents collect evidence, explore hypotheses and suggest mitigation; the announcement introduced investigations as a preview. | Parallel investigation and natural-language interaction are established product patterns, not novel CAO inventions. A historical preview announcement does not establish today's release status. |
| [Palantir staged proposals](https://www.palantir.com/docs/foundry/logic/aip-logic-integration-automate), living docs | Proposed Ontology edits can be staged for review; proposals expose a decision log before acceptance. | Human-review staging already exists. Borrow inspectability, not write authority: the CAO dashboard remains advisory. |
| [SCOPE](https://arxiv.org/abs/2512.17629), first posted 2025-12; v2 2026-06 | Sequential intervention recommendations use backward induction and causal learners; experiments use synthetic and semi-synthetic process data. | Plan sequences, not isolated fixes. Identifiability requires sequential ignorability, positivity and SUTVA; shared quota/review resources can violate no-interference. This does not validate an autonomous CAO policy. |
| [Causal resource reallocation](https://aisel.aisnet.org/ecis2026/bus_analytics/bus_analytics/4/), ECIS 2026 | Offline causal modeling and online preprocessing support resource recommendations; the abstract reports preliminary ITSM evaluation and a further evaluation plan. | A credible frontier direction is intervention-aware, not just anomaly-aware. Treat it as early evidence, not a proven general balancing algorithm. CATE is `E[Y(1)-Y(0) | X=x]`, not an unqualified observed mean difference. |
| [ProCause](https://arxiv.org/abs/2509.00797), 2025 preprint; [SimBank](https://arxiv.org/abs/2506.14772), 2025 | Counterfactual evaluation depends on temporal structure/model choice; simulation can expose ground-truth outcomes unavailable in observational logs and probe confounding. | Use scenario evaluation to falsify bad policies. Simulated or generated counterfactuals remain model outputs, not observed CAO savings or independent production ground truth. |
| [RCA comparative evaluation](https://arxiv.org/abs/2408.13729), ASE 2024; [RCAEval](https://github.com/phamquiluan/RCAEval), WWW 2025 benchmark | Evaluated causal RCA methods trade effectiveness, efficiency and parameter sensitivity; synthetic performance does not reliably represent real systems. RCAEval supplies reproducible failure cases/baselines. | Avoid a portfolio-wide inferred causal graph as the default. Start with typed dependencies, witnessed propagation and competing explanations; benchmark any learned RCA separately. |
| [Human-AI performance meta-analysis](https://pmc.ncbi.nlm.nih.gov/articles/PMC11659167/), Nature Human Behaviour, 2024-10 | On average in the analyzed experiments, combinations improved on humans alone but did not outperform the better human/AI baseline; task type moderated performance. | AI assistance is not automatic synergy. Compare decision correctness against credible baselines, not just the old dashboard's speed or operator enthusiasm. This synthesis is not a CAO field trial. |
| [Diagnostic/prognostic uncertainty study materials](https://research.tudelft.nl/en/datasets/code-underlying-the-publication-dealing-with-uncertainty-understa/), CHI 2024 | The primary materials document a study of uncertain diagnostic versus prognostic human-AI tasks. | Test "what happened?" separately from "what will happen?". The materials alone do not establish that a particular confidence widget improves CAO decisions. |
| [Appropriate reliance measurement](https://arxiv.org/abs/2604.23896), 2026-04 preprint | The review distinguishes trust, mere reliance and appropriate reliance; it reports fragmented measurement constructs. | Measure correct acceptance and correct rejection of advice, not trust surveys/clicks alone. Fragmentation does not mean appropriate reliance is impossible to measure. |
| [Deferral with congested experts](https://arxiv.org/abs/2610.15128), submitted 2026-10-10, preprint | The formulation couples uncertain LLM reliability, capacity-limited expert review and selectively observed, queue-delayed labels; evaluation uses synthetic and question-answering datasets. | Evidence acquisition/review consumes scarce capacity too. Consider arrival before the decision deadline, but never bypass mandatory assurance because reviewers are busy. QA results do not validate an operational routing policy. |
| [Provenance-aware belief updating](https://arxiv.org/abs/2610.13008), submitted 2026-10-09, preprint | Supplied report lineage and a training objective reduce repeated-evidence distortion in a controlled binary benchmark/closed-loop simulation on two model backbones. | A log quoted by an audit, summary and agent is still one originating observation. Carry lineage into evidence packets; this is emerging controlled evidence, not demonstrated production CAO benefit. |
| [Conformal Risk Control](https://arxiv.org/abs/2208.02814), foundational 2022 preprint | The method controls expected monotone loss under stated conditions, with extensions addressing particular settings. | Population risk/coverage is not a probability that this diagnosis is true. Dynamic compiler/model/workload changes require renewed assumption checks; no decorative confidence percentages. |
| [OpenTelemetry GenAI agent conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md), living development draft | Agent/workflow/plan/tool/skill spans provide candidate interoperable vocabulary; the documentation has moved to a separate GenAI repository. | Pin the convention version and validate actual emitted correlations. A vocabulary is not evidence that CAO already retains those spans, or permission to collect sensitive prompts. |

**Distinctive thesis:** a mobile **evidence-to-action observatory** that shows what changed, the smallest defensible next step, what would reverse that recommendation, conditional system consequences, and whether prior interventions actually worked. Each piece has prior art; the CAO-specific integration is a proposed differentiator, not a proven world-first.

## Five capabilities beyond an ordinary action inbox

These are cross-cutting computations over A01-A25, not replacements for their gates. New history, receipt, scenario and capacity inputs need explicit contracts. Store authoritative decision/intervention receipts as evidence sources, not persisted computation-result tables or browser-only operational truth.

### D01 - A change brief, not another status summary

Compare a current evidence cut with an explicit, same-scope last-reviewed cut:

```text
delta = compare(condition states, lane, gates, quality, dependencies,
                material deadlines, contradictory facts, verified outcomes)
```

- Show new, worsened, recovered and still-blocked conditions, with evidence for each transition.
- A source becoming stale is itself a change; a run count increasing is not necessarily an actionable change.
- Missing prior cut -> comparison unavailable, not "nothing changed". A local last-viewed marker is not a cross-device review receipt.
- A deterministic template is the default brief. Optional generated prose may explain the bounded packet, but cannot invent facts, rank actions or replace citations; generation failure leaves the computed evidence usable and the prose explicitly unavailable.
- Feed the same bounded packet to an investigator agent. Evaluate whole-path cost and diagnosis quality; do not assume that precomputation guarantees better reasoning.

### D02 - An inspectable evidence certificate with a challenge

Each action carries: trigger, applicability, source/revision, quality, supported and contradictory facts, alternatives, hard gates, ordering reason and verification.

Separate **observed fact**, **inferred hypothesis**, **scenario assumption** and **verified outcome**. A source citation does not automatically validate the inferred claim.
Carry originating evidence IDs and relay lineage through audits, summaries and agent packets. Count the origin once; distinct origins still need dependence checks before being treated as independent corroboration.

The first expansion answers: **"Why this now, rather than the next item?"** The second answers: **"Which observation would make us choose differently?"** Inspectable lineage is more useful than hidden reasoning or a fluent narrative presented as proof. Do not require disclosure of model chain-of-thought.

### D03 - Recommendation stability and the next discriminating question

Let `Theta` contain the explicitly admissible evidence completions/scenarios under one declared ordering contract. Define:

```text
rankRange(a) = [min_theta rank(a; theta), max_theta rank(a; theta)]
stableFirst(a) = a is first for every admissible theta
```

- Preserve uncertainty dependence and incomparable owner preferences; do not invent probabilities, utilities or exchange rates.
- Certify stability only with exhaustive enumeration or sound bounds over the declared domain. A few sampled scenarios establish only sampled stability; incomplete search -> indeterminate.
- If the leading action reverses, show the alternatives and the smallest authorized observation that can separate them before the deadline. Reuse the EVSI conditions above; rank by dependency/consequence when numeric EVSI is unjustified.
- Keep independently observed P0 exposure visible regardless of uncertain improvement rankings.
- Bound scenario count/query cost; report incomplete analysis rather than quietly narrowing the domain.

This is **sensitivity to assumptions**, not calibrated confidence. It makes missing data operationally useful: some gaps reverse the decision; others do not.

### D04 - Conditional intervention sequences and system consequences

Compare **do now / wait / acquire evidence**, including their prerequisites, deadlines, shared resources, downstream review and human attention. Query the typed obligation graph, not an unconstrained inferred causal network:

```text
unlocked(a) = distinct due obligations whose prerequisite formula
              becomes true after the explicitly assumed repair a
repairSets(o) = inclusion-minimal feasible repairs satisfying o's AND/OR prerequisites
```

- A single repaired edge is insufficient if another required blocker remains. Distinguish observed topology, conditional unlocks and modeled outcome effects.
- Coalesce shared repairs and sequences once; union affected obligations rather than summing overlapping descendants. Centrality/min-cut is not outcome value.
- Only a validated process/resource model supports duration/capacity forecasts. Without it, report conditional reach and unknown effect, not invented minutes saved.
- Respect quota, compatible executors, assurance, minimum campaign service and an explicitly selected operator attention budget; never hide P0 because a routine budget is exhausted.
- Acquisition/review is itself queued work: an answer arriving after the latest useful start cannot justify waiting. Delayed and selectively reviewed labels cannot represent all decisions without an appropriate evaluation design.
- Learned sequential prescriptions remain a later experiment. Shared-pool interference, unobserved confounding and unavailable treatment alternatives can defeat identification; evaluate at the appropriate resource-cluster level.

### D05 - Decision episodes that close the loop

Join **condition -> reviewed decision -> externally authorized intervention -> effect receipt -> matured verification**. These are different events; an accepted suggestion is not successful delivery.

- Match recurrent cases by phase, dependency, work signature, contract and revision context. Retrieve contrasting cases and failed fixes, not just similar successful narratives.
- Preserve concurrent changes, spillovers, outcome maturity and missing counterfactuals. A post-action improvement is not automatically caused by the action.
- Revalidate reuse when compiler, model, campaign policy or evidence contracts shift. A prior resolution is an investigation lead, not a universal playbook.
- Learn from verified outcomes and disconfirmations, not engagement. Any changed rule remains versioned, reviewed and shadow-tested; no silent self-modifying priority policy.

## Mobile-first and modern is a task contract

The phone experience is a **brief -> decision -> proof -> follow-through** loop, not a desktop matrix shrunk to fit.

1. **First viewport target:** at 360x640 CSS px/default text, scope, evidence age/quality, changed-condition brief and one next-action card. Smaller/zoomed layouts reflow without losing content. Other actions follow vertically; four navigation destinations are Now, Flow, Blockers and Improve. A complete quiet state and an unavailable state look different.
2. **Card hierarchy:** next step is the heading; consequence/why now comes next; owner/deadline and known affected scope follow. Use one compact phase strip only where phase evidence exists. Put raw counts, full proof and resource trade-offs behind expansion.
3. **Evidence on demand:** a full-width phone sheet and desktop side panel share the same certificate. Use semantic dialog/region behavior, return focus, preserve route/scope and disclose uncertainty before any optional AI explanation.
4. **Stable live updates:** update facts/status promptly, but defer rank movement of the engaged list until an explicit refresh. Announce a new critical condition immediately without moving the control under the operator's finger. A resolved/stale recommendation cannot remain visually actionable; disclose the newer order.
5. **Accessible alternatives:** blocker graphs/swimlanes have equivalent semantic lists/tables with edge meaning, gaps and scope. No hover-only facts, swipe-only decisions, color-only states or missing-data interpolation. Keyboard and screen-reader users get the same next step.
6. **Primer-native visual language:** strong typographic hierarchy, semantic tokens, restrained elevation, generous separation between actions, compact secondary metadata, light/dark themes and reduced motion. No ornamental animation, giant force-directed hairball, universal health dial, or chatbot as the only navigation.
7. **Concrete usability gates:** reflow at 320 CSS px; product target 48x48 CSS-px primary controls; visible unobscured focus; representative mobile/desktop task tests. Android's 48dp is platform guidance, not a CSS-unit equivalence; WCAG 2.2 AA's target minimum is 24 CSS px with defined exceptions.
8. **Responsiveness:** target field p75 LCP <=2.5s, INP <=200ms and CLS <=0.1, separately by mobile/desktop; also measure time to a usable action after worker evidence settles. These are targets, not current measurements. Do not show a fabricated healthy brief while slow/partial evidence loads.

The accessibility basis is [WCAG reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html), [target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html), [focus visibility](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html), and the informative [WAI complex-image tutorial](https://www.w3.org/WAI/tutorials/images/complex/). See [Android touch guidance](https://developer.android.com/guide/topics/ui/accessibility/apps), [Primer accessibility](https://primer.style/accessibility/), and [Core Web Vitals threshold methodology](https://web.dev/articles/defining-core-web-vitals-thresholds), updated 2025-05. Meeting these gates is necessary UX discipline, not proof of unique design or better analysis.

## Proving better insights, not just a novel appearance

Compare three experiences using the **same evidence and authority**: current drill-down views; the initial ranked inbox; the proposed brief/certificate/stability/replay experience.

- Use counterbalanced realistic tasks on phones and desktops, including shared compiler failure, partial quota evidence, intentional disability, three-way duplicate work, an unsafe effect with missing cost, and an inconclusive optimization.
- Predeclare correct action/acceptable alternatives, evidence needed and forbidden conclusions with domain experts; adjudicate disputed labels. Include bad advice so correct rejection can be measured.
- Measure decision correctness, false escalation, missed consequential conditions, inappropriate acceptance/rejection, task time, evidence-open count, workload and accessible task completion. Do not optimize solely for trust, speed, card clicks or fewer investigations.
- Replay independent historical periods and deployments; hold out related episodes together to avoid leakage. Synthetic fault injection has known labels but does not establish production generalization.
- Evaluate each D01-D05 addition separately; a certificate or scenario tool that adds effort without improving decisions should be simplified or removed.
- Track intervention verification and mature native outcomes in shadow/live authorized evaluation. Keep diagnosis quality, interface benefit and operational causal impact as separate claims.
- Set improvement/non-inferiority margins with owners before evaluation; require defensible uncertainty and retained safety/coverage. No universal "best" claim without task-specific comparative evidence.

**Delivery:** first D01/D02 plus the phone task contract; then bounded D03/D04; then D05 and carefully evaluated sequential learning. The product promise is **"a defensible next action and its decision boundary"**, not "AI knows the root cause."

# Upstream documentation audit and end-to-end lifecycle

**Audit date:** 2026-10-15. The coverage review is anchored to [github/gh-aw revision af6f1e3](https://github.com/github/gh-aw/tree/af6f1e3c4103e18ddf2ae62e4aa0261714d90aaa/docs/src/content/docs), with its workflow, campaign, debugging, optimization, and telemetry guides. The locally installed CLI reported `v0.91.5`; that does not identify the compiler, action, engine, firewall, gateway, detector, or worker revision used by any historical run.

This is a scoped lifecycle audit, not a claim that every reference page, adapter, experimental feature, and provider was exhaustively validated. The important additions are mechanisms previously absent or only named at high level. Upstream documentation is evidence about intended behavior, not proof that a feature is installed, enabled, instrumented, or behaving as documented in CAO.

## Coverage matrix: missing corners and connected evidence

| Corner | Source and newly explicit connections |
| --- | --- |
| Source versus executable configuration | [Working with workflows](https://github.github.com/gh-aw/guides/working-with-workflows/) and [compilation](https://github.github.com/gh-aw/reference/compilation-process/): Markdown body is runtime-loaded; frontmatter changes require compilation. No lock diff does not prove no behavior change. Correlate resolved prompt/import fingerprints, lock/compiler metadata, and exact run/checkout refs. |
| Imported capability and dependency graph | Compilation resolves imports and builds conditional jobs. Network unions, tool merges, overrides, and permission requirements can change effective capability. Analyze the resolved configuration and actual generated DAG, not one source file or one universal sequence. |
| Campaign installation and retirement | [Package manifest](https://github.github.com/gh-aw/reference/aw-yml-package-manifest/) and [campaign guide](https://github.com/github/gh-aw/blob/af6f1e3c4103e18ddf2ae62e4aa0261714d90aaa/.github/aw/campaign.md): minimum version, included manifests/resources, destination clashes, owned files, worker pins, materialization, goal/deadline, and partial rollout belong in lifecycle evidence. A campaign is more than shared naming. |
| Trigger/activation disposition | [Triggers](https://github.github.com/gh-aw/reference/triggers/), [fork rules](https://github.github.com/gh-aw/reference/fork-support/), and [rate controls](https://github.github.com/gh-aw/reference/rate-limiting-controls/): actor/role, event type, path/label/search conditions, cooldown, stop-after, daily admission, fork restrictions, and approvals explain intentional exclusion. Distinguish their reasons from unmet work. |
| Configuration checkout versus task checkout | [Checkout](https://github.github.com/gh-aw/reference/checkout/): activation may use trusted PR-base/callee configuration while the agent works on another head/target/ref. Wrong history depth, sparse paths, missing PR head, and cross-repository auth can change evidence without changing the prompt. |
| Authentication and trust filtering | [Authentication](https://github.github.com/gh-aw/reference/auth/) separates inference and GitHub operations; reads/writes/plugins/detectors may use different credentials. [Integrity filtering](https://github.github.com/gh-aw/reference/integrity/) can remove input and emit `DIFC_FILTERED`; empty visible results are not necessarily empty source data. |
| Runner/bootstrap/custom-step boundaries | [Architecture](https://github.github.com/gh-aw/introduction/architecture/) and [steps/jobs](https://github.github.com/gh-aw/reference/steps-jobs/): pre-checkout, preprocessing, pre-agent, post-agent, custom jobs, and raw Actions workflows are separate effect/trust surfaces. Deterministic steps run outside the agent firewall; preprocessing is not automatically harmless or free. |
| Engine/model/endpoint compatibility | [Model routing](https://github.github.com/gh-aw/reference/model-routing/) and [engine diagnosis](https://github.com/github/gh-aw/blob/af6f1e3c4103e18ddf2ae62e4aa0261714d90aaa/.github/aw/debug-model-engine-misconfiguration.md): resolved aliases, effort, endpoint, catalog/policy, CLI versus SDK, actual compiler, and independent runtime pins matter. A successful parent can hide failed sub-agent work. |
| MCP/skill/plugin availability | [Gateway](https://github.github.com/gh-aw/reference/mcp-gateway/) and [skills guide](https://github.com/github/gh-aw/blob/af6f1e3c4103e18ddf2ae62e4aa0261714d90aaa/.github/aw/skills.md): declaration, resolved pin, installation, registration, activation, usable schema, and invocation are different observations. On-demand inline skills and proxy modes are testable context/startup optimizations. |
| Persistence and repeated work | [Cache memory](https://github.github.com/gh-aw/reference/cache-memory/) and [repo memory](https://github.github.com/gh-aw/reference/repo-memory/): eviction, fallback restore, schema/file bounds, validation, save failures, concurrent overwrite, cursor loss, and branch scope can cause duplicate or silently skipped work. Memory is data, not authority. |
| Budget, concurrency, and pacing | [Cost management](https://github.github.com/gh-aw/reference/cost-management/) and [concurrency](https://github.github.com/gh-aw/reference/concurrency/): step/job/detector timeouts, per-run/daily admission, manual bypasses, per-engine serialization, output caps, and queue/cancellation behavior can explain latency and incomplete work. Observe effective deployed settings rather than copying defaults from prose. |
| Output request versus effect | [Safe outputs](https://github.github.com/gh-aw/reference/safe-outputs/), [staging](https://github.github.com/gh-aw/reference/staged-mode/), and [CI](https://github.github.com/gh-aw/reference/triggering-ci/): request validation, caps/deduplication, temporary IDs, handler/API failure, actual destination receipts, preview, approval, and CI follow-through all precede accepted outcome. Omitted safe-output configuration is not necessarily zero output capability; upstream can auto-enable a default issue output. |
| Detection configuration versus assurance | [Threat detection](https://github.github.com/gh-aw/reference/threat-detection/): enabled state, implementation flag, binary verification, engine, independent budget, warn/strict continuation, verdict, and actual enforcement must all be observed. A warning, detector failure, intentional skip, and verified threat are different. |
| Artifact and telemetry completeness | [Artifacts](https://github.github.com/gh-aw/reference/artifacts/), [audit](https://github.github.com/gh-aw/reference/audit/), and [OpenTelemetry](https://github.github.com/gh-aw/reference/open-telemetry/): unified/legacy/fallback uploads, artifact selection, expiry, denied download, absent baseline, partial spans, and broken trace continuity limit diagnosis. Audit assessments remain interpretations, not new observed causes. |
| Durable coordination and delivered outcomes | [Native work queue](https://github.github.com/gh-aw/reference/work-queue/) and [outcomes](https://github.github.com/gh-aw/reference/outcomes/): Work/Claim/reservation/launch/Completion/Result and action-specific acceptance differ. Backing issues and completed workers are not independently verified effect delivery or actor-independent CAO operational value. |

Some upstream passages differ in scope or emphasis, including daily-credit accounting and detector failure handling. Do not resolve a documentation discrepancy by assuming the most convenient behavior. Record it, inspect the applicable version's emitted lock/runtime metadata and enforcement evidence, and withhold the unsupported conclusion. Compiler `--strict` is not proof of strict detector enforcement.

## End-to-end phase ledger

For each workflow/campaign variant, derive required/optional phases from the actual compiled job DAG and CAO contract:

| Phase | Minimum evidence | What completion does not prove |
| --- | --- | --- |
| Author/package/install/update | Manifest/source/import/resource revisions, ownership, materialization, compiler compatibility | Complete deployment, target authority, or correct behavior |
| Compile/validate/publish | Source/lock fingerprints, compiler/action/runtime pins, warnings, job DAG, reviewed remote SHA | Hosted readiness, scanner coverage not run, or live execution approval |
| Event/eligibility/pre-activation | Event/actor/input identity, filters, scope, schedule and skip/hold reason | Expected agent execution for excluded work |
| CAO policy/admission | Exact policy SHA, campaign/worker enablement, enrolled target, mode, quota/admission outcome | Model/tool capability or credential reach |
| Activation/configuration | Configuration checkout SHA, resolved imports/prompt, experiment assignment, trust filtering | Task checkout identity or successful inference |
| Deterministic setup | Custom steps, checkout/runtime/dependency/cache/precompute/skill/plugin receipts | Agent-sandbox enforcement on those custom host effects |
| Engine/gateway start | Actual engine/CLI/firewall/gateway versions, model/endpoint, non-secret auth outcome, tool registration | A usable tool, eligible source coverage, or successful child agent |
| Reasoning/tool/delegation | Correlated requests/results/errors, context and route, progress/waits, limits, child/fallback evidence | Correct diagnosis, useful outcome, or every required task completed |
| Output/detection/assurance | Structured requested items, schema/cap/dedup results, required verdict/evaluator, enforcement | An applied write or approval where staging/holds intervene |
| Safe handler/application | Exact destination/action, API result/native receipt, effect identity, approval/staging state | CI started, human acceptance, or mature repository improvement |
| Conclusion/persistence/export | Per-job conclusion, memory/cache save, usage/agent/fallback/item artifacts, trace export | Complete telemetry, successful persistence, or delivered queue Result |
| CI/review/native outcome | Exact action/commit/actor and action-specific state with maturity/evidence strength | Causal campaign benefit or CAO operational-value attainment |
| Campaign feedback/stop | Contracted goal/deadline, continuing opportunities/assurance, suppression/cooldown, ownership | Permission to continue production, disable assurance, or widen rollout |

These phases may branch and overlap. A reusable workflow can share a GitHub run ID; a distributed worker normally has another. Preserve explicit relationships and classify inference when upstream `.edges` reconstruct lineage. Upstream `.episodes` totals cover the included runs only; high lineage confidence is not complete episode coverage. `total_duration` can sum run durations rather than represent elapsed wall time.

The behavior fingerprint should distinguish source body and resolved prompt, frontmatter/lock, imports, policy, event/input, configuration ref, task ref, compiler/action/runtime pins, capability/trust configuration, state snapshot, route/effort, and evaluator versions. Not every field will be observable; absent fields are named gaps, not guessed defaults.

## Debugging: first failing boundary, smallest disconfirming observation

Use the [upstream debugging strategy](https://github.com/github/gh-aw/blob/af6f1e3c4103e18ddf2ae62e4aa0261714d90aaa/.github/aw/debug-agentic-workflow.md) as a method, not as authorization to run workflows.

1. Anchor intent, required work, actual run/attempt/refs, and first observed failing phase. Preserve legitimate exclusions and downstream cascades separately.
2. Start with an existing compact audit and the phase's actual artifact manifest. Group comparable finding codes for recurrence; use individual evidence to confirm the signature. A tool/audit command error is not the workflow's conclusion.
3. State competing explanations and fetch only the observation that separates them. For example, check registered schema/startup when a tool is absent; check trust-filter logs when input disappears; check effect/staging receipts when a green agent produced no repository change.
4. Use local/source/fixture reproduction at one boundary with explicit labels, bounded effects, no production credentials, and edge assertions. Do not emulate the whole Actions environment or claim that mocks verify hosted access.
5. Propose the minimum correction with a regression fixture, source/lock review, and applicable compile/lint/type/scanner checks. Missing requested validation remains unverified.
6. Recompute only dependent signals; validate affected and unaffected cohorts, then record symptom resolution and required downstream completion.

Useful boundary-specific signatures:

| Combination | Discriminating question and next action |
| --- | --- |
| Body-only change + unchanged lock + changed behavior | Did the resolved runtime prompt/import change? Compare the actual prompt fingerprint before blaming an engine rollout. |
| Empty input + `DIFC_FILTERED` + unchanged source population | Was relevant work filtered by intended trust policy? Establish visible/eligible coverage; do not weaken integrity to manufacture input. |
| Inference works + GitHub read/write fails | Which credential flow, actor, scope, and job failed? Repair that authorized path, not the inference secret. |
| MCP declared + no registered schema + startup failure | Inspect startup/image/auth/protocol at the gateway before tool pruning or prompt tuning. |
| Main run succeeds + `subagent.failed`/endpoint mismatch + parent fallback | Required child work may be missing or expensive. Verify endpoint compatibility and actual fallback cost/quality. |
| Huge setup/upload time + small agent cost + large dependency/artifact tree | Remove unnecessary bootstrap/upload payload within the existing contract; inference optimization is not the bottleneck. |
| Agent emits output + no native action + staged/capped/rejected item | Diagnose handler disposition, not agent inactivity. Preview/limits may be working as intended. |
| PR action delivered + missing expected CI + default Actions-token actor | Verify event suppression and the exact expected commit/actor; propose extra CI-trigger effects only with owner authorization. |
| Repeated work + restored memory + stale schema/cursor or save/conflict error | Investigate persistence correctness, not a larger model; authoritative replay and concurrency-safe state matter. |
| Reported AIC changes + same tokens/route + changed pricing metadata | Separate accounting/catalog drift from actual resource or provider-billing change. |
| Native Completion + absent verified Result + uncertain effect/launch/termination | Reconcile the exact Claim and effect receipt; do not assume success or release/relaunch uncertain capacity. |
| Successful outputs continue after declared goal/deadline | Test the campaign stop/continuation contract and remaining assurance needs before treating run volume as value. |

**Live-debug boundary:** diagnosis/patching is the default. Existing evidence and compile-only validation do not grant dispatch permission. A live iteration needs applicable review, human authorization, exact reviewed remote refs/hashes, effect/credential scope, run/time/spend bounds, and monitoring. A branch is not production isolation. Dispatch or collection denial ends live iteration; a timeout without a run ID requires reconciliation, not automatic redispatch.

**Staging boundary:** `safe-outputs.staged` previews built-in outputs; it does not isolate custom scripts/jobs, external MCP effects, memory/cache, or diagnostic exports. Compiler `--dry-run` suppresses additional compiler-managed effects in its emitted lock, but not arbitrary custom code. It is not interchangeable with `--no-emit`, ordinary staging, CAO `review`, or a CAO manual worker `debug` request.

**Artifact boundary:** actual manifest/version determines available paths. Unified `agent`, `agent-output-fallback`, activation/info, usage, detection, experiment, evals, and safe-output-items can appear on different successful/failed paths. An absent legacy filename does not prove an absent result. Retention, selective downloads, and failed uploads remain explicit gaps; preserve redaction and do not publish raw prompts/artifacts.

**Trace boundary:** first establish source availability, run/trace identity, parent continuity, phase coverage, and required attributes. Then compare comparable phase durations/errors. gh-aw local mirrors and engine-direct backend exports are different sources; missing local spans do not prove no engine work. Nested/parallel span durations cannot be added as total wall time. Exporter failure can explain an observability gap without proving an execution failure.

## Optimization: choose a lever from the connected signature

Use the [upstream optimization guide](https://github.com/github/gh-aw/blob/af6f1e3c4103e18ddf2ae62e4aa0261714d90aaa/.github/aw/token-optimization.md), subject to the quality/cost gates above:

1. **Avoid unnecessary inference:** contract-safe pre-activation search/eligibility checks or deterministic pre-agent `noop`. Distinguish no work from missing data and include residual Actions/setup cost.
2. **Repair harness failures first:** wrong endpoint/runtime pin, missing registered skill/tool, invalid auth, and looping fallback can defeat every model-tier experiment.
3. **Move repeated reconstruction out of reasoning:** bounded precompute, shared acquisition, filtered `gh-proxy`/CLI-proxy responses, and authoritative drill-down references. Host-side steps retain separate effects and cost.
4. **Pull relevant context:** short main plan, on-demand inline skills, bounded source reads, targeted hypothesis-driven acquisition, and compact child summaries. Installed guidance is not necessarily invoked guidance.
5. **Separate caches:** prompt-cache prefix reuse affects provider token billing; Actions cache-memory stores files; repo-memory stores Git state; Activity cache reuses collected evidence. One cache hit does not prove another or guarantee correct context.
6. **Right-size judgment:** measured model/effort routing and compatible bounded delegation may help repetitive extraction. Router benchmark targets are not repository success guarantees; count classification, child, fallback, and deviated traffic cost.
7. **Batch fairly:** bound fan-out/items/context, keep batches idempotent, retain validated cursors, and preserve detection delay, deadlines, recovery, and minimum service.
8. **Tune the limiting stage:** per-workflow, per-engine, and safe-output concurrency are different. Do not increase model parallelism into API/review bottlenecks or interpret deliberate serialization as a stall.
9. **Evaluate and promote:** freeze assignment/evaluator and pricing/cost grain, record actual exposure, handle incomplete/censored outcomes, and apply A13 non-inferiority and practical-savings criteria.
10. **Increase budget last:** distinguish per-step/job/main/detector limits, daily admission, CAO campaign budget, and provider quota. Preserve effective trigger-specific bypasses/ceilings as observed configuration, never as blanket permission.

The benchmark is total cost and attained work under frozen safety, coverage, delay, and outcome contracts. Neither fewer tokens nor more accepted GitHub outputs alone proves better CAO operational value.

## Campaign and durable-work interpretation

Campaign intent binds goal, eligible opportunities, scope, intervention, evidence/outcome contracts, cadence, resource limits, stop/continuation conditions, and ownership. Installation, orchestration, one-target work, effects, review, and mature outcomes are different linked episodes; do not collapse the whole program into one run.

- A package can contain agentic Markdown, raw Actions YAML, shared imports, resources, skills, and agents. Its dependency/materialization graph matters before any run graph exists.
- CAO operational campaigns retain orchestrator/single-target-worker rules. Activity/Dashboard remain deterministic infrastructure variants. General upstream multi-repository or worker-spawn patterns are not blanket CAO authority.
- When native work queues are explicitly used, installed Policy and immutable Work/dependencies, Deployment, Claim, reservation, native launch, Completion, verified Result, and release provide additional lifecycle evidence.
- A committed assignment is not launched execution; Completion precedes effect delivery; Result requires independently verified delivery. Keep uncertain launch/termination capacity reserved until the applicable protocol resolves it.
- Native fairness weights allocate Claim opportunities, not CPU time, equal job counts, successful completion, or business value. Combine assignment share with actual wait, workload, outcomes, and service contracts.
- Backing issues/checklists can show progress but do not grant native Claim authority. The first accepted native submission can bootstrap the queue; absent storage before that is not a failed initialized queue.
- Native `aw.json` scheduling, gh-aw compiled capability/Claim boundaries, and CAO `cao.json` rollout policy are distinct records. None substitutes for the others; new adoption requires explicit integration and preservation of CAO's scope/mode and no-worker-fan-out constraints.
- Repo-memory/cache history can help reasoning but cannot prove effect delivery. Native Claim-scoped persistence has its own restrictions; do not assume an ordinary memory push is Claim-authorized.
- Upstream accepted-output states (`accepted`, `rejected`, `pending`, `ignored`, lifecycle variants, `unknown`, `error`) describe action-specific native observations. They are not automatically the actor-independent operational-value outcome contract.

Use this document as a connected rule/source index, not a giant default agent prompt. Feed an agent a bounded phase/episode evidence packet, the relevant rule and contract, missing/contradictory evidence, and the next discriminating question; allow scoped drill-down instead of rereading the entire knowledge base.

# How agentic workflows form campaign episodes

An agentic workflow is not one undifferentiated agent action. It is a controlled process with deterministic and agentic stages:

```text
trigger or changed evidence
  -> policy resolution at the exact workflow revision
  -> effective run envelope
  -> orchestrator discovery, filtering, ranking, and selection
  -> one bounded dispatch per selected target
  -> worker revalidation for one target
  -> agent reasoning and tool use
  -> threat detection and other hard gates
  -> declared safe output
  -> review or authorized live application
  -> repository outcome
  -> operational-value observation
```

- CAO controls whether and where an operation may run. gh-aw controls how an admitted workflow executes, including engine, tools, network, limits, authentication, and safe outputs.
- Effective authority is the intersection of policy, dispatch request, worker ceilings, credential reach, and compiled capabilities. No graph relationship or intelligence result can widen that intersection.
- The orchestrator is a portfolio decision point. It may discover and select only within resolved policy.
- Each worker is an independent single-target enforcement point. It cannot discover more targets, dispatch more work, or widen its requested mode.
- Deterministic stages should own policy intersection, filtering, joining, correlation, deduplication, scheduling, retry calculation, capacity admission, and state reduction.
- Agentic stages should be reserved for repository-specific interpretation, synthesis, experiments, remediation proposals, and other bounded judgment that deterministic rules cannot provide.
- Activity and Dashboard are deterministic infrastructure campaigns, not orchestrator/target-worker episodes. Standalone workflows and manual debug runs also need their own declared episode variants.

## Episode hierarchy

- A **campaign** is a recurring operating program with a stable intent, eligible-opportunity definition, target population, intervention, outcome contract, schedule, resource envelope, and stop conditions.
- A **campaign invocation episode** for an operational orchestrator/worker campaign begins with one admitted trigger or evidence change and is rooted in one orchestrator run under an exact policy and workflow revision. Other topologies require explicit variants.
- A **target episode** is the bounded child episode for one selected repository, operation, mode, evidence boundary, resource ceiling, and success condition.
- A **work episode** follows one admitted Decision through Work, Attempts, result, output, review, and outcome.
- A retry is another Attempt in the same work episode when authoritative lineage establishes that relationship, not a new opportunity or independent success. Do not reconstruct missing attempt history from the canonical Run's latest attempt number.
- Safe-output review, repository change, outcome maturation, and operational-value observation may arrive after the GitHub Actions run has ended. The episode therefore extends beyond runtime completion.
- A campaign is best understood as a family of related episodes repeated across time, targets, workflow revisions, policy revisions, model routes, and experiment variants.
- Episodes can overlap in clock time while remaining separate in identity and authority.
- An event can refer to several objects: one output may summarize many opportunities, and one review may cover several runs. Preserve object-to-object and event-to-object relationships instead of forcing every observation into one exclusive case.

## Episode boundaries

An episode should have a deterministic identity and explicit boundaries.

The campaign-invocation identity should include:

- campaign identity;
- orchestrator workflow identity and source revision;
- orchestrator run ID and attempt;
- effective policy revision;
- trigger or originating evidence fingerprint; and
- control repository.

The target-episode identity should additionally include:

- target repository;
- worker workflow and frozen revision;
- dispatch, Decision, Work, or intent identity;
- effective mode;
- evidence boundary;
- experiment assignment when present; and
- attempt lineage.

An episode begins at the earliest authoritative trigger, Decision, or admitted Work event. It can end in several ways:

- `completed`: the required terminal execution, output, and mature outcome evidence were observed;
- `failed`: execution exhausted its allowed attempts;
- `blocked`: a hard gate or missing prerequisite prevented progress;
- `cancelled` or `expired`: coordination ended without completion;
- `review-required`: execution finished but human action remains;
- `open`: downstream review or outcome evidence may still arrive;
- `censored`: the observation or retention window ended before the episode could be classified; or
- `unknown`: required identity, relationship, or evidence is missing.

Runtime success must not close an episode whose contract requires review, acceptance, outcome maturation, or operational-value evidence.

# Graph model

The evidence system is best represented as a **heterogeneous temporal attributed multigraph**:

- **Heterogeneous:** nodes and edges have different types and semantics.
- **Temporal:** events, states, relationships, and observations have event time, observation time, and validity windows.
- **Attributed:** nodes and edges carry status, cost, versions, quality, provenance, and other measurements.
- **Multigraph:** the same two entities can have several distinct relationships or repeated events.

## Node types

Useful node types include:

- Campaign and campaign revision
- Policy and policy revision
- Repository and target repository
- Workflow and workflow revision
- Trigger or evidence change
- Decision
- Work item
- Attempt
- Orchestrator run
- Worker run
- Agent session
- Model and route
- Tool, MCP server, Bash command, skill, and network domain
- Audit, failure signature, friction observation, and threat finding
- Safe-output item
- Issue, pull request, discussion, comment, or report
- Human review and disposition
- Repository outcome
- Operational-value observation
- Experiment and assignment
- Grader, eval, and observation
- Ingestion transaction, collection task, and evidence gap
- Precomputed measure and decision candidate

## Edge types

Useful directed edges include:

- `REVISION_OF`
- `GOVERNED_BY`
- `TRIGGERED_BY`
- `OBSERVED_CHANGE_IN`
- `ADMITTED_AS`
- `SELECTED_TARGET`
- `DISPATCHED`
- `ATTEMPT_OF`
- `RUNS_WORKFLOW`
- `TARGETS`
- `USES_MODEL`
- `ROUTED_TO`
- `INVOKED_SKILL`
- `CALLED_TOOL`
- `ACCESSED_DOMAIN`
- `BLOCKED_BY`
- `FAILED_WITH`
- `PRODUCED`
- `REVIEWED_AS`
- `APPLIED_TO`
- `ASSOCIATED_WITH_OUTCOME`
- `MEASURED_BY`
- `ASSIGNED_VARIANT`
- `GRADED_BY`
- `EVALUATED_BY`
- `DERIVED_FROM`
- `SUPPORTS`
- `CONTRADICTS`
- `MISSING_EXPECTED_EDGE`
- `FOLLOWED_BY`
- `SUPERSEDES`

Every material edge should carry:

- source and source identifier;
- event time and observation time;
- source revision or evidence generation;
- quality and completeness state;
- whether the edge is observed, expected, deterministically derived, or inferred;
- applicable confidence for inferred edges; and
- evidence references.

Observed, expected, derived, and inferred edges must never be silently mixed. Temporal proximity alone must not create provenance, dispatch, outcome, or causal edges.

An outcome-association edge records a documented relationship, not an intervention effect. Add an `AFFECTED_OUTCOME` causal edge only when a qualified attribution design supports it.

## Missing graph structure

Missing data is often visible as an expected node or edge that did not appear:

- admitted dispatch without a worker run;
- successful run without a safe-output record;
- safe output without a review disposition;
- accepted output without a mature outcome observation;
- workflow without a repository or campaign relationship;
- tool call without a completion;
- experiment assignment without a grader or eval result;
- outcome observation without a usable baseline;
- precompute without its declared input generation; or
- ingestion transaction without the expected record phase.

The system should materialize these as typed gaps with an expectation source, expected-by time, current age, affected episode, and quality state. It should not invent the missing node or edge.

# Graph projections for analysis

One giant graph is not the right query surface. Build bounded projections for the operator question.

## Authority graph

```text
policy revision
  -> effective envelope
  -> campaign/workflow enablement
  -> admitted target and mode
  -> compiled capability
  -> safe-output authority
```

Use it to detect unauthorized reach, missing admission, policy drift, and capability combinations. This graph is a hard-gate graph, not a value graph.

## Execution graph

```text
trigger
  -> orchestrator
  -> selection
  -> dispatch
  -> worker attempt
  -> agent session
  -> terminal conclusion
```

Use it for runtime health, fan-out, retries, missing workers, failure streaks, recovery, and critical-path latency.

## Behavior graph

```text
agent session
  -> model route
  -> skills
  -> tools and commands
  -> network domains
  -> audit and friction observations
```

Use it for tool efficiency, context acquisition, routing, skill activation, network constraints, steering, and fallback-loop analysis.

## Output and attention graph

```text
successful attempt
  -> safe output
  -> issue/PR/report
  -> review
  -> disposition
```

Use it for production, duplicate outputs, review latency, attention demand, blocked outputs, and acceptance funnels.

## Outcome graph

```text
eligible opportunity
  -> intervention or independent action
  -> repository outcome
  -> accepted evidence
  -> operational-value observation
```

Use it for attainment, coverage, maturation, target heterogeneity, and cost per mature accepted outcome when attribution permits.

## Evidence-quality graph

```text
source
  -> acquisition
  -> ingestion
  -> canonical record
  -> precompute
  -> dashboard signal or agent context
```

Use it to locate where data became missing, partial, stale, conflicting, malformed, or detached from provenance.

## Campaign-overlap graph

Represent campaigns and repositories, opportunities, acquisition sources, outcomes, outputs, interventions, and authority scopes as a typed bipartite or multipartite graph.

Use it to distinguish:

- complementary campaigns;
- independent assurance;
- shared preparation;
- competing intervention;
- redundant execution; and
- unknown overlap.

Similarity alone does not prove redundancy.

Use the portfolio work-signature and overlap classification above for candidate generation and native corroboration. Model duplicate groups as shared objects/hyperedges so pairwise graph projections do not multiply attributable cost or savings.

# Graph-derived measurements

## Episode-shape measures

- Number of selected targets and observed worker episodes
- Fan-out and fan-in
- Path length and stage latency
- Branching factor
- Retry and recovery depth
- Active, terminal, blocked, review-required, open, and censored episode counts
- Episode completion and outcome-maturation time
- Graph edit distance from a healthy reference episode
- Missing expected nodes and edges
- Orphan records and unresolved relationships

## Transition measures

- Trigger -> admitted
- Admitted -> dispatched
- Dispatched -> worker observed
- Worker observed -> successful execution
- Success -> safe output
- Safe output -> reviewed
- Reviewed -> accepted
- Accepted -> mature outcome
- Outcome -> operational-value observation

Each conversion rate needs a measured numerator, eligible denominator, time window, and censoring rule.

## Topology measures

- In-degree and out-degree for observed use or dependency
- Weighted degree for call, byte, cost, or failure volume
- Betweenness for shared bottlenecks or bridges
- Articulation points whose failure disconnects an evidence or execution path
- Connected components for isolated or orphaned activity
- Community structure for shared failure, tool, target, or campaign behavior
- Bipartite overlap and projection for campaigns, repositories, tools, and outcomes
- Path diversity for alternative acquisition or recovery routes
- Concentration and entropy for model, tool, target, and output distributions

Centrality means structural importance in the selected graph projection. It does not prove operational value, correctness, authority, or a need for more access.

## Temporal measures

- Time between adjacent stages
- Time since last success, output, review, outcome, or observation
- Failure and recovery streaks
- Recurrence interval for motifs
- Change points after revisions or incidents
- Seasonality by schedule, weekday, or repository activity
- Survival curves for time to review, recovery, acceptance, or mature outcome
- Hazard of failure or abandonment as an episode ages
- Union execution-active factory on-time, time-weighted active slot utilization, and unknown-time bounds
- Explicit API/runner/concurrency/approval waits and suspected-stall intervals
- Shared throttle recurrence, retry amplification, campaign service share, and deadline slack

Open and retention-censored episodes must be handled explicitly so incomplete episodes do not appear as failures or successes.

# Pattern-recognition methods

## Process mining and conformance checking

- Define the expected episode process from the campaign contract and workflow topology.
- Compare observed episodes with that process.
- Identify skipped stages, unexpected stages, loops, wrong ordering, excess retries, and paths that stop early.
- Preserve legitimate variants such as no-op, not-selected, review, live, and recovery paths.

## Frequent sequence and motif mining

- Find recurring typed subsequences and small subgraphs across episodes.
- Count support by distinct episode, target, campaign, and time window rather than raw event count alone.
- Compare motif prevalence in successful, failed, high-value, low-value, and pre/post-change cohorts.
- Prefer explainable motifs over opaque similarity scores.

## Change-point and anomaly detection

- Detect structural breaks in cost, duration, turns, tool use, failure motifs, review latency, and outcomes.
- Align candidate breaks with known revisions, schedule changes, rollout changes, incidents, or workload changes.
- Report method, parameters, sample count, comparable cohort, and false-alarm interpretation.
- An anomaly is a candidate for investigation, not a defect.

## Subgraph comparison

- Compare an episode with a healthy reference, its previous revision, another target cohort, or an experiment control.
- Report added, removed, and changed nodes, edges, attributes, stages, and missingness.
- Use exact graph differences before approximate graph-edit distance.

## Clustering and community detection

- Cluster episodes using stable structured features such as failure category, workflow phase, tool identity, network decision, version, target characteristics, and episode shape.
- Use graph communities to find shared-platform failures, target-specific behavior, overlapping campaigns, and common acquisition paths.
- Keep each cluster linked to representative episodes and contradictory members.
- Do not use raw prompts, stack traces, credentials, or unconstrained text as durable correlation keys.

## State-transition analysis

- Estimate transition frequencies between typed episode states.
- Use them to find sticky states, common exits, likely next observations, and recovery paths.
- Transition probabilities are descriptive unless a qualified causal design supports intervention claims.

## Causal analysis

- Build a causal graph only when direction and confounders are justified by system design or experiment.
- Prefer randomized experiment assignments, staggered rollouts, matched cohorts, interrupted time series, or other qualified designs.
- Treat ordinary pre/post movement and graph proximity as association.
- Keep workload size, repository mix, rollout, schedule, model, version, and evidence coverage as potential confounders.

## Representation learning

- Embeddings or learned graph representations may generate similarity, anomaly, or link candidates.
- They should not directly authorize work or establish provenance, redundancy, causality, or a clean security verdict.
- Material results need an explainable path back to typed nodes, edges, measures, and source evidence.

# Episode motifs worth detecting

| Motif | Graph pattern | Likely investigation |
| --- | --- | --- |
| Healthy value path | Trigger -> admitted -> worker -> success -> output -> accepted -> outcome | Preserve and compare efficiency across equivalent episodes |
| Dispatch gap | Dispatch edge exists, worker node absent after expected time | Admission, credentials, workflow dispatch, concurrency, or worker activation |
| Orchestrator gate | Orchestrator fails or is unknown; worker subgraph absent | Fix campaign/control path before investigating workers |
| Target-specific failure | Same workflow/revision succeeds on some targets and fails on a bounded subset | Repository content, permissions, branch, layout, or target-local integration |
| Shared-platform failure | Equivalent motif appears across campaigns and targets with shared runtime/version | gh-aw, compiler, gateway, firewall, or shared control infrastructure |
| Friction loop | Denial -> alternate read -> context growth -> steering -> retry -> failure | Original capability or acquisition-path mismatch |
| Tool amplification | One tool has high repeated degree and response bytes followed by token growth | Deterministic prefetch, filtering, caching, or tool redesign |
| Unused capability | Tool is configured across episodes but has zero observed calls | Tool pruning after representative coverage check |
| Review bottleneck | Many outputs converge on review-required nodes with increasing age | Human capacity, output volume, prioritization, or approval design |
| Reliable but ineffective | Repeated success/output paths do not connect to accepted outcomes | Campaign targeting, intervention, or outcome contract |
| Valuable but expensive | Mature outcomes improve while episode cost rises | Marginal-cost and capacity decision, not automatic optimization |
| Duplicate campaign work | Campaigns share targets, acquisition, opportunity, outcome, and output subjects | Shared preparation, coordination, or consolidation |
| Missing-evidence cascade | Acquisition or ingestion gap disconnects several downstream measures | Restore evidence before diagnosing runtime or value |
| Stale-precompute path | Canonical revision changes but downstream precompute fingerprint does not | Invalidation or dependency-declaration defect |
| Security stop | Behavior/output path reaches threat finding and no application edge follows | Expected hard-gate behavior; investigate originating change |
| Recovery motif | Failure cluster -> bounded change -> retry -> success -> stable outcome | Validate that the change addressed the original condition |
| Churn motif | Repeated change -> failure -> revert -> retry around the same subject | Unstable intervention, weak test, or conflicting automation |
| No-op cadence | Scheduled triggers repeatedly terminate without new opportunity or evidence | Reduce frequency, add event trigger, or deterministic relevance gate |

# Best-analysis pipeline

1. **Normalize identities.** Resolve stable campaign, repository, workflow, run, attempt, target, tool, output, outcome, and evidence identities.
2. **Construct typed observed edges.** Preserve source, time, revision, and quality. Do not infer relationships from proximity when authoritative keys exist.
3. **Add expected structure.** Compile expected workflow stages, targets, outputs, outcomes, and deadlines from policy, workflow topology, and campaign contracts.
4. **Materialize gaps.** Record expected-but-unobserved nodes and edges without inventing their content.
5. **Extract bounded episodes.** Build campaign-invocation, target, and work subgraphs under exact revisions and evidence windows.
6. **Compute deterministic features.** Calculate paths, transitions, durations, costs, coverage, topology, missingness, and quality.
7. **Recognize motifs and changes.** Apply process conformance, motif matching, clustering, change-point detection, and cohort comparisons.
8. **Correlate before invoking an agent.** Group observations and signals with a supported shared episode condition or exact dependency into one investigation candidate. Keep suspected common causes explicitly labeled as hypotheses.
9. **Prepare a compact evidence packet.** Send only the relevant episode subgraph, comparisons, motifs, gaps, contradictions, and source references to the agent.
10. **Use the agent for bounded judgment.** Ask it to interpret the pattern, compare hypotheses, identify the next unanswered question, and propose reversible tests or actions.
11. **Verify deterministically where possible.** Use graders, evals, compilation, security checks, and outcome contracts.
12. **Record feedback.** Bind acceptance, rejection, recovery, cost, outcome, and unexpected effects to the exact input fingerprint.
13. **Learn across episodes.** Re-evaluate motif precision, false escalations, missed conditions, forecast calibration, and operational-value movement.

# Agent graph-context packet

A strong agent input should contain:

- operator question and decision class;
- episode and graph-projection identity;
- exact policy, workflow, campaign, model, and computation revisions;
- subject, scope, and observation window;
- compact node and edge summaries;
- ordered stage timeline;
- transition and latency measures;
- recognized motifs with support counts;
- healthy or control comparison subgraph;
- before/after graph diff when applicable;
- affected and unaffected cohorts;
- missing expected nodes and edges;
- availability, completeness, freshness, coverage, maturity, and contradiction state;
- supporting and contradictory evidence references;
- current hard gates and authority ceiling;
- unresolved questions;
- resource budget and stopping condition; and
- requested output schema.

Do not send the complete portfolio graph, raw logs, full tool responses, or unrelated episode history when a bounded subgraph and immutable evidence references are sufficient.

# Graph-analysis safeguards

- Use canonical identities, not display names or text similarity, for authoritative joins.
- Preserve event time, observation time, ingestion time, and validity time as different concepts.
- Freeze policy and workflow revisions per episode; do not compare changed semantics as if they were the same process.
- Keep observed, expected, derived, and inferred edges visibly distinct.
- Treat absence as a typed gap only when an authoritative expectation exists.
- Correct for retention and right-censoring before computing completion or outcome rates.
- Do not count repeated observations of one entity as several independent facts.
- Do not count several signals from one run or trace as independent confirmation.
- Partition worker analysis by target; success on one target must not reset another target's failure streak.
- Compare representative cohorts and disclose workload, schedule, rollout, model, and version differences.
- Control false discoveries when searching many motifs or signals.
- Validate learned clusters and anomalies against deterministic structured evidence.
- Preserve contradictory evidence and unknown classifications.
- Hard security, policy, authority, verification, approval, and blast-radius gates are not offset by graph scores.
- Graph centrality, similarity, community membership, and predicted links are investigation aids, not authority or outcome evidence.
- Prefer explainable typed motifs and path differences over opaque universal scores.

# Evidence contract

Every evidence item or derived measure should answer:

- **What was observed?** The value, event, state, count, relationship, or explicit absence.
- **Who or what is the subject?** Campaign, repository, workflow, run, target, tool, model, skill, outcome, queue, or other canonical entity.
- **Where does it apply?** Control repository, target repository, campaign, workflow, branch, model, tool, or policy scope.
- **When was it observed?** Event time, collection time, measurement window, and freshness boundary.
- **Where did it come from?** Canonical source, source identifier, run, artifact, audit, or policy revision.
- **How was it produced?** Direct observation, aggregation, deterministic computation, grader, eval, experiment, or inferred classification.
- **How good is it?** Availability, completeness, freshness, coverage, maturity, attribution coverage, provenance, and contradiction state.
- **What contract gives it meaning?** Measure version, calculation, units, direction, threshold, cadence, denominator, and tie-breaking rule.
- **What is missing?** Required fields, subjects, intervals, relationships, denominators, baselines, or downstream observations that were expected but not observed.
- **Can it be reused safely?** Precomputation version, input fingerprint, evidence generation, invalidation rule, and source references.

Numeric evidence must distinguish:

- `zero`: an authoritative source explicitly observed zero.
- `missing`: the field or observation was absent.
- `unavailable`: the required source could not provide evidence.
- `partial`: only part of the eligible population was measured.
- `conflicting`: credible sources materially disagree.
- `malformed`: supplied evidence failed its contract.

Missing or expired evidence is unknown, not zero. An empty dashboard result is a healthy zero only when source availability, completeness, scope, and freshness establish that interpretation.

Missingness should be measurable by subject, source, field, relationship, and time window. Useful measures include missing-record count, missing-field count, affected-subject count, coverage gap, age of the oldest gap, duration of a continuous gap, and the stage at which evidence disappeared.

# Dashboard evidence inventory

## Portfolio, policy, and inventory

- Registered campaigns, repositories, workflows, roles, campaign membership, active/disabled state, rollout mode, targets, and policy settings establish what is configured and expected.
- Campaign and workflow version evidence, compiler versions, package revisions, update confidence, and registry state establish configuration drift and upgrade state.
- Marketplace package source, registry, ref, and resolved commit establish package provenance.
- Useful signals include missing registration, disabled dispatchers, version drift, policy mismatches, unexpected standalone workflows, target-coverage gaps, and campaigns with no distinguishable opportunity or outcome.

## Runs and runtime health

- Run status, native conclusion, event, branch, attempt, timestamps, duration, repository, workflow, and target repository establish execution history.
- Success rate, current failure streak, latest success boundary, active recovery attempt, missing expected worker run, and repeated error signature are derived runtime evidence.
- A successful run proves successful execution only. It does not prove accepted output, repository improvement, or operational value.
- Useful signals include failure onset, recovery, repeated failures, target-local failures hidden by portfolio averages, orchestrator gates blocking all workers, and enabled workflows that are not observed running.

## Failures, audits, and friction

- Audit events, severity, status, error codes, MCP failures, gateway steering, firewall decisions, blocked commands, retries, no-ops, missing tools, and missing data establish how execution behaved.
- Friction AIC, friction ratio, counted/suppressed/unattributed occurrences, turns, latency, and source attribution establish attributed execution-friction cost. They do not establish that every attributed cost is avoidable or recoverable.
- Run duration is a friction signal, not an outcome signal.
- Useful signals include tool-policy mismatches, retry storms, runaway fallback loops, recurring failure clusters, rising unattributed friction, and expensive recovery behavior.

## Cost, tokens, agents, and models

- AIC per run and total AIC establish model-aware best-effort priced usage. Pricing provenance and actual provider billing must be distinguished.
- Input, output, cache-read, cache-write, and reasoning tokens establish the shape of model consumption.
- API calls, turns, model/provider, route, selected/deviated endpoint, effort, and timestamps establish how the cost was incurred.
- Minimum, average, maximum, median, and tail values distinguish normal behavior from extreme runs.
- Raw tokens are diagnostic evidence, not a cross-model cost measure. The token-efficiency study used Effective Tokens (ET) to normalize model and token-type costs.
- Useful signals include cost concentration, token growth, cache effectiveness, routing regressions, excessive output, context growth, high tail cost, and model-tier optimization opportunities.

## MCP tools, Bash, and skills

- Configured tool inventory establishes available capability. Observed calls establish actual use.
- Tool name, server, workflow, status, request bytes, response bytes, call count, completion, and failure establish tool behavior.
- Skill definitions and invocations by workflow establish whether installed guidance is actually activated.
- Tool registrations can add schema context to every model request even when no call occurs. A GitHub MCP server with about 40 tools can add 10-15 KB of schema per turn; measured pruning reduced context by 8-12 KB per call in smoke workflows.
- Useful signals include unused registered tools, unexpectedly dominant tools, oversized responses, repeated deterministic reads, missing expected skill activation, and shared acquisition opportunities.

## Network, firewall, and steering

- Allowed and denied domains, request totals, affected workflows, network policy, token steering, and timeout steering establish environmental constraints.
- A denied request is not automatically a defect or justification to widen network access.
- Useful signals include newly required domains, unexpected egress, policy drift, a network denial followed by retries or fallback reads, and budget/time limits approached repeatedly.

## Security and safe outputs

- Threat-detection findings for prompt injection, secret leaks, and malicious patches establish security evidence before write-capable safe outputs run.
- Safe-output items, destination, review state, protected-file gates, and detection verdict establish the path from generated output to controlled application.
- Verified threats, warnings, detector failures, invalid results, disabled analysis, and intentionally skipped analysis are distinct. Observe the exact compiled detector configuration and enforcement: upstream supports warn/continue and strict failure behavior. A missing verdict is incomplete assurance, not a clean verdict; a required fail-closed CAO contract must not be assumed satisfied by a warning.
- Detection has a separate AIC budget and must be measured independently from the main agent.
- Useful signals include repeated detector failures, new threat findings after a tool or prompt change, safe outputs blocked by hard gates, and review-required security warnings.

## Outputs, reports, issues, and human attention

- Generated issues, pull requests, discussions, comments, reports, disposition, closing status, review state, and timestamps establish produced work and its lifecycle.
- Blocked work, awaiting-review age, reviewer disposition, duplicate or superseded outputs, and unresolved reports establish human-attention demand.
- Output count measures production, not acceptance, correctness, or value.
- Useful signals include review bottlenecks, repeated dismissed recommendations, duplicate outputs, outputs without follow-through, and campaigns producing reports faster than people can review them.

## Operational value and outcomes

- Operational value measures whether the intended repository outcome is attained across eligible opportunities under a fixed evidence contract.
- Operational value is actor-independent: the same outcome counts whether achieved by the workflow, a person, or another system.
- Native outcome history, direction, eligible-opportunity coverage, accepted observations, baseline availability, and cadence establish outcome evidence.
- Adoption timing is not causal attribution. Run success, output creation, or agent self-assessment is not operational value.
- Useful signals include improving, worsening, mixed, insufficient, stale, or uncovered outcomes; untreated high-consequence opportunities; and cost per mature accepted outcome when attribution permits.

## Experiments, graders, and evals

- Experiment definitions and run assignments establish exposure and assignment coverage, not effect.
- Grader values, units, direction, thresholds, pass/fail state, and errors establish deterministic run-level checks.
- Eval answers and observation times establish retained assessments, while unknown answers must remain unknown.
- Older observations are not automatically the current verdict.
- Useful signals include incomplete assignment coverage, missing result instrumentation, quality regression after an optimization, disagreement between graders and outcomes, and statistically supported before/after changes.

## Ingestion and evidence health

- Ingestion transactions, payload hashes, committed records, canonical table counts, daily indexed records, and indexed runs establish what entered the dashboard.
- Collection health, queue depth, pending tasks, oldest pending age, retries, failures, dead letters, last success, last projection, webhook deliveries, duplicates, and backfill state establish pipeline health.
- GitHub API limits, used and reserved capacity, reset state, and hourly peaks establish acquisition capacity.
- Activity snapshots are bounded and rebuildable. Their cache is evictable and is not historical authority.
- Useful signals include collection lag, evidence gaps, stale views, stuck queues, quota pressure, dead-letter growth, unexpected ingestion-volume changes, and false healthy-zero presentations.
- Missing-data evidence should identify whether data was never produced, could not be collected, failed validation, was only partially ingested, expired under retention, lost a required relationship, or is unavailable because the source is not authoritative for that fact.

## Precomputed evidence

- Versioned computations can convert canonical evidence into bounded runtime-health, failure-scope, likely-cause, operational-value, friction, cost, coverage, and next-investigation results.
- A precompute should include its measure ID and version, partition key, evidence generation, input fingerprint, time window, scope, quality state, result, evidence references, and computation time.
- Precomputes are especially valuable for repeated joins, grouping, ordering, failure-boundary detection, temporal windows, comparisons, and other deterministic work that an agent should not repeatedly reconstruct.
- Feeding validated precomputes to an agent can reduce raw-data scanning, repeated tool calls, context growth, and inconsistent calculations. Measure whether it actually improves judgment and preserves coverage; a narrow summary can also anchor the agent or hide the real cause.
- Precomputes can also make separate agent runs more comparable because each run receives the same measure definition and bounded evidence contract.
- A precompute is only as trustworthy as its inputs and quality state. Partial, stale, conflicting, malformed, or out-of-scope inputs must remain visible in the result.
- Precomputes are derived evidence, not authority. They cannot widen permissions, prove causality, replace accepted outcome evidence, or authorize remediation.
- Useful signals include computations unavailable because required evidence is missing, repeated agent work that should become deterministic, disagreement between a precompute and an agent conclusion, and agents spending turns recreating already-computable facts.

## Simulation and capacity evidence

- Database growth, retained-record volume, queue depth, run frequency, run size, and forecast assumptions establish expected storage and processing demand.
- Useful signals include future budget exhaustion, storage growth, insufficient collection capacity, and the cost of rollout expansion.

# Turning evidence into signals

The same evidence can answer different questions depending on how it is viewed.

## Point-in-time

- Ask what is true now.
- Examples: current failure streak, latest detection verdict, current queue depth, installed version, latest outcome direction.
- Best for immediate protection and sustain decisions.

## Within a time window

- Aggregate comparable evidence for a declared horizon.
- Examples: seven-day success rate, 30-day AIC, tools used this week, outputs awaiting review.
- The window and retention coverage must be visible.

## Over time

- Compare repeated observations at the same cadence.
- Examples: daily run conclusions, AIC trend, operational-value direction, queue age, API usage, ingestion volume.
- Look for level, slope, volatility, seasonality, change points, recovery, and tail behavior.

## Before and after an event

- Anchor evidence around a known change: workflow revision, prompt change, tool pruning, model switch, gh-aw upgrade, schedule change, rollout expansion, policy change, or incident.
- Compare cost, reliability, quality, security, and outcomes on both sides.
- A before/after association is not sufficient for causality when workload, target mix, seasonality, or evidence coverage also changed.

## Cohort comparison

- Compare equivalent campaigns, repositories, workflows, targets, models, experiment variants, or workload-size bands.
- Use representative cohorts so that a five-line change is not compared directly with a 200-line change as if workload were constant.

## Sequence analysis

- Order linked evidence by event time and canonical relationships.
- Use sequences to identify precursors, loops, recovery paths, and where work stops.
- Repeated sequence shape can be more informative than any individual count.

## Correlation and cross-signal analysis

- Join signals only through exact canonical relationships, declared contracts, or a disclosed inference rule.
- Signals derived from the same run, trace, output, or opportunity are correlated and must not be counted as independent confirmation.
- Contradictory signals should remain visible instead of being averaged away.

## Concentration and tails

- Inspect top-K share, campaign/workflow/repository concentration, median, upper tail, and extreme-run contribution.
- High concentration is not inherently bad; interpret it with reliability, operational value, blast radius, and workload.

## Coverage and absence

- Compare the measured numerator with the eligible denominator.
- Look for repositories, workflows, opportunities, targets, runs, or intervals that have no evidence.
- Absence can indicate a true zero, a dispatch gap, a collection gap, expired evidence, or an out-of-scope subject. The quality contract distinguishes these cases.
- Missingness can itself be compared over time. A growing gap, a gap beginning after a revision, or a gap isolated to one source or cohort is a diagnostic signal.

## Precomputed context for agents

- Give the agent the smallest sufficient set of precomputed measures, quality states, contradictory evidence, and evidence references for its task.
- Prefer deterministic computation for facts that have one reproducible answer. Use the agent for ambiguous diagnosis, hypothesis selection, synthesis, prioritization, and trade-offs.
- Include missing-data flags in the agent context so the agent can distinguish "no problem observed" from "the problem could not be measured."
- Pull detailed source evidence only after the precompute identifies a relevant partition, anomaly, contradiction, or gap.
- Compare agent runs with and without the precompute when its benefit is uncertain. Measure AIC, turns, tool calls, duration, answer consistency, grader/eval results, and outcome quality.
- Apply each result's declared invalidation and freshness contract when inputs, evidence generation, computation version, policy context, or quality state changes. A deliberately bounded-age cache may retain older evidence; expose its original revision and age rather than treating the cache hit as fresh evaluation.

## Counterfactual comparison

- Ask what less costly or safer alternative could have preserved the required outcome or assurance.
- Failed and cancelled run cost is not automatically waste.
- An optimization opportunity requires a plausible alternative: skip irrelevant work, fetch deterministically, prune a tool, reduce cadence, batch work, use a smaller model, share acquisition, or stop a retry loop.

# Signal families

## Protect

- Unauthorized live work, policy violations, threat findings, invalid detection, unsafe capability combinations, contradictory verification, excessive blast radius, and missing provenance.
- These are hard gates. Favorable cost or value evidence cannot compensate for them.

## Sustain

- Runtime health, failure streaks, recovery, ingestion health, API capacity, queue pressure, review capacity, campaign integrity, target attribution, and recurring failure clusters.
- These identify conditions required to keep the system operating.

## Invest

- Eligible-opportunity backlog, accepted outcomes, operational-value attainment, untreated high-consequence opportunities, marginal opportunities per target, and value of obtaining missing evidence.
- These identify where additional resources may attain more repository outcomes.

## Optimize

- AIC demand, AIC per successful run, AIC per opportunity, cost per accepted outcome, schedule fitness, model suitability, tool efficiency, friction, retry cost, prompt/context efficiency, and shared acquisition.
- These identify lower-cost ways to preserve outcomes and assurance.

## Simplify

- Campaign overlap, duplicate acquisition, shared intent, redundant execution, duplicate outputs, unchanged repeated inspection, avoidable approvals, stale recommendations, and capability duplication.
- These identify work that can be consolidated, shared, suspended, or removed.

# Composite signal patterns

| Evidence observed together | Useful interpretation or investigation |
| --- | --- |
| Campaign enabled and admitted + fresh complete inventory + no orchestrator runs | Trigger, schedule, activation, or dispatch gap |
| Orchestrator success + expected worker not observed | Dispatch, admission, envelope, or worker activation failure |
| Successful runs + outputs produced + operational value flat or worsening | Reliable production without demonstrated effectiveness |
| Success rate improves + operational value worsens | Execution reliability and repository outcome have diverged |
| Operational value improves + AIC increases | Possible worthwhile investment; inspect marginal cost and attribution rather than labeling regression |
| AIC falls + operational value and graders remain stable | Supported efficiency improvement |
| AIC falls + turns, outputs, graders, or outcome coverage also fall | Workflow may simply be doing less work |
| AIC rises + workload size rises + tokens per turn remain stable | Workload shift may explain cost growth |
| AIC rises + friction AIC, retries, turns, or duration rise | Avoidable execution friction is a likely contributor |
| Stable run count + rising input tokens + large tool response bytes | Context growth or insufficient tool-output filtering |
| Registered MCP tools + zero observed calls across representative runs | Tool-pruning candidate |
| High-frequency deterministic tool calls + stable query shape | Move acquisition to pre-agent steps, `gh-proxy`, or filtered CLI calls |
| One blocked command + many fallback turns + high context growth | Misconfiguration-driven runaway loop |
| Firewall denial + tool failure + retries + timeout steering | Network-policy or acquisition-path mismatch |
| New egress domain + new tool + threat finding | Security review of the capability change |
| Repeated detector failure or parse error + pending safe output | Incomplete security assurance; preserve fail-closed behavior |
| Repeated failure signature + compiler/version drift | Upgrade or compatibility investigation |
| Related campaign workflows + equivalent compile/configuration error + shared dependency onset | One campaign-level common-blocker investigation; preserve blocked children without inventing their failures |
| Expected due work + fresh disabled registry state + no accepted pause | Activation/service mismatch; inspect history and owner intent before any re-enablement |
| `in_progress` + old last progress + fresh collection + exceeded phase contract + no known wait | Suspected stall requiring bounded job/dependency investigation |
| High apparent factory activity + queued/blocked/starved campaigns | On-time is hiding service imbalance; inspect per-pool utilization, deadlines, and critical dependencies |
| Confirmed API throttle + synchronized schedules/retries + shared quota pool | Quota-aware admission, backoff, shared acquisition, or staggered service candidate |
| Saturated executor + compatible idle executor + ready work + downstream headroom | Bounded load-balancing trial; verify eligibility and compiled concurrency first |
| Queue depth and oldest age rise + API quota pressure rises | Acquisition-capacity bottleneck |
| Queue depth rises + collection success remains stable + arrival rate rises | Capacity demand may exceed throughput |
| Dead letters rise + last projection becomes stale | Evidence pipeline failure; downstream dashboard signals may be stale |
| Run volume falls + indexed-run volume falls + collection remains healthy | Likely source activity change |
| Run volume stable + indexed-run volume falls + ingestion failures rise | Collection or ingestion gap |
| Missing evidence rises after a collector, schema, or workflow revision | Acquisition, adaptation, validation, or compatibility regression |
| Missing evidence is isolated to one repository, workflow, source, or field | Scope-specific permissions, instrumentation, relationship, or source-quality gap |
| Missing baseline or denominator + strong-looking trend | Insufficient evidence; obtain the missing comparison before acting |
| Agent concludes "healthy" + required precompute reports partial or unavailable evidence | Unsupported healthy conclusion; investigate the evidence gap |
| Agent repeatedly scans and joins the same raw records | Create a deterministic, versioned precompute and feed its bounded result to the agent |
| Precomputed failure scope and cause references + fewer agent turns and stable quality | Stronger and more efficient agent context |
| Precompute becomes stale after an input revision | Recompute before using it for diagnosis or decisions |
| Successful output + long awaiting-review age | Human review is the throughput bottleneck |
| Many outputs + repeated dismissal or no accepted outcome | Simplify output, improve targeting, or suspend low-value production |
| High no-op rate + low evidence novelty + high schedule frequency | Reduce cadence, use an event trigger, or add a deterministic relevance gate |
| Same targets + same acquisition + same intended outcome across campaigns | Shared-preparation or redundant-execution candidate |
| Similar campaign/worker intent + same native opportunity + duplicate actions/review + no independent assurance need | Portfolio work coalescing candidate; attribute each multi-campaign duplicate group once |
| Same opportunity + incompatible interventions | Owner-arbitrated sequencing/conflict handling rather than blind deduplication |
| Experiment assignments observed + no grader/eval observations | Experiment instrumentation or result-collection gap |
| Optimized variant + lower AIC + stable grader/eval/outcome evidence | Candidate to promote after sufficient representative samples |
| Cheaper model route + stable quality and outcome evidence | Model-tier optimization opportunity |
| Model route deviation + cost or failure spike | Routing or endpoint regression |
| Missing baseline + apparent post-adoption improvement | Improvement is observable, but campaign causality is not established |
| Mixed repository outcome directions hidden by a campaign average | Investigate target cohorts; do not collapse contradictory evidence |
| High cost concentrated in one workflow + high operational value | Concentration may be intentional and productive |
| High cost concentrated in one workflow + low value + high friction | High-priority optimization candidate |

# Useful sequence patterns

## Normal value path

```text
eligible opportunity
  -> admitted run
  -> successful execution
  -> safe output
  -> human or system acceptance
  -> repository outcome
  -> operational-value observation
```

A break at each step identifies a different problem. Run success alone covers only one transition.

## Dispatch failure path

```text
orchestrator success
  -> dispatch requested
  -> worker not observed
  -> work item blocked
```

Investigate policy admission, dispatch envelope, credentials, concurrency, and worker activation.

## Friction loop

```text
tool or command denied
  -> alternative data gathering
  -> context growth
  -> more turns
  -> token or timeout steering
  -> incomplete output or failure
```

Fix the original capability mismatch rather than only raising the budget.

## Capacity failure path

```text
arrival rate rises
  -> queue depth grows
  -> oldest pending age grows
  -> retries or quota pressure rise
  -> projection becomes stale
```

Separate demand growth from failed processing before changing capacity.

## Human bottleneck path

```text
successful run
  -> output produced
  -> awaiting review
  -> review age grows
  -> outcome not attained
```

The workflow may be reliable while the end-to-end operating model is not.

## Security regression path

```text
prompt, model, tool, or network change
  -> new behavior or egress
  -> threat warning/finding
  -> safe output blocked or held for review
```

Compare the exact pre/post revision and preserve the security gate.

## Recovery path

```text
failure cluster
  -> bounded change
  -> active retry
  -> successful attempt
  -> failure streak ends
  -> outcome and cost monitored
```

Recovery is not complete until the required outcome and assurance remain acceptable.

# Good signals

- Operational value improves under the same fixed measurement contract.
- AIC or ET falls while operational value, graders, evals, security, and coverage remain stable or improve.
- Turns per run remain stable while tokens per call fall for comparable workloads.
- Failure streak ends with a successful retry and no new security or outcome regression appears.
- Unused tools are removed and required tools continue to complete successfully.
- Deterministic gates skip irrelevant work, and deterministic pre-steps replace non-inferential model turns.
- Queue age, dead letters, retries, and ingestion lag remain bounded as workload grows.
- Missing-data states are explicit, scoped, and trending downward where evidence is expected.
- Agents receive fresh, bounded, versioned precomputes with quality states and direct evidence references.
- Agent runs using precomputed evidence require fewer repeated reads and produce more consistent, grader-supported conclusions.
- Review age falls while accepted outcomes remain stable or improve.
- Audit comparisons show lower cost without new errors, network-policy regressions, missing evidence, or threat findings.

# Bad signals

- Cost changes are interpreted without workload, frequency, quality, outcome, and evidence-coverage context.
- Successful execution is presented as accepted output or operational value.
- Output volume, tool popularity, or skill invocation count is presented as effectiveness.
- A dashboard empty state is presented as zero when evidence is unavailable, partial, stale, or expired.
- Missing fields, relationships, baselines, denominators, or intervals are silently defaulted, dropped, or hidden.
- A precomputed result is supplied without its version, input generation, quality state, invalidation rule, or evidence references.
- An agent is asked to reconstruct deterministic joins, aggregations, ordering, or failure boundaries from a large raw corpus on every run.
- A stale or partial precompute is presented to the agent as current and complete.
- Correlated observations from the same run are counted as independent confirmation.
- A before/after temporal association is presented as causal impact.
- A composite score hides a failed security, authority, verification, or provenance gate.
- Failed or cancelled run cost is labeled waste without a less costly outcome-preserving alternative.
- More budget, permissions, tools, network access, or rollout scope is proposed before the underlying friction is understood.
- An optimization reduces cost by reducing the work, coverage, assurance, or outcome.

# Decision rules

- Preserve separate dimensions when cost, value, reliability, security, coverage, and human attention do not share defensibly comparable units.
- Do not invent a universal health, value, efficiency, risk, or autonomy score.
- Group correlated signals into one investigation candidate instead of creating duplicate alerts.
- Show supporting and contradictory evidence together.
- Evaluate security, policy, authority, verification, approval, and blast-radius gates before benefit or efficiency.
- Prefer the smallest reversible intervention that can test the hypothesis.
- Use experiments or representative cohorts for optimization changes where workload varies.
- Measure quality and outcomes before promoting a lower-cost variant.
- Increase budgets only after deterministic gates, tool pruning, context reduction, cadence, batching, model choice, and friction have been investigated.
- Treat "obtain more evidence" and "do nothing" as valid alternatives.
- Rank missing evidence by how much resolving it could change a protection, sustain, invest, optimize, or simplify decision.
- Precompute deterministic facts and relationships once, then reuse the bounded result across dashboard, CLI, and agent consumers.
- Pass precompute quality and missing-data flags into the agent prompt; never provide only a success-shaped summary.
- Require agents to cite the precompute and underlying evidence references used for material conclusions.

# Connections

- AIC and ET measure resource consumption; operational value measures outcome attainment. Neither substitutes for the other.
- Runtime health answers whether execution works. Operational value answers whether the intended repository outcome is attained.
- Process evidence explains how a result was produced; outcome evidence establishes whether it mattered.
- Tool, network, model, prompt, schedule, and policy evidence explain changes in run behavior when aligned by revision and time.
- Activity provides bounded canonical evidence; Dashboard Language turns it into inspectable measurements; computations produce versioned signals; intelligence combines them into bounded investigation and decision candidates.
- Missing-data evidence connects collection health to decision confidence. A missing run, relationship, baseline, denominator, or outcome can be more decision-relevant than another observed count.
- Precomputations connect the evidence system to stronger agent execution. They move deterministic work out of the reasoning loop while preserving provenance, quality, and drill-down to canonical evidence.
- Better precomputed context can improve both efficiency and trust: fewer tokens and tool calls matter, but consistent definitions, visible missingness, explicit contradictions, and reproducible evidence references are the stronger benefit.
- Campaign episodes connect runtime, behavior, outputs, human attention, outcomes, and value without collapsing them into one score.
- Graph projections connect evidence only for the current operator question. Authority, execution, behavior, output, outcome, overlap, and evidence-quality graphs need different edge semantics.
- Pattern recognition is strongest when deterministic graph construction and comparison happen before the agent runs. The agent should interpret bounded motifs and competing hypotheses, not rediscover the graph from raw evidence.
- Cross-episode patterns turn isolated dashboard measurements into operational learning: recurring motifs reveal systemic failure paths, optimization opportunities, campaign overlap, recovery behavior, and missing instrumentation.
- Optimization priority is a combination of per-run cost, run frequency, avoidable overhead, operational value at risk, security requirements, evidence quality, and human capacity.
- The dashboard is most useful when it supports movement from portfolio anomaly to campaign, repository, workflow, run, event, and source evidence without losing scope or provenance.

# Sources

- [Improving token efficiency in GitHub Agentic Workflows](https://github.blog/ai-and-ml/github-copilot/improving-token-efficiency-in-github-agentic-workflows/)
- [gh-aw threat detection reference](https://github.github.com/gh-aw/reference/threat-detection/)
- [gh-aw tools reference](https://github.github.com/gh-aw/reference/tools/)
- [gh-aw audit reference](https://github.github.com/gh-aw/reference/audit/)
- [CAO Activity](https://githubnext.github.io/gh-cao/activity/)
- [CAO operational value](https://githubnext.github.io/gh-cao/operational-value/)
- [CAO Dashboard Data Architecture](https://github.com/githubnext/gh-cao/blob/main/specs/dashboard-data.md)
- [CAO Computations Specification](https://github.com/githubnext/gh-cao/blob/main/specs/computations.md)
- [CAO Intelligence Specification](https://github.com/githubnext/gh-cao/blob/main/specs/intelligence.md)
- [CAO Architecture](https://github.com/githubnext/gh-cao/blob/main/ARCHITECTURE.md)
- [CAO Control Architecture Specification](https://github.com/githubnext/gh-cao/blob/main/specs/control-architecture.md)
- [CAO State-Mediated Coordination Specification](https://github.com/githubnext/gh-cao/blob/main/specs/state-mediated-coordination.md)
- [OCEL 2.0 Specification](https://arxiv.org/abs/2403.01975) and [standard overview](https://www.ocel-standard.org/)
- [PM4Py conformance API](https://processintelligence.solutions/pm4py/api/api/pm4py.conformance.html)
- [Google SRE: Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/)
- [Google SRE: Alerting on SLOs, including low-traffic services](https://sre.google/workbook/alerting-on-slos/)
- [Why am I Waiting? Data-Driven Analysis of Waiting Times in Business Processes](https://arxiv.org/abs/2212.01392)
- [Little: A Proof for the Queuing Formula](https://doi.org/10.1287/opre.9.3.383)
- [NIST: Kaplan-Meier estimation](https://www.itl.nist.gov/div898/handbook/apr/section2/apr215.htm)
- [Howard: Information Value Theory](https://doi.org/10.1109/TSSC.1966.300074)
- [FDA: Non-Inferiority Clinical Trials](https://www.fda.gov/regulatory-information/search-fda-guidance-documents/non-inferiority-clinical-trials)
- [Interrupted time series regression tutorial](https://pmc.ncbi.nlm.nih.gov/articles/PMC5407170/)
- [Benjamini-Yekutieli: False discovery rate under dependency](https://doi.org/10.1214/aos/1013699998)
- [gh-aw DeterministicOps](https://github.github.com/gh-aw/patterns/deterministic-ops/) and [MonitorOps](https://github.github.com/gh-aw/patterns/monitor-ops/)
- [GitHub REST API rate limits and response-based backoff](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [GitHub GraphQL rate, query, timeout, and resource limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)
- [GitHub workflow disabling and enabling](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows)
- [GitHub Actions workflow and job concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
- [Pinned gh-aw lifecycle documentation audit](https://github.com/github/gh-aw/tree/af6f1e3c4103e18ddf2ae62e4aa0261714d90aaa/docs/src/content/docs)
- [gh-aw workflow diagnosis and live-debug gates](https://github.com/github/gh-aw/blob/af6f1e3c4103e18ddf2ae62e4aa0261714d90aaa/.github/aw/debug-agentic-workflow.md)
- [gh-aw model/engine misconfiguration diagnosis](https://github.com/github/gh-aw/blob/af6f1e3c4103e18ddf2ae62e4aa0261714d90aaa/.github/aw/debug-model-engine-misconfiguration.md)
- [gh-aw token-efficiency techniques](https://github.com/github/gh-aw/blob/af6f1e3c4103e18ddf2ae62e4aa0261714d90aaa/.github/aw/token-optimization.md)
- [gh-aw campaign design](https://github.com/github/gh-aw/blob/af6f1e3c4103e18ddf2ae62e4aa0261714d90aaa/.github/aw/campaign.md)
- [gh-aw telemetry query method](https://github.com/github/gh-aw/blob/af6f1e3c4103e18ddf2ae62e4aa0261714d90aaa/.github/skills/otel-queries/SKILL.md)
