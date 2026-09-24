---
title: Operational Observability Visualization Specification
description: Evidence and visual-encoding requirements for attention-oriented agentic operations dashboards.
version: 0.2.0
status: Working Draft
editors:
  - GitHub Agentic Workflows Team
sidebar:
  order: 1363
---

# Operational Observability Visualization Specification

**Version:** 0.2.0
**Status:** Working Draft
**Editor:** GitHub Agentic Workflows Team

---

## Abstract

This specification defines how an agentic operations dashboard presents domain-level attention, runtime health, security and control evidence, operational value, execution episodes, resource usage, evidence quality, overlap, anomalies, and topology. It separates direct observations from inferred conditions; requires exact evidence for causal relationships; defines readiness gates for policy and statistical verdicts; and specifies accessible visual, textual, and compliance behavior. It does not define data collection, workflow execution, or control-plane policy.

## Status of This Document

This document is a Working Draft and may be updated, replaced, or made obsolete. It is intended for implementation feedback and does not represent endorsement by a standards body.

The GitHub Agentic Workflows Team maintains this document. Version numbers follow Semantic Versioning. Normative requirements are identified by `OOV-*` IDs. Examples, rationales, and the implementation profile in Appendix C are informative.

## Table of Contents

1. [Introduction](#1-introduction)
2. [Conformance](#2-conformance)
3. [Conceptual Model](#3-conceptual-model)
4. [Information Architecture](#4-information-architecture)
5. [Operational Attention](#5-operational-attention)
6. [Cost and Efficiency](#6-cost-and-efficiency)
7. [Episode Execution Maps](#7-episode-execution-maps)
8. [Overlap Views](#8-overlap-views)
9. [Statistical Anomaly Views](#9-statistical-anomaly-views)
10. [Topology Views](#10-topology-views)
11. [Interaction and Accessibility](#11-interaction-and-accessibility)
12. [Security and Privacy](#12-security-and-privacy)
13. [Compliance Testing](#13-compliance-testing)
14. [References](#14-references)
15. [Appendices](#15-appendices)
16. [Change Log](#16-change-log)

---

## 1. Introduction

### 1.1 Purpose

An operational dashboard must help an operator decide what requires attention, understand the observed execution shape, and inspect supporting evidence. A list of recent activity alone does not satisfy that need.

### 1.2 Scope

This specification covers:

- ranked operational-attention signals;
- domain-level attention states and investigation routes;
- time-bounded execution episodes and aligned run intervals;
- measured resource allocation and cost-evaluation readiness;
- campaign, worker, and target overlap views;
- statistically qualified anomaly views;
- static topology as secondary context;
- missing-data and uncertainty semantics; and
- accessible visual and textual presentation.

This specification does not cover:

- workflow orchestration or dispatch;
- data retention policy;
- automatic remediation;
- a universal anomaly score;
- causality inferred from temporal or naming proximity; or
- operational-value evaluation methodology.

### 1.3 Design Goals

The dashboard is designed to support these questions in order:

1. What requires attention now?
2. Which operational domain owns the condition?
3. What happened during the affected episode?
4. Where is work repeated or concentrated?
5. Is current behavior outside an established baseline or configured threshold?
6. What declared structure provides context?

### 1.4 Non-Goals

Visual novelty, exhaustive graph rendering, and a single composite health score are non-goals. The dashboard favors interpretable evidence over visual density.

---

## 2. Conformance

### 2.1 Requirements Notation

> The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [RFC 2119](https://www.ietf.org/rfc/rfc2119.txt).

### 2.2 Conformance Classes

This specification defines three conformance classes:

1. **Conforming data producer:** emits identifiers, timestamps, states, and provenance required by a presenter.
2. **Conforming presenter:** renders operational views while preserving evidence and uncertainty semantics.
3. **Conforming test suite:** verifies all requirements applicable to a claimed compliance level.

### 2.3 Compliance Levels

| Level | Name | Required capability |
|---|---|---|
| 1 | Basic | Attention queue, direct evidence links, missing-data states, and static topology separation. |
| 2 | Standard | Level 1 plus episode identity, aligned execution maps, and explicit attribution coverage. |
| 3 | Complete | Level 2 plus overlap and statistically qualified anomaly views when their readiness gates are met. |

- **OOV-CONF-001:** A conformance claim **MUST** identify the class, specification version, compliance level, implementation version, and test result.
- **OOV-CONF-002:** A conforming implementation **MUST** satisfy every requirement applicable to its claimed level.
- **OOV-CONF-003:** A partially conforming implementation **MAY** identify supported capabilities but **MUST NOT** claim a compliance level whose requirements it does not satisfy.

---

## 3. Conceptual Model

### 3.1 Terms

| Term | Definition |
|---|---|
| Campaign | A static control-plane definition containing an orchestrator and zero or more workers. |
| Episode | One observed orchestrator root run and only the worker or output evidence explicitly correlated to that root. |
| Signal | One independently interpretable reason for operator attention. |
| Attribution coverage | The ratio of explicitly attributed observations to eligible observed observations. |
| Execution map | A shared time axis containing observed lifecycle intervals for one episode. |
| Overlap | Multiple observed producers, campaigns, or attempts associated with the same target or outcome class. |
| Anomaly | An observation meeting a disclosed statistical rule against a representative historical baseline. |

### 3.2 Evidence Classes

Evidence is ordered by what it can establish, not by visual prominence:

1. **Direct state:** terminal run state, approval state, or durable output state.
2. **Exact association:** correlation identifier, trace or span link, or run URL that identifies both observations.
3. **Declared structure:** campaign membership and configured dispatch topology.
4. **Unknown:** missing, incomplete, or unattributed evidence.

- **OOV-MODEL-001:** A presenter **MUST** keep campaign topology and observed episodes as distinct entities.
- **OOV-MODEL-002:** A presenter **MUST NOT** create a causal edge from timestamp proximity, workflow-name similarity, or declared topology alone.
- **OOV-MODEL-003:** Missing attribution **MUST** remain visible as unknown and **MUST NOT** be assigned to the nearest plausible episode.
- **OOV-MODEL-004:** Control result, worker execution result, durable output state, and operational outcome **MUST** remain distinct evidence dimensions.

---

## 4. Information Architecture

### 4.1 Required Hierarchy

A Standard or Complete presenter **MUST** provide the following hierarchy:

1. a default attention overview organized by operational domain;
2. investigation views for runtime, security and controls, value and outcomes, and cost and efficiency; and
3. exploration views for dispatch events, workflow definitions, repositories, campaigns, runs, and retained outputs.

The attention overview **MUST** represent these domains when applicable evidence exists:

| Domain | Governing question | Primary investigation target |
|---|---|---|
| Runtime health | Are executions failing, blocked, or incomplete? | Runs and runtime triage. |
| Security and controls | Do control gates, explicit warnings, or assurance evidence require review? | Security and control evidence. |
| Value and outcomes | Which operational-grader metrics are available, and what do their declared units and directions mean? | Grader and outcome evidence. |
| Episodes and autonomy | Are orchestrator and worker behaviors attributable through exact evidence? | Correlated execution episodes. |
| Cost and efficiency | What resource allocation is measured, and can a budget or anomaly verdict be supported? | Usage and efficiency evidence. |
| Evidence quality | Which collection, inventory, or attribution gaps limit dashboard claims? | Coverage diagnostics. |

- **OOV-IA-001:** The first viewport **SHOULD** answer what requires attention without requiring operators to scan raw activity.
- **OOV-IA-002:** Summary views **MUST** provide navigation to supporting evidence or detail on demand.
- **OOV-IA-003:** A presenter **MUST NOT** use a notification banner as the primary container for a multi-item operational worklist.
- **OOV-IA-004:** Visual prominence **SHOULD** decrease from actionable observed evidence to static contextual structure.
- **OOV-IA-005:** The attention overview **MUST** keep operational domains distinct and **MUST NOT** merge them into a composite health, risk, value, or cost score.
- **OOV-IA-006:** Primary navigation **MUST** distinguish attention, investigation, and exploration destinations through visible labels, grouping, or equivalent semantics.
- **OOV-IA-007:** Runtime triage and observed episodes **SHOULD** share an investigation surface; static topology and searchable workflow definitions **SHOULD** share an exploration surface.
- **OOV-IA-008:** A domain summary **MUST** identify the applicable state, the material observed value or unavailable prerequisite, and one investigation target.

### 4.2 Operator Question to Visual Form

| Operator question | Preferred form | Readiness condition |
|---|---|---|
| What needs attention? | Ranked evidence worklist | One or more direct states or explicit evidence gaps. |
| Which domain owns attention? | Domain card grid ordered by urgency | Domain evidence or an explicitly unavailable prerequisite. |
| What happened and when? | Episode waterfall or state timeline | Lifecycle timestamps and an exact root identity. |
| Is measured resource use within policy? | Usage allocation plus readiness boundary | Complete aligned usage and an applicable policy threshold. |
| Where does work overlap? | Producer-by-target matrix or UpSet-style intersection view | Explicit producer-target associations and visible set sizes. |
| Is behavior unusual? | Distribution plus control or drift chart | Representative comparable baseline and disclosed method. |
| How is the system intended to connect? | Static grouped topology | Versioned campaign and workflow definitions. |

---

## 5. Operational Attention

### 5.1 Signal Vocabulary

The core signal vocabulary is:

1. failed root episode;
2. failed workflow runs;
3. approval-gated runs;
4. incomplete attribution;
5. explicit warning-bearing outputs;
6. open durable outcomes;
7. repeated target coverage; and
8. unavailable or incomplete telemetry.

### 5.2 Ranking

- **OOV-ATTN-001:** Each signal **MUST** expose a signal type, subject, evidence statement, observation window or evidence time, and investigation target.
- **OOV-ATTN-002:** A count **MUST** include its eligible denominator when a denominator exists.
- **OOV-ATTN-003:** A presenter **MUST** rank direct failures before approval gates, approval gates before evidence gaps, and evidence gaps before non-terminal points of interest.
- **OOV-ATTN-004:** Ties **SHOULD** be ordered by affected count, then stable subject identity.
- **OOV-ATTN-005:** A presenter **MUST NOT** combine heterogeneous signals into an opaque health, risk, or anomaly score.
- **OOV-ATTN-006:** Repeated coverage, no-action output, warning count, and AIC without outcome evidence **MUST** be labeled as investigation signals and **MUST NOT** be labeled as waste.
- **OOV-ATTN-007:** The attention worklist **MUST** expose its ordering rule.
- **OOV-ATTN-008:** When no direct signals exist, the presenter **MUST** render a positive empty state and identify the evaluated signal classes.

### 5.3 Rationale

Symptom-first attention follows SRE guidance: urgent operational signals should be actionable and should describe what is broken; diagnostic causes remain available in supporting detail. Separate dimensions make the ranking auditable and prevent a changing weighted score from concealing evidence.

### 5.4 Domain Attention States

The domain-level vocabulary is:

| State | Meaning |
|---|---|
| Act now | Direct evidence establishes a terminal failure or equivalent immediate operational condition. |
| Investigate | Direct evidence establishes a control gate, collection gap, attribution gap, warning, open outcome requiring disposition, or breached applicable threshold that requires interpretation or action. |
| Monitor | Sufficient evidence exists and no direct attention condition is observed. |
| Unavailable | A required evidence feed, baseline, or applicable policy threshold is absent. No positive or negative verdict is possible. |

- **OOV-STATE-001:** A presenter **MUST** use deterministic, disclosed rules to assign domain states.
- **OOV-STATE-002:** `Act now` **MUST** require direct evidence of a terminal failure or an equivalently defined immediate condition.
- **OOV-STATE-003:** `Investigate` **MUST** identify the direct signal or evidence gap that caused the state.
- **OOV-STATE-004:** `Monitor` **MUST NOT** be used when evidence required to evaluate the domain is unavailable.
- **OOV-STATE-005:** `Unavailable` **MUST** identify the missing prerequisite and **MUST NOT** be presented as healthy, passing, within budget, or below threshold.
- **OOV-STATE-006:** Domain cards **MUST** be ordered by state urgency and then by a stable domain identity.

---

## 6. Cost and Efficiency

### 6.1 Measurement Semantics

- **OOV-COST-001:** A presenter **MUST** label AI Credit or token usage as resource allocation and **MUST NOT** describe it as monetary cost unless an explicit, versioned conversion model exists.
- **OOV-COST-002:** Usage totals **MUST** disclose their observation window, measured-run count, and collection completeness.
- **OOV-COST-003:** Per-repository, per-workflow, or per-episode allocation **MUST** use exact run or output attribution.
- **OOV-COST-004:** Output yield, repeated execution, and no-action counts **MAY** be presented as investigation aids but **MUST NOT** be labeled efficiency, savings, or waste without an explicit outcome and opportunity-cost model.

### 6.2 Budget and Anomaly Readiness

- **OOV-COST-005:** A budget verdict **MUST** require an applicable budget, a matching measurement window, and complete measured usage for that window.
- **OOV-COST-006:** When any budget prerequisite is absent, the presenter **MUST** display `budget status unavailable` or equivalent language.
- **OOV-COST-007:** Cost or usage anomaly labels **MUST** satisfy all requirements in [Section 9](#9-statistical-anomaly-views).
- **OOV-COST-008:** A cost investigation view **MUST** preserve links to allocation evidence and collection diagnostics.

---

## 7. Episode Execution Maps

### 6.1 Episode Identity

- **OOV-EP-001:** An episode **MUST** have one root run identity.
- **OOV-EP-002:** A worker run or output **MUST** join an episode only through an exact correlation identifier, trace or span link, or explicit run relationship.
- **OOV-EP-003:** A presenter **MUST** expose the attribution numerator and eligible dispatch denominator.

### 6.2 Visual Encoding

- **OOV-EP-004:** An execution map **MUST** align root and worker lifecycle intervals on one monotonic time axis.
- **OOV-EP-005:** Each lane **MUST** identify its role, subject, duration, and terminal or current state in text.
- **OOV-EP-006:** Lane length **MUST** encode elapsed time when both boundary timestamps are available.
- **OOV-EP-007:** A missing interval **MUST** appear as absent or unavailable; it **MUST NOT** be rendered as a zero-duration successful interval.
- **OOV-EP-008:** The map **MUST** state whether intervals are observed, estimated, or inferred. A Standard presenter conforming to this specification **MUST NOT** infer intervals.
- **OOV-EP-009:** Visual alignment **MUST NOT** be described as a dispatch edge or critical path unless exact causal evidence establishes that relationship.

### 6.3 Critical Path

A presenter **MAY** highlight a critical path when complete parent-child or span-link evidence exists. If evidence is partial, the presenter **MUST** use the term "execution shape" rather than "critical path."

---

## 8. Overlap Views

### 7.1 Matrix Form

- **OOV-OVR-001:** Pairwise campaign-target or worker-target overlap **SHOULD** use a matrix when the number of relationships would make node-link crossings difficult to trace.
- **OOV-OVR-002:** A matrix **MUST** label both axes and **MUST** expose the value encoded by each cell.
- **OOV-OVR-003:** Row totals and column totals **MUST** remain visible with pairwise intersections.
- **OOV-OVR-004:** A cell **MUST** distinguish attempt count, unique episode count, actionable-output count, and no-action count; these measures **MUST NOT** be silently combined.

### 7.2 Set Intersections

An UpSet-style view **MAY** replace or complement a pairwise matrix when operators need exact intersections among four or more producer sets.

- **OOV-OVR-005:** An intersection view **MUST** show individual set sizes alongside intersection sizes.
- **OOV-OVR-006:** An overlap view **MUST** use explicit target and producer associations.
- **OOV-OVR-007:** Overlap **MUST NOT** be labeled duplication or waste without outcome equivalence and an explicit cost or opportunity model.
- **OOV-OVR-008:** When no correlated producer-target observations exist, the view **MUST** render a readiness state rather than an empty decorative matrix.

---

## 9. Statistical Anomaly Views

### 8.1 Readiness

- **OOV-ANOM-001:** A presenter **MUST NOT** label an observation anomalous without a representative baseline of comparable observations.
- **OOV-ANOM-002:** The presenter **MUST** disclose the cohort, lookback interval, sample count, method, parameters, and false-alarm interpretation used by an anomaly rule.
- **OOV-ANOM-003:** When readiness requirements are not met, the presenter **MUST** display "not evaluated" or equivalent language and explain the missing prerequisite.
- **OOV-ANOM-004:** Low-traffic cohorts **MUST NOT** be evaluated using unstable rates without exposing raw event counts.

### 8.2 Methods

A Complete presenter MAY support Shewhart-style control limits for abrupt shifts, exponentially weighted moving averages for gradual drift, or cumulative sums for small persistent shifts.

- **OOV-ANOM-005:** Method selection and parameters **MUST** be defined before evaluating the displayed observation.
- **OOV-ANOM-006:** Control limits **MUST NOT** be described as specification limits or service objectives.
- **OOV-ANOM-007:** Duration analysis **SHOULD** expose a distribution or upper-tail quantile and **SHOULD NOT** rely on an arithmetic mean alone.
- **OOV-ANOM-008:** A statistically unusual observation **MUST** remain distinct from an actionable failure.

---

## 10. Topology Views

- **OOV-TOPO-001:** Static topology **MUST** be labeled as expected, configured, or declared structure.
- **OOV-TOPO-002:** Static topology **MUST NOT** assert that a dispatch or execution occurred.
- **OOV-TOPO-003:** Node-link edges **MUST** distinguish declared relationships from observed causal relationships through both text and visual treatment.
- **OOV-TOPO-004:** A dense many-to-many relationship **SHOULD** use grouped lists or a matrix instead of a node-link graph.

---

## 11. Interaction and Accessibility

- **OOV-A11Y-001:** Color **MUST NOT** be the only means of conveying state, severity, role, or selection.
- **OOV-A11Y-002:** Meaningful graphical objects and state boundaries **MUST** meet WCAG 2.2 non-text contrast requirements.
- **OOV-A11Y-003:** Every chart or map **MUST** have an accessible name and a textual equivalent containing its material values.
- **OOV-A11Y-004:** Keyboard users **MUST** be able to reach every investigation target and details-on-demand control.
- **OOV-A11Y-005:** Hover-only evidence **MUST** also be available through focus or persistent text.
- **OOV-A11Y-006:** Status text **SHOULD** use sentence case and concise, stable terminology.
- **OOV-A11Y-007:** The layout **MUST NOT** introduce horizontal page overflow at a 320 CSS pixel viewport. A locally scrollable matrix or timeline **MAY** overflow its labeled region.
- **OOV-INT-001:** Filters **SHOULD** preserve their state in the URL when a stable URL representation exists.
- **OOV-INT-002:** An attention row **SHOULD** make the complete row an investigation target when it has exactly one destination.

---

## 12. Security and Privacy

- **OOV-SEC-001:** A presenter **MUST** escape untrusted labels, titles, paths, and evidence text before rendering HTML.
- **OOV-SEC-002:** Investigation URLs **MUST** be validated against an allowlisted scheme.
- **OOV-SEC-003:** Private repository names and run metadata **MUST NOT** be exposed to an audience lacking corresponding repository authorization.
- **OOV-SEC-004:** Free-form output text **SHOULD** be summarized or redacted before appearing in a high-level attention surface.
- **OOV-SEC-005:** Correlation identifiers **MUST NOT** contain credentials or authentication tokens.

---

## 13. Compliance Testing

### 13.1 Test Procedure

A conforming test suite MUST generate the dashboard from deterministic fixtures, inspect semantic output, and execute browser checks at desktop and 320 CSS pixel viewports. Each result MUST record the test ID, requirement IDs, implementation version, fixture digest, status, and failure evidence.

### 13.2 Required Tests

- **T-OOV-001:** Generate mixed failures, approval gates, evidence gaps, warnings, and open outcomes; verify lexicographic signal ordering and visible denominators.
- **T-OOV-002:** Generate no attention signals; verify the positive empty state names evaluated signal classes.
- **T-OOV-003:** Provide one exact root-worker correlation and one temporally adjacent uncorrelated worker; verify only the exact correlation joins the episode.
- **T-OOV-004:** Provide root and worker lifecycle intervals; verify shared-axis positions, duration labels, roles, and textual states.
- **T-OOV-005:** Omit one lifecycle boundary; verify the lane is absent or unavailable and is not rendered successful.
- **T-OOV-006:** Provide unattributed dispatches; verify numerator, denominator, and an inspectable unattributed ledger.
- **T-OOV-007:** Provide producer-target observations; verify matrix labels, cell values, and row and column totals.
- **T-OOV-008:** Provide no correlated producer-target observations; verify readiness messaging replaces the matrix.
- **T-OOV-009:** Provide an insufficient anomaly baseline; verify the presenter says "not evaluated" and emits no anomaly label.
- **T-OOV-010:** Provide a qualified baseline and fixed statistical parameters; verify method disclosure and deterministic labels.
- **T-OOV-011:** Verify declared topology never uses observed-execution language.
- **T-OOV-012:** Verify all state encodings remain distinguishable without color and all evidence links are keyboard reachable.
- **T-OOV-013:** Verify no horizontal page overflow at 320 CSS pixels and contained scrolling for wide analytical views.
- **T-OOV-014:** Inject HTML and non-HTTPS investigation URLs; verify escaping and URL rejection.
- **T-OOV-015:** Generate mixed domain evidence; verify six distinct domain summaries, deterministic urgency ordering, state labels, material values or unavailable prerequisites, and investigation targets.
- **T-OOV-016:** Omit a value threshold, budget, and qualified usage baseline; verify the presenter reports each verdict unavailable and emits no pass, within-budget, or anomaly claim.
- **T-OOV-017:** Verify primary navigation distinguishes attention, investigation, and exploration destinations and that runtime episodes are separate from workflow topology and inventory.

### 13.3 Compliance Checklist

| Capability | Requirements | Test IDs | Level |
|---|---|---|---|
| Attention ranking | OOV-ATTN-001–008 | T-OOV-001–002 | 1 |
| Domain command center | OOV-IA-001–008, OOV-STATE-001–006 | T-OOV-015, T-OOV-017 | 1 |
| Evidence semantics | OOV-MODEL-001–004 | T-OOV-003, T-OOV-006 | 1 |
| Cost and efficiency | OOV-COST-001–008 | T-OOV-009, T-OOV-016 | 1–3 |
| Episode maps | OOV-EP-001–009 | T-OOV-003–006 | 2 |
| Overlap views | OOV-OVR-001–008 | T-OOV-007–008 | 3 |
| Anomaly views | OOV-ANOM-001–008 | T-OOV-009–010 | 3 |
| Topology | OOV-TOPO-001–004 | T-OOV-011 | 1 |
| Accessibility | OOV-A11Y-001–007, OOV-INT-001–002 | T-OOV-012–013 | 1–3 |
| Security and privacy | OOV-SEC-001–005 | T-OOV-014 | 1–3 |

---

## 14. References

### 14.1 Normative References

- **[RFC 2119]** Bradner, S. *Key words for use in RFCs to Indicate Requirement Levels*. <https://www.ietf.org/rfc/rfc2119.txt>
- **[WCAG 2.2]** W3C. *Web Content Accessibility Guidelines (WCAG) 2.2*. <https://www.w3.org/TR/WCAG22/>

### 14.2 Informative References

- **[GRAFANA-STATE]** Grafana Labs. *State timeline*. <https://grafana.com/docs/grafana/latest/panels-visualizations/visualizations/state-timeline/>
- **[GRAFANA-TRACE]** Grafana Labs. *Traces in Explore*. <https://grafana.com/docs/grafana/latest/explore/trace-integration/>
- **[GOOGLE-SRE-MONITORING]** Google. *Monitoring Distributed Systems*. <https://sre.google/sre-book/monitoring-distributed-systems/>
- **[GOOGLE-SRE-ALERTING]** Google. *Alerting on SLOs*. <https://sre.google/workbook/alerting-on-slos/>
- **[NIST-CONTROL]** NIST/SEMATECH. *What are Control Charts?* <https://www.itl.nist.gov/div898/handbook/pmc/section3/pmc31.htm>
- **[NIST-EWMA]** NIST/SEMATECH. *EWMA Control Charts*. <https://www.itl.nist.gov/div898/handbook/pmc/section3/pmc314.htm>
- **[NIST-CUSUM]** NIST/SEMATECH. *CUSUM Control Charts*. <https://www.itl.nist.gov/div898/handbook/pmc/section3/pmc313.htm>
- **[OTEL-TRACES]** OpenTelemetry. *Traces*. <https://opentelemetry.io/docs/concepts/signals/traces/>
- **[OPENLINEAGE-RUN]** OpenLineage. *Run Cycle*. <https://openlineage.io/docs/spec/run-cycle/>
- **[UPSET]** Lex, A. et al. *UpSet: Visualization of Intersecting Sets*. IEEE Transactions on Visualization and Computer Graphics, 2014. <https://doi.org/10.1109/TVCG.2014.2346248>
- **[MATRIX-NODE-LINK]** Ghoniem, M., Fekete, J.-D., and Castagliola, P. *A Comparison of the Readability of Graphs Using Node-Link and Matrix-Based Representations*. IEEE Symposium on Information Visualization, 2004. <https://doi.org/10.1109/INFVIS.2004.1>
- **[VISUAL-MANTRA]** Shneiderman, B. *The Eyes Have It: A Task by Data Type Taxonomy for Information Visualizations*. IEEE Symposium on Visual Languages, 1996. <https://doi.org/10.1109/VL.1996.545307>
- **[GOVUK-TASK-LIST]** GOV.UK Design System. *Task list*. <https://design-system.service.gov.uk/components/task-list/>
- **[FINOPS-FRAMEWORK]** FinOps Foundation. *FinOps Framework*. <https://www.finops.org/framework/>
- **[NIST-AI-RMF]** NIST. *AI Risk Management Framework*. <https://www.nist.gov/itl/ai-risk-management-framework>
- **[OWASP-GENAI]** OWASP Foundation. *GenAI Security Project*. <https://genai.owasp.org/>

---

## 15. Appendices

### Appendix A: Example Attention Signal

```json
{
  "type": "run-failures",
  "subject": "Multi-Device Docs Tester",
  "observed": 10,
  "eligible": 22,
  "window": "PT24H",
  "evidence": "10 of 22 retained runs failed",
  "investigationUrl": "../repositories/example--workflow--docs-tester-insights.html"
}
```

### Appendix B: Example Episode

```json
{
  "rootRunId": 33271661485,
  "correlationId": "33271661485-1",
  "startedAt": "2026-08-29T19:44:53Z",
  "updatedAt": "2026-08-29T19:50:28Z",
  "workerAttempts": [],
  "evidence": "root-only"
}
```

The absent worker list is an evidence gap. An implementation must not populate it from nearby worker timestamps.

### Appendix C: Current Implementation Profile

This appendix is informative and describes the initial Central Agentic Ops implementation.

| View | Current readiness | Reason |
|---|---|---|
| Domain attention overview | Implemented | Six domains use deterministic urgency states and link to evidence. |
| Runtime investigation | Implemented | Failures, approval gates, and attribution gaps are ranked independently. |
| Security and controls | Partially implemented | Operational assurance signals exist; no vulnerability feed is retained. |
| Value and outcomes | Partially implemented | Grader attainment is retained; no applicable pass threshold is retained. |
| Cost and efficiency | Partially implemented | AIC allocation is retained; budget and anomaly prerequisites are absent. |
| Episode execution map | Partially implemented | Root timestamps exist; worker lanes appear only when exact retained correlation exists. |
| Producer-target matrix | Deferred | The current 24-hour sample has no correlated worker-target attempt evidence. |
| Statistical anomaly view | Deferred | The current window does not establish a representative historical baseline. |
| Definition topology | Implemented | Versioned local campaign inventory is available. |

### Appendix D: Error Codes

| Code | Meaning |
|---|---|
| OOV-E001 | Missing root identity. |
| OOV-E002 | Invalid or ambiguous causal association. |
| OOV-E003 | Missing lifecycle boundary. |
| OOV-E004 | Overlap view lacks explicit producer-target associations. |
| OOV-E005 | Anomaly baseline is not qualified. |
| OOV-E006 | Investigation URL uses a prohibited scheme. |
| OOV-E007 | Applicable value threshold or aligned budget measurement is unavailable. |
| OOV-E008 | Usage collection window does not align with the applicable budget window. |

---

## 16. Change Log

### Version 0.2.0 (Working Draft)

- **Added:** Six-domain attention Overview and attention, investigation, and exploration navigation hierarchy.
- **Added:** Deterministic `Act now`, `Investigate`, `Monitor`, and `Unavailable` state semantics.
- **Added:** Cost allocation, budget readiness, and anomaly readiness requirements.
- **Changed:** Runtime triage and episodes are investigation views; topology and workflow inventory are exploration views.
- **Added:** Command-center and cost-boundary compliance tests.

### Version 0.1.0 (Working Draft)

- **Added:** Evidence-ranked operational attention requirements.
- **Added:** Exact-correlation episode and execution-map requirements.
- **Added:** Matrix and set-intersection guidance for overlap.
- **Added:** Statistical readiness gates and method disclosure.
- **Added:** Accessibility, security, and compliance requirements.