---
title: Central Agentic Ops Intelligence Specification
description: Summary requirements for proactive portfolio intelligence, decision synthesis, campaign design validation, and bounded execution in Central Agentic Ops.
version: 0.3.0
status: Working Draft
editors:
  - GitHub Next
---

# Central Agentic Ops Intelligence Specification

**Version:** 0.3.0
**Status:** Working Draft
**Latest Version:** https://github.com/githubnext/gh-aw-cao/blob/main/specs/intelligence.md
**Editors:** GitHub Next

## Abstract

This specification defines the target intelligence model for Central Agentic
Ops (CAO). The intelligence layer continuously transforms canonical evidence
into proactive, bounded, explainable decisions about what to protect, sustain,
invest in, optimize, or simplify. It combines runtime health, security,
operational value, outcomes, AI Credit demand, schedules, campaign overlap,
tool and network friction, evidence quality, and human-attention demand without
inventing a universal score.

The intelligence layer decides which conditions justify action, investigation,
continued observation, or no intervention. Campaign workers remain bounded
executors for repository-specific evidence acquisition, experiments,
compilation, scanning, and authorized safe outputs. Intelligence results are
derived evidence: they never grant authority, widen rollout, bypass approval,
or mutate repositories.

## Status of This Document

This document is a Working Draft and may be updated, replaced, or made
obsolete. Sections 2 through 14 are normative. Examples and explicitly
identified notes are informative.

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD",
"SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" are to
be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

## Table of Contents

1. [Purpose and scope](#1-purpose-and-scope)
2. [Authority and safety](#2-authority-and-safety)
3. [Target architecture](#3-target-architecture)
4. [Campaign intelligence contracts](#4-campaign-intelligence-contracts)
5. [Evidence quality](#5-evidence-quality)
6. [Measure families](#6-measure-families)
7. [Forecasting and statistical requirements](#7-forecasting-and-statistical-requirements)
8. [Correlation, overlap, and shared intent](#8-correlation-overlap-and-shared-intent)
9. [Decision synthesis](#9-decision-synthesis)
10. [Dashboard presentation](#10-dashboard-presentation)
11. [Campaign execution boundary](#11-campaign-execution-boundary)
12. [Campaign authoring prevention](#12-campaign-authoring-prevention)
13. [Feedback and evaluation](#13-feedback-and-evaluation)
14. [Delivery sequence](#14-delivery-sequence)
15. [Conformance checklist](#15-conformance-checklist)
16. [Related specifications](#16-related-specifications)
17. [Change log](#17-change-log)

## 1. Purpose and scope

CAO intelligence exists to answer:

1. What must be protected now?
2. What condition threatens continued operation?
3. Where can additional resources attain meaningful repository outcomes?
4. Which execution, schedule, model, or acquisition behavior should be
   optimized?
5. Which campaigns, outputs, approvals, or repeated activities should be
   simplified?
6. Which feasible decisions should be taken with the available budget,
   authority, and human capacity?

This specification covers:

- proactive portfolio measures and forecasts;
- campaign intent and opportunity contracts;
- cross-signal and cross-campaign correlation;
- campaign overlap and shared-intent analysis;
- deterministic decision candidates and alternatives;
- hard safety, policy, authority, and evidence gates;
- capacity-constrained portfolio selection;
- decision-oriented dashboard presentation;
- campaign authoring validation and historical simulation; and
- decision feedback and calibration.

This specification does not define:

- rollout or repository-writing authority;
- credentials or secret handling;
- a universal operational-value definition;
- a universal health, risk, value, efficiency, or autonomy score;
- direct repository mutation by the intelligence layer; or
- causal impact inferred solely from temporal association.

## 2. Authority and safety

### 2.1 Authority boundary

`.github/workflows/cao.json` remains the persistent non-secret rollout-policy
authority. gh-aw workflow definitions remain the authority for execution
capabilities, permissions, tools, limits, and safe outputs.

An intelligence computation or decision result:

- MUST NOT grant or widen repository, campaign, worker, credential, tool, or
  write authority;
- MUST NOT promote review work to live mode;
- MUST NOT bypass a required approval or verification gate;
- MUST NOT mutate a target repository;
- MUST NOT replace canonical evidence or reviewed policy;
- MUST NOT infer authority from expected value, urgency, or model confidence;
  and
- MUST fail closed when required authority or evidence is unavailable.

### 2.2 Non-compensable gates

Policy, authority, security, verification, required approval, and declared
blast-radius ceilings MUST be evaluated before benefit, efficiency, or
resource-allocation preferences. A favorable value or cost estimate MUST NOT
compensate for a failed hard gate.

## 3. Target architecture

The target flow is:

```text
authoritative policy, inventory, Activity, and repository evidence
        |
        v
canonical evidence and campaign intelligence contracts
        |
        v
versioned measures, forecasts, and correlation results
        |
        v
bounded decision candidates and alternatives
        |
        v
hard-gated, capacity-constrained decision portfolio
        |
        v
Dashboard Language consumers and bounded campaign dispatch
        |
        v
outcomes, operational value, and decision feedback
```

The intelligence layer MUST consume canonical evidence or an equivalent
projection preserving canonical identity, source precedence, quality, and
provenance. Dashboard components MUST NOT reconstruct source relationships,
forecasts, overlap, or decision rankings.

Derived results MUST be:

- versioned;
- deterministic for the same inputs and configuration;
- identified by collision-resistant input fingerprints over declared
  dependencies, computation versions, and relevant configuration;
- partitioned and independently recomputable;
- bounded;
- quality- and provenance-preserving;
- disposable and reconstructable; and
- incapable of granting execution authority.

## 4. Campaign intelligence contracts

Every campaign and worker SHOULD expose, or permit deterministic compilation
of, an intelligence contract containing:

- the repository-native problem;
- the eligible-opportunity population and identity;
- the intended repository outcome;
- accepted evidence of outcome attainment;
- target population and intervention class;
- trigger and schedule;
- schedule rationale and maximum acceptable detection delay;
- expected resource and human-attention envelope;
- overlap identity;
- output and approval policy;
- maturation period;
- deduplication, backoff, and stop conditions; and
- applicable operational-value definition.

An intelligence contract is descriptive evidence. It MUST NOT grant rollout,
target, credential, or write authority.

Unknown contract fields MUST remain unknown. An implementation MUST NOT infer a
measurable outcome from workflow execution, issue creation, recommendation
production, or campaign adoption alone.

### 4.1 Ledger-free campaign contract

A compiled campaign intelligence contract MUST include:

```json
{
  "contractId": "campaign-intelligence-contract:...",
  "contractVersion": "1.1.0",
  "campaignId": "campaign:dependabot",
  "campaignSlug": "dependabot",
  "declaration": {
    "contractVersion": "1.0.0",
    "campaign": "dependabot"
  },
  "repositoryNativeProblem": null,
  "eligibleOpportunity": null,
  "intendedOutcome": null,
  "outcomeAttainmentEvidence": null,
  "targetPopulation": null,
  "interventionClass": null,
  "triggerAndSchedule": null,
  "scheduleRationale": null,
  "maxDetectionDelay": null,
  "resourceEnvelope": {},
  "overlapIdentity": null,
  "outputApprovalPolicy": null,
  "maturationPeriod": null,
  "deduplication": null,
  "backoff": null,
  "stopConditions": null,
  "operationalValueDefinition": null,
  "authorityContext": {},
  "workflows": [],
  "quality": {},
  "inputFingerprint": "sha256:..."
}
```

`contractId` MUST be stable for the canonical Campaign identity.
`inputFingerprint` MUST cover the declared semantic fields, descriptive
authority context, bounded workflow envelopes, and quality state.

Policy mode, rollout limits, targets, budgets, and workflow ceilings MAY be
copied into descriptive contract fields when they are explicit canonical
facts. They MUST NOT be interpreted as permission to execute. A campaign
description or README MUST NOT be reclassified as a problem statement,
intended outcome, success condition, overlap identity, or operational-value
definition unless the source declares that meaning.

An absent field MUST be represented as `null` or a typed `missing` state. An
empty default supplied by an adapter MUST NOT be interpreted as an
authoritative observation of zero eligible opportunities, targets, schedules,
cost, attention, or outcomes.

### 4.2 Campaign-owned declaration

A catalog Campaign MAY declare its semantic intelligence fields in an
`intelligence.json` file adjacent to its `aw.yml`. After gh-aw installs or
updates the Campaign, the trusted CAO materializer MUST copy that file from the
exact reviewed Campaign revision to:

```text
.github/cao/intelligence/<campaign>.json
```

The declaration envelope MUST use this shape:

```json
{
  "contractVersion": "1.0.0",
  "campaign": "dependabot",
  "fields": {
    "intendedOutcome": {},
    "outcomeAttainmentEvidence": {},
    "stopConditions": {}
  }
}
```

`campaign` MUST exactly match the canonical lowercase Campaign slug. `fields`
MUST contain only the semantic fields defined by Section 4. A semantic field
whose value is unknown MUST be omitted rather than declared as `null`.
Declarations with an unsupported version, unknown field, empty field set,
non-finite number, undefined value, mismatched Campaign identity, or conflicting
source and installed copy MUST fail closed.

The source and materialized declaration MUST normalize to the same canonical JSON
value. Canonical inventory MUST preserve the normalized envelope on the
Campaign record as `intelligenceDeclaration`. The compiled intelligence
contract MUST preserve its declaration version and Campaign identity, and its
input fingerprint MUST change when any declared semantic value changes.

The declaration is Campaign-owned descriptive evidence. It MUST NOT appear in
`cao.json`, replace policy, enable a Campaign or worker, enroll a target,
promote review work to live, grant credentials, or authorize a safe output.

## 5. Evidence quality

Every measure, forecast, and decision MUST independently report:

- availability;
- completeness;
- freshness;
- coverage;
- maturity;
- provenance;
- attribution coverage; and
- contradiction state.

Numeric evidence MUST distinguish:

| State | Meaning |
| --- | --- |
| `zero` | An authoritative source explicitly observed zero. |
| `missing` | The field or observation was absent. |
| `unavailable` | The required source could not provide the evidence. |
| `partial` | Only part of the eligible population was measured. |
| `conflicting` | Credible sources materially disagreed. |
| `malformed` | Supplied evidence failed its declared contract. |

Exhausting possible sources MUST NOT convert missing evidence to zero.
Incomplete totals MUST expose both their measured numerator and eligible
denominator.

### 5.1 Normalized quality contract

Every ledger-free intelligence result and Decision MUST carry a normalized
quality object equivalent to:

```json
{
  "contractId": "evidence-quality",
  "contractVersion": "1.0.0",
  "availability": "available",
  "completeness": "partial",
  "freshness": {
    "state": "unknown",
    "observedAt": "2026-10-01T10:00:00.000Z"
  },
  "coverage": {
    "state": "partial",
    "numerator": 3,
    "denominator": null
  },
  "maturity": "unknown",
  "provenance": {
    "state": "available",
    "sources": ["runtime-health"]
  },
  "attributionCoverage": {
    "state": "partial",
    "numerator": 2,
    "denominator": 3
  },
  "contradictionState": "unknown"
}
```

A producer MUST mark a dimension `malformed` when supplied values violate its
contract. It MUST NOT claim `fresh` or `stale` without a valid observation
time and an applicable freshness rule. A missing denominator MUST remain
`null`; it MUST NOT be replaced with the measured numerator to manufacture
complete coverage.

## 6. Measure families

### 6.1 Protect

Protect measures identify non-compensable conditions including:

- unauthorized live work;
- policy and authority violations;
- security findings;
- failed or contradictory verification;
- unsafe capability combinations;
- excessive declared blast radius;
- compiler or security-scanner failures; and
- missing required provenance.

### 6.2 Sustain

Sustain measures cover:

- runtime health and current failure streaks;
- orchestrator gates and target-local health;
- failure scope and likely cause;
- recovery state;
- evidence and ingestion health;
- API, concurrency, and review capacity;
- target attribution;
- campaign integrity; and
- recurring failure clusters.

### 6.3 Invest

Invest measures cover:

- eligible-opportunity backlog;
- accepted outcomes;
- operational-value attainment;
- untreated high-consequence opportunities;
- rollout-expansion scenarios;
- marginal opportunities per additional target; and
- the value of obtaining missing evidence.

### 6.4 Optimize

Optimize measures cover:

- AI Credit demand and forecasts;
- AI Credit per successful Run;
- AI Credit per eligible opportunity;
- resource cost per mature accepted outcome when attribution permits;
- schedule fitness;
- model and agent suitability;
- tool and MCP acquisition efficiency;
- firewall and environmental friction;
- retry and recovery cost;
- prompt, context, turn, and tool-call efficiency; and
- shared acquisition opportunities.

Failed or cancelled Run cost MUST NOT be labeled waste by default. A cost MAY
be classified as avoidable only when a disclosed counterfactual rule identifies
a less costly alternative that preserves the required outcome or assurance.

### 6.5 Simplify

Simplify measures cover:

- campaign and target overlap;
- shared intent;
- redundant execution;
- duplicate or superseded outputs;
- repeated unchanged inspection;
- avoidable approval requests;
- stale or repeatedly dismissed recommendations;
- capability duplication; and
- campaigns without a distinguishable opportunity or outcome.

## 7. Forecasting and statistical requirements

### 7.1 Resource-demand forecast

A resource-demand forecast SHOULD decompose expected demand into:

```text
scheduled demand
+ event-triggered demand
+ retry and recovery demand
+ manual demand
+ rollout-expansion demand
```

It MUST disclose:

- method and version;
- observation and forecast windows;
- source coverage;
- median or central forecast;
- uncertainty interval;
- budget-exceedance probability when an applicable budget exists;
- expected exhaustion date when meaningful;
- reset or replenishment behavior; and
- scenario assumptions.

Missing budgets, schedules, reset behavior, or consumption evidence MUST
produce `not-evaluated` or `unavailable`, not an in-budget verdict.

### 7.2 Schedule fitness

Schedule fitness SHOULD evaluate:

- eligible-opportunity yield;
- evidence novelty;
- complete no-op rate;
- AI Credit per new opportunity;
- detection delay;
- consequence of delay;
- assurance requirements; and
- availability of authoritative event triggers.

A schedule recommendation MAY propose increased frequency, reduced frequency,
event-driven execution, adaptive backoff, suspension, or retention. It MUST
identify the expected effect on detection delay, cost, assurance, and human
attention. It MUST NOT directly edit a workflow schedule.

### 7.3 Concentration and tails

Portfolio analysis SHOULD include:

- workflow and campaign spend share;
- top-K share;
- Herfindahl-Hirschman concentration;
- median and upper-tail AI Credit per Run;
- extreme-Run contribution; and
- concentration by target, model, and responsible authority.

High concentration is not independently adverse. It MUST be interpreted with
reliability, operational value, outcomes, and blast radius.

### 7.4 Trends and anomalies

An anomaly or change label MUST require a representative comparable cohort and
a disclosed method, parameters, sample count, and false-alarm interpretation.
Implementations SHOULD account for weekday seasonality, schedule changes,
rollout changes, and other structural breaks.

When many related signals are tested, the method SHOULD control the expected
false-discovery burden. A statistically unusual observation MUST remain
distinct from a failure, policy breach, or required action.

### 7.5 Calibration

Probability-bearing forecasts and recommendations MUST identify what their
probability represents. They MUST NOT be presented as calibrated until
comparable predictions and realized observations demonstrate calibration.

## 8. Correlation, overlap, and shared intent

### 8.1 Correlation

Signals MAY be combined only through exact canonical relationships, declared
contract relationships, or a disclosed inference rule. Multiple measures
derived from the same Run, trace, opportunity, or output MUST NOT be treated as
independent evidence.

One underlying condition SHOULD produce one decision candidate containing
multiple supporting and contradictory signals rather than multiple competing
attention items.

### 8.2 Overlap dimensions

Campaign overlap SHOULD evaluate:

- target overlap;
- eligible-opportunity overlap;
- intended-outcome overlap;
- evidence-acquisition overlap;
- temporal overlap;
- output-subject overlap;
- intervention overlap; and
- authority overlap.

Overlap MUST be classified as one of:

- `complementary`;
- `independent-assurance`;
- `shared-preparation`;
- `competing-intervention`;
- `redundant-execution`; or
- `unknown`.

Semantic similarity MAY identify candidates for review. It MUST NOT establish
redundancy without repository-native corroboration.

## 9. Decision synthesis

### 9.1 Decision classes

Every decision candidate MUST use one class:

- `protect`;
- `sustain`;
- `invest`;
- `optimize`; or
- `simplify`.

### 9.2 Alternatives

Every material decision SHOULD include:

- the recommended action;
- defer;
- do nothing;
- obtain additional evidence;
- a narrower or reversible intervention; and
- an alternative executor when applicable.

### 9.3 Decision sequence

The intelligence engine MUST:

1. form bounded decision candidates from versioned upstream results;
2. group correlated signals;
3. evaluate hard gates and prerequisites;
4. construct feasible alternatives;
5. remove alternatives dominated on every material dimension;
6. preserve incomparable alternatives as explicit trade-offs;
7. evaluate whether more information could change the decision;
8. apply available budget, authority, and human-capacity constraints; and
9. publish a bounded portfolio with deterministic ordering and tie-breaking.

Expected net benefit MAY be computed only when benefits and costs have
defensibly comparable units. Otherwise the result MUST preserve separate
dimensions and a Pareto trade-off.

### 9.4 Decision result

A decision result MUST include:

```json
{
  "measureId": "portfolio-decisions",
  "measureVersion": "1.2.0",
  "decisionId": "schedule-fitness:optimization",
  "decisionClass": "optimize",
  "state": "decide-soon",
  "subject": {},
  "recommendation": {},
  "alternatives": [],
  "hardGates": [],
  "consequences": {},
  "forecast": {},
  "quality": {},
  "sensitivity": [],
  "capacityRequirements": [],
  "correlationGroup": {},
  "evidenceReferences": [],
  "decisionTrace": {},
  "computedAt": "2026-09-29T00:00:00Z"
}
```

The decision trace MUST be generated by the computation that selected the
decision. It MUST identify inputs, measure versions, rules, gates, assumptions,
thresholds, excluded alternatives, capacity constraints, and tie-breakers.

## 10. Dashboard presentation

### 10.1 Decision Brief

The initial dashboard decision surface SHOULD present:

1. portfolio evidence quality and applicable constraints;
2. the highest-ranked decision; and
3. a bounded list of subsequent decisions.

Decision states are:

- `act-now`;
- `decide-soon`;
- `investigate`; and
- `watch`.

A positive empty state MUST identify the evaluated decision classes and MUST
NOT claim health when required evidence is unavailable, partial, stale, or
unknown.

### 10.2 Decision card

Each decision card MUST expose:

- recommended action;
- reason and urgency;
- expected upside;
- resource and human cost;
- security and blast radius;
- reversibility;
- evidence quality and material uncertainty;
- expected actor;
- one bounded next action; and
- direct access to supporting evidence.

The user MUST be able to inspect:

- why the decision outranks alternatives;
- why alternatives were not selected;
- decision sensitivity;
- forecasts and assumptions;
- computation trace; and
- complete provenance.

The dashboard MUST declare selection, filtering, joins, grouping, ordering,
pagination, and source derivation in Dashboard Language and execute them
through the canonical query boundary.

## 11. Campaign execution boundary

Campaigns are bounded executors, not independent portfolio intelligence
systems.

An implementation MAY deploy shared intelligence before a coordination ledger
exists. In that phase it MUST stop at advisory Decision publication, MUST NOT
represent a Decision as acquired or admitted Work, and MUST NOT dispatch a
worker from the intelligence computation.

Shared intelligence SHOULD own:

- cross-campaign discovery and ranking;
- resource forecasts;
- schedule fitness;
- overlap and shared-intent analysis;
- model-routing candidates;
- attention-demand evaluation;
- recurring failure clustering;
- catalog and capability-gap candidates; and
- portfolio selection.

Campaign workers SHOULD own:

- repository checkout and content inspection;
- detailed prompt, context, and workflow analysis;
- compilation and security scanning;
- bounded experiments;
- repository-specific remediation proposals;
- authorized safe outputs; and
- collection of missing repository evidence.

A dispatched worker SHOULD receive one bounded decision envelope containing:

- one repository;
- one requested operation;
- one effective mode;
- one evidence boundary;
- one resource ceiling;
- one output contract; and
- one success condition.

The worker MUST NOT rediscover the portfolio, widen scope, choose unrelated
work, dispatch additional work, reinterpret policy, or promote its mode.

## 12. Campaign authoring prevention

### 12.1 Static validation

Before adoption, the intelligence layer SHOULD validate:

- problem and opportunity definitions;
- accepted outcome evidence;
- target and intervention scope;
- overlap with installed campaigns;
- schedule rationale;
- expected resource and attention envelopes;
- authority and blast radius;
- deduplication, backoff, and stop behavior; and
- operational-value measurability.

### 12.2 Historical simulation

When retained pre-adoption evidence permits, a proposed campaign SHOULD be
simulated to estimate:

- eligible opportunities;
- projected Run count;
- complete no-op rate;
- AI Credit and API demand;
- output and approval volume;
- overlap with installed campaigns;
- detection delay;
- likely budget pressure; and
- evidence coverage.

Simulation is a forecast. It MUST NOT be presented as proven future value or
as authority to install or activate the campaign.

### 12.3 Design verdict

An authoring evaluation SHOULD return one of:

- `ready-for-bounded-review-trial`;
- `requires-contract-change`;
- `overlaps-existing-campaign`;
- `requires-missing-evidence`;
- `likely-excessive-cadence`;
- `likely-excessive-attention`; or
- `not-measurable`.

## 13. Feedback and evaluation

Decision feedback SHOULD preserve:

- accepted, rejected, deferred, superseded, recovered, expired, or unresolved
  disposition;
- actor, time, and authority;
- selected alternative;
- rationale when supplied;
- actual implementation cost;
- actual AI Credit and attention change;
- outcome disposition;
- operational-value movement;
- unexpected effects; and
- forecast and prerequisite accuracy.

The system MUST NOT optimize solely for recommendation acceptance, clicks, or
output volume.

Evaluation SHOULD include:

- high-consequence condition recall;
- false-escalation and missed-condition rates;
- forecast calibration;
- decision reversal and staleness;
- user interruptions and duplicate approvals;
- time waiting for human action;
- evidence and attribution coverage;
- schedule opportunity yield;
- recurring failure and recovery time;
- accepted outcomes; and
- operational value in each metric's native unit.

Before-and-after movement MUST be described as association unless a qualified
causal design supports a stronger claim.

### 13.1 Decision feedback contract

Ledger-free Decision feedback MUST use a versioned envelope:

```json
{
  "contractVersion": "1.0.0",
  "records": [
    {
      "decisionId": "runtime-health-decision:...",
      "inputFingerprint": "sha256:...",
      "disposition": "accepted",
      "observedAt": "2026-10-01T11:00:00.000Z",
      "actor": "operator:octocat",
      "authority": "control-repository-review",
      "selectedAlternativeId": null,
      "rationale": null,
      "actualCost": null,
      "outcomeDisposition": null,
      "operationalValueMovement": null,
      "unexpectedEffects": null,
      "forecastAccuracy": null
    }
  ]
}
```

Allowed dispositions are `accepted`, `rejected`, `deferred`, `superseded`,
`recovered`, `expired`, and `unresolved`.

Feedback MUST bind to both the stable Decision identity and the exact input
fingerprint. Feedback for an older fingerprint MUST remain inspectable but
MUST NOT suppress or alter a Decision produced from changed evidence.
`accepted`, `rejected`, `superseded`, `recovered`, and `expired` are terminal
for unchanged evidence. `deferred` and `unresolved` are nonterminal.

An accepted recommendation MUST NOT be represented as an accepted outcome or
operational-value attainment unless those dispositions are independently
recorded. Feedback is descriptive evidence and MUST NOT grant admission,
dispatch, rollout, repository, credential, or write authority.

## 14. Delivery sequence

Implementation SHOULD proceed in this order:

1. Define campaign intelligence, decision-result, and feedback contracts.
2. Ingest schedules, triggers, intent, budget, attention, and outcome facts.
3. Implement deterministic resource forecast, schedule fitness, overlap,
   attention-demand, and campaign-design measures.
4. Implement hard-gated deterministic portfolio decisions without
   model-generated probabilities.
5. Add the Decision Brief and complete drill-downs through Dashboard Language.
6. Dispatch bounded decision envelopes to selected workers.
7. Move generic Optimization and CAO Evolution analysis into shared
   intelligence while retaining repository-specific executors.
8. Add authoring-time validation and historical campaign simulation.
9. Add backtested forecasts, calibrated probabilities, and reviewed adaptive
   recommendations.

The initial ledger-free delivery MAY stop after step 4. Later coordination
MUST consume the stable Decision contract and input fingerprints rather than
requiring the intelligence layer to recompute or reinterpret execution state.

## 15. Conformance checklist

A conforming implementation:

- [ ] preserves CAO and gh-aw authority boundaries;
- [ ] consumes canonical evidence through a supported query boundary;
- [ ] distinguishes zero, missing, unavailable, partial, conflicting, and
      malformed evidence;
- [ ] applies security, authority, policy, and verification gates before
      optimization;
- [ ] avoids a universal composite score;
- [ ] does not label failed or cancelled cost as waste without a
      counterfactual rule;
- [ ] groups correlated signals before prioritization;
- [ ] preserves alternatives and non-compensable trade-offs;
- [ ] discloses forecast method, uncertainty, coverage, and assumptions;
- [ ] selects a feasible portfolio under explicit constraints;
- [ ] generates decision explanations from the actual computation path;
- [ ] keeps dashboard data operations declarative and outside UI components;
- [ ] dispatches workers with bounded decision envelopes;
- [ ] records decision feedback without treating acceptance as success; and
- [ ] preserves complete evidence and provenance drill-downs.

## 16. Related specifications

- [Dashboard Data Architecture Specification](dashboard-data.md)
- [Computations Specification](computations.md)
- [Dashboard Specification](dashboard.md)
- [Control Architecture Specification](control-architecture.md)
- [Operational-Value History Reconstruction Specification](operational-value-history.md)

## 17. Change log

### Version 0.3.0 — Working Draft

- Defined the Campaign-owned `intelligence.json` authoring envelope and
  installed control-repository location.
- Required strict identity, version, field, canonical-value, and duplicate
  validation.
- Required canonical Campaign records and compiled contracts to preserve the
  normalized declaration without granting authority.
- Bumped the compiled Campaign contract to `1.1.0` and portfolio Decisions to
  `1.2.0` for declaration provenance and explicit authority-context targets.

### Version 0.2.0 — Working Draft

- Added versioned ledger-free Campaign intelligence contracts.
- Added a normalized evidence-quality contract that fails malformed dimensions
  closed and preserves unknown coverage.
- Added fingerprint-bound Decision feedback with explicit terminal and
  nonterminal dispositions.

### Version 0.1.0 — Working Draft

- Defined the proactive CAO intelligence architecture.
- Separated shared portfolio intelligence from bounded campaign execution.
- Defined campaign intelligence contracts and authoring-time prevention.
- Added protect, sustain, invest, optimize, and simplify measure families.
- Defined forecasting, schedule fitness, overlap, attention, and decision
  synthesis requirements.
- Prohibited universal scoring and default classification of failed or
  cancelled resource use as waste.
