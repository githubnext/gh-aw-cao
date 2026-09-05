---
title: Dashboard Language Specification
description: A declarative YAML language for agentic workflow dashboards.
sidebar:
  order: 1362
---

# Dashboard Language Specification

**Version:** 0.1.0
**Status:** Working Draft
**Editor:** GitHub Agentic Workflows Team

---

## Abstract

This specification defines a small, declarative, YAML-based language for describing dashboards about organizations, repositories, centrally managed packages, agentic workflows, runs, experiments, graders, evals, usage, findings, and operational value. A dashboard contains built-in pages or custom pages. Custom pages use a constrained Vega-inspired model composed of `data`, `mark`, and mark-specific configuration. This specification defines intrinsic domain semantics, aggregation and filtering rules, route-bound custom-page allocation, provenance and freshness requirements, explicit unavailable-data states, links, conformance, and compliance tests. It does not define data retrieval, implementation architecture, or rendering technology.

## Status of This Document

This document is a Working Draft and may be updated, replaced, or made obsolete. It is intended for review and implementation feedback and is not a final recommendation.

The GitHub Agentic Workflows Team maintains this document. Version numbers follow Semantic Versioning. Working Draft publication does not imply endorsement by any standards body.

Sections containing numbered requirements are normative. Examples, notes, rationales, and appendices identified as informative are non-normative unless stated otherwise.

## Table of Contents

1. [Introduction](#1-introduction)
2. [Conformance](#2-conformance)
3. [Terminology and Conceptual Model](#3-terminology-and-conceptual-model)
4. [YAML Document Model](#4-yaml-document-model)
5. [Intrinsic Semantic Model](#5-intrinsic-semantic-model)
6. [Scope, Time, and Filters](#6-scope-time-and-filters)
7. [Dimensions, Measures, and Aggregation](#7-dimensions-measures-and-aggregation)
8. [Provenance, Freshness, and Data States](#8-provenance-freshness-and-data-states)
9. [Links and Findings](#9-links-and-findings)
10. [Built-in Pages](#10-built-in-pages)
11. [Custom Pages](#11-custom-pages)
12. [Validation and Errors](#12-validation-and-errors)
13. [Security, Privacy, and Accessibility](#13-security-privacy-and-accessibility)
14. [Compliance Testing](#14-compliance-testing)
15. [References](#15-references)
16. [Change Log](#16-change-log)
17. [Appendices](#appendices)

---

## 1. Introduction

### 1.1 Purpose

The Dashboard Language provides a portable vocabulary for defining what an agentic-operations dashboard communicates without prescribing how data is fetched, stored, cached, deployed, or rendered.

### 1.2 Scope

This specification covers:

- a single-document YAML format;
- built-in and custom dashboard pages;
- intrinsic agentic-operations entities and observations;
- dimensions, measures, aggregation, scope, time, and filters;
- constrained hash-query routing for custom pages;
- provenance, freshness, missing-data semantics, and links; and
- validation, conformance, and compliance testing.

This specification does not cover:

- arbitrary scripts, joins, formulas, expressions, or content templates;
- plugins, themes, renderer details, or implementation architecture;
- deployment-level routing, fetching, authentication, caching, or storage;
- campaign or experiment management; or
- causal inference.

### 1.3 Design Goals

The language is designed to be minimal, deterministic, auditable, and safe to validate. Built-in pages provide useful defaults. Custom pages provide only metric, table, chart, and time-series views.

### 1.4 Basis and Domain Additions

The built-in page requirements are grounded in reviewed Central Agentic Ops surfaces: an overview organized by runtime, security and controls, value and outcomes, episodes and autonomy, cost and efficiency, and evidence quality; rollout-mode filtering; repository and workflow inventory; package AIC utilization; package-run trends; run status and conclusion trends and counts; repository and workflow rankings; largest AIC spenders; linked findings; operational-value timelines; explicit provenance and freshness; and empty or unavailable states.

Engine, engine-version, requested-model, and resolved-model dimensions are GitHub Agentic Workflows domain requirements. Central Agentic Ops surfaces them where retained telemetry or durable-output provenance makes them available, and reports `unknown` rather than inferring missing values.

---

## 2. Conformance

### 2.1 Requirements Notation

> The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [RFC 2119](https://www.ietf.org/rfc/rfc2119.txt).

### 2.2 Conformance Classes

This specification defines three conformance classes:

1. **Dashboard document:** one YAML document claiming this language version.
2. **Validator:** parses a dashboard document and reports validity.
3. **Presenter:** consumes a valid document and conforming logical data to expose the specified information.

### 2.3 Normative Conformance Requirements

- **DLS-CONF-001:** A conformance claim **MUST** identify its class, specification version, implementation version when applicable, and test-suite result.
- **DLS-CONF-002:** A conforming dashboard document **MUST** satisfy all `DLS-DOC-*` requirements.
- **DLS-CONF-003:** A conforming validator **MUST** enforce all `DLS-DOC-*`, `DLS-VAL-*`, and parser-applicable `DLS-SAFE-*` requirements.
- **DLS-CONF-004:** A conforming presenter **MUST** satisfy all `DLS-SEM-*`, `DLS-CTX-*`, `DLS-AGG-*`, `DLS-DATA-*`, `DLS-LINK-*`, `DLS-PAGE-*`, `DLS-VIEW-*`, presenter-applicable `DLS-SAFE-*`, and `DLS-TEST-*` requirements.
- **DLS-CONF-005:** A non-conforming implementation **MAY** document supported subsets but **MUST NOT** claim conformance to this specification.

---

## 3. Terminology and Conceptual Model

### 3.1 Terms

| Term | Meaning |
|---|---|
| Dashboard | One named collection of ordered pages and shared defaults. |
| Site-wide callout | One dashboard-level text notice shown independently of the active page and dismissible for the lifetime of the loaded document. |
| Built-in page | A page whose semantic content is defined by Section 10. |
| Custom page | A page containing one or more declarative views. |
| Package | A repository-scoped group containing one centrally managed orchestrator workflow and one or more worker workflows. |
| Workflow role | A workflow's role as `orchestrator`, `worker`, or `standalone`; standalone workflows do not belong to a package. |
| Package AIC allowance | The sum of configured per-run AI Credit limits for one complete package attempt. |
| Dimension | A categorical, identifying, or temporal value used to group or filter observations. |
| Measure | A numeric observation that may be aggregated only according to its declared semantics. |
| Observation | A recorded value with time, provenance, and data-quality metadata. |
| Raw token | A provider-reported token count in one token class; not a currency or normalized cost. |
| AI Credits (`aic`) | A normalized usage or accounting measure supplied by an authoritative source; not a token count. |
| Run conclusion | The terminal GitHub Actions result of a completed run. |
| Outcome | A later repository-state evaluation of a safe output, distinct from run status and conclusion. |
| Operational value | Absolute operational attainment in `[0,1]` or `null`; not evidence of causation. |

### 3.2 Entity Relationships

```text
organization
  └─ repository
       ├─ package
       │    ├─ orchestrator workflow
       │    └─ worker workflow
       └─ standalone workflow
            └─ run
                 ├─ experiment assignment
                 ├─ usage observations
                 ├─ grader observations
                 ├─ eval observations
                 ├─ outcome observations
                 ├─ findings
                 └─ operational-value observations
```

Every workflow role may have runs and their associated observations; the diagram expands that relationship once for brevity. Graders and evals are definitions. Grader observations and eval observations are records produced using those definitions. An experiment assignment associates one run with one named variant, but this language does not manage experiments.

### 3.3 Normative Semantic Foundations

- **DLS-SEM-001:** An implementation **MUST** model an organization as the parent scope of zero or more repositories.
- **DLS-SEM-002:** An implementation **MUST** model a repository as belonging to exactly one organization and as containing zero or more workflows.
- **DLS-SEM-003:** An implementation **MUST** model a workflow as belonging to exactly one repository and a run as an execution of exactly one workflow.
- **DLS-SEM-004:** Workflow active state **MUST** use `true`, `false`, or `unknown`; `unknown` **MUST NOT** be treated as either Boolean value.
- **DLS-SEM-005:** Run lifecycle status **MUST** use `queued`, `in-progress`, `completed`, or `unknown`; upstream `in_progress` **MUST** normalize to `in-progress`.
- **DLS-SEM-006:** Run conclusion **MUST** use `success`, `failure`, `cancelled`, `timed-out`, `action-required`, `neutral`, `skipped`, `stale`, `startup-failure`, or `unknown`; upstream underscore-separated values **MUST** normalize to kebab-case. A non-completed run **MUST** have conclusion `unknown`.
- **DLS-SEM-007:** An experiment assignment **MUST** identify an experiment, variant, and run; absence of an assignment **MUST NOT** imply membership in a control or treatment group.
- **DLS-SEM-008:** A grader observation **MUST** identify its grader, observed subject, observation time, `value`, and `status`; status **MUST** use `pass`, `fail`, `error`, or `unavailable`. It **MUST NOT** be represented as an eval observation.
- **DLS-SEM-009:** An eval observation **MUST** identify its eval, observed subject, observation time, and BinEval result of `YES`, `NO`, or `UNKNOWN`; it **MUST NOT** be represented as a grader observation.
- **DLS-SEM-010:** A usage observation **MUST** retain raw `input-tokens`, `output-tokens`, `cache-read-tokens`, `cache-write-tokens`, and `reasoning-tokens` as separate measures and **MUST NOT** label any of them as `aic`.
- **DLS-SEM-011:** An AIC observation **MUST** be represented by `aic` and **MUST NOT** be inferred from raw tokens unless the data provenance identifies an authoritative conversion.
- **DLS-SEM-012:** A run-associated usage observation **MUST** preserve `engine`, `requested-model`, and `resolved-model` as distinct dimensions; an unavailable value **MUST** be `unknown`.
- **DLS-SEM-013:** An operational-value observation **MUST** identify itself, its definition, operational case, evaluator digest, run attempt, observed subject, observation time, requested evidence time, effective evidence cutoff, maturity time and status, and accepted evidence provenance. Its primary value **MUST** be absolute attainment in `[0,1]` or `null`. Declared diagnostic definitions and values **MUST** remain distinct from primary attainment.
- **DLS-SEM-014:** An implementation **MUST NOT** present experiment, grader, eval, usage, outcome, finding, or operational-value associations as causal conclusions.
- **DLS-SEM-015:** An outcome observation **MUST** identify its safe output and use `accepted`, `rejected`, `ignored`, `pending`, `lifecycle`, or `lifecycle-close`; upstream `lifecycle_close` **MUST** normalize to `lifecycle-close`. It **MUST NOT** be represented as a run conclusion.
- **DLS-SEM-016:** An optional operational-value baseline delta **MUST** remain separate from the primary absolute value and **MUST NOT** replace it.

---

## 4. YAML Document Model

### 4.1 Root Structure

The media type is not assigned by this specification. Files conventionally use `.yaml` or `.yml`.

```yaml
language-version: "0.1.0"
dashboard:
  id: example-dashboard
  title: Example Dashboard
  github-url-base: https://github.com
  callouts:
    - id: maintenance-notice
      title: Scheduled maintenance
      description: Dashboard data will not refresh between 02:00 and 03:00 UTC.
      icon: alert
  horizon:
    label: Horizon
    tooltip:
      label: Horizon details
      description: Dashboard data is included from the start time up to, but not including, the end time.
      icon: question
  defaults:
    scope: {}
    time: {}
    filters: {}
  pages: []
```

### 4.2 Vocabulary

Language keys and enumerated values use canonical kebab-case. Human-readable titles and descriptions are unrestricted Unicode strings. Domain identifiers such as `owner/repository` and workflow paths retain their domain syntax.

| Mapping | Allowed keys |
|---|---|
| Root | `language-version`, `dashboard` |
| `dashboard` | `id`, `title`, `description`, `github-url-base`, `repository`, `callouts`, `horizon`, `defaults`, `units`, `pages`, `navigation` |
| Site-wide callout | `id`, `title`, `description`, `icon`, `visible-when` |
| Callout `visible-when` | `source`, `field`, `equals` |
| Dashboard `horizon` | `label`, `tooltip` |
| Tooltip | `label`, `description`, `icon` |
| `defaults` | `scope`, `time`, `filters` |
| Unit definition | `name`, `symbol`, `significant`, `format` |
| Built-in page | `id`, `kind`, `page`, `title`, `navigation-label`, `description`, `icon`, `class-name`, `definition` |
| Custom page | `id`, `kind`, `title`, `navigation-label`, `description`, `icon`, `class-name`, `route`, `views`, `sections` |
| Page section | `id`, `title`, `description`, `layout`, `views`, `count-source`, `count-label` |
| Custom page `route` | `hash-query-parameter`, `navigation-page` |
| View | `id`, `title`, `description`, `intent`, `locked`, `data`, `mark`, `element`, `config`, `callout`, `chart`, `table`, `tree`, `layout`, `disclosure`, `controls`, `column-summaries`, `empty-message`, `title-link`, `encoding` |
| View `data` | `source` or `sources`, `scope`, `time`, `filters`, `limit`, `order-by` |
| View `config` | `body` |
| View `title-link` | `href-field`, `identifier-field` |
| Table action | `intent`, `presentation`, `icon`, `label`, `context`, `when` |
| Table action `when` | `field`, `equals` |
| Field definition | `field`, `type`, `aggregate`, `time-unit`, `title`, `as` (only when `aggregate` is not `none`), `display`, `unit` |

### 4.3 Normative Document Requirements

- **DLS-DOC-001:** A dashboard file **MUST** be valid YAML 1.2 and contain exactly one YAML document whose root is a mapping.
- **DLS-DOC-002:** The root **MUST** contain exactly `language-version` and `dashboard`.
- **DLS-DOC-003:** `language-version` **MUST** be the quoted string `"0.1.0"`.
- **DLS-DOC-004:** `dashboard` **MUST** contain a non-empty `id`, non-empty `title`, and non-empty `pages` sequence.
- **DLS-DOC-005:** Dashboard, page, and view IDs **MUST** match `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` and page IDs and view IDs **MUST** each be unique within their containing sequence.
- **DLS-DOC-006:** Language keys and enumerated values defined by this specification **MUST** use their exact canonical kebab-case spelling.
- **DLS-DOC-007:** A validator **MUST** reject unknown keys, unknown enumerated values, and duplicate mapping keys.
- **DLS-DOC-008:** `defaults`, when present, **MUST** be a mapping containing only `scope`, `time`, and `filters`.
- **DLS-DOC-009:** Every page **MUST** set `kind` to `built-in` or `custom` and satisfy the corresponding page shape in Sections 10 or 11.
- **DLS-DOC-009a:** `config`, when present, **MUST** appear only on `mark: element` views. Version 0.1.0 defines `config.body` only for the `workflow-route`, `package-route`, `outcome-detail-section`, and `experiments-evaluation` elements. For `workflow-route`, it **MUST** be one of `insights`, `reports`, or `runs`. For `package-route`, it **MUST** be one of `insights`, `workflows`, `dispatches`, or `reports`. For `outcome-detail-section`, it **MUST** be `discussion` or `metadata`. For `experiments-evaluation`, it **MUST** be `overview`, `table`, or `detail`.
- **DLS-DOC-010:** Titles and descriptions **MUST** be strings; IDs, references, and timestamps **MUST NOT** rely on YAML implicit type coercion.
- **DLS-DOC-011:** `github-url-base`, when present, **MUST** be an absolute HTTPS URL without credentials, query, or fragment. It identifies the GitHub web URL base used to resolve GitHub-addressable entity links and defaults to `https://github.com`.
- **DLS-DOC-012:** `repository`, when present, **MUST** be a non-empty `owner/repo` slug identifying the GitHub repository hosting the dashboard. A presenter **MUST NOT** fabricate a report action toolbar's GitHub repository link when `repository` is absent.
- **DLS-DOC-013:** `units`, when present, **MUST** be a non-empty mapping keyed by unique canonical identifiers. Each value **MUST** contain the non-empty string `name`, the non-empty string `symbol`, and the finite positive number `significant`, and **MAY** contain `format`.
- **DLS-DOC-014:** A tooltip **MUST** contain exactly the non-empty human-readable strings `label` and `description` and **MAY** contain one canonical Octicon `icon`. A presenter **MUST** expose a tooltip as a keyboard-focusable help control named by `label`, associate its explanatory content with the control, and make that content available on both pointer hover and keyboard focus. `horizon`, when present, **MUST** contain exactly a non-empty human-readable `label` and one `tooltip`; the presenter **MUST** render the horizon label beside the resolved duration and append the precise resolved start, exclusive end, and duration to the tooltip's configured description.
- **DLS-DOC-015:** `callouts`, when present, **MUST** be a non-empty sequence of mappings with unique canonical `id` values and non-empty `title` and `description` strings. A callout **MAY** contain one canonical Octicon `icon`. `visible-when`, when present, **MUST** contain exactly one canonical `source`, one `field` declared by that source, and one scalar `equals` value; the callout is visible when at least one source row's field equals that value.

---

## 5. Intrinsic Semantic Model

### 5.1 Logical Sources and Grain

The `source` vocabulary is closed in version 0.1.0.

| Source | One row represents | Core fields |
|---|---|---|
| `organizations` | organization | `organization`, `organization-name`, `observed-at`, `organization-link` |
| `repositories` | repository | `organization`, `repository`, `repository-name`, `rollout-mode`, `observed-at`, `organization-link`, `repository-link` |
| `workflows` | workflow | `organization`, `repository`, optional `package` and `package-name`, `workflow`, `workflow-name`, `workflow-role`, `workflow-active`, `gh-aw-version`, `gh-aw-current-version`, `gh-aw-version-label`, `gh-aw-update-state`, complete `gh-aw-metadata` and `gh-aw-manifest` JSON payloads, `rollout-mode`, `max-ai-credits`, `package-aic-allowance`, `package-worker-count`, `package-inventory-warnings`, `inventory-ready`, `observed-at`, `organization-link`, `repository-link`, `workflow-link` |
| `runs` | run | `organization`, `repository`, `workflow`, `run`, `started-at`, `ended-at`, `run-status`, `run-conclusion`, `rollout-mode`, `engine`, `engine-version`, `requested-model`, `resolved-model`, `organization-link`, `repository-link`, `workflow-link`, `run-link` |
| `run-performance` | completed workflow run | `organization`, `repository`, `workflow`, `run`, `started-at`, `run-conclusion`, `rollout-mode`, `run-duration-seconds`, `sandbox-runtime`, `engine`, `model`, `run-link` |
| `job-performance` | workflow job | `organization`, `repository`, `workflow`, `run`, `started-at`, `run-conclusion`, `rollout-mode`, `job`, `job-status`, `job-conclusion`, `job-duration-seconds`, `runner`, `runner-name`, `runner-group`, `sandbox-runtime`, `engine`, `model`, `run-link` |
| `experiments` | experiment | `experiment`, `experiment-name`, `observed-at` |
| `experiment-assignments` | experiment assignment | scope IDs, `run`, `experiment`, `variant`, `observed-at` |
| `graders` | grader definition | `grader`, `grader-name`, `observed-at` |
| `grader-observations` | grader observation | scope IDs, `run`, `experiment`, `grader`, `value`, `status`, `rollout-mode`, `maturity-status`, `baseline-value`, `delta-from-baseline`, `evaluator-digest`, `observed-at`, `run-link` |
| `evals` | eval definition | `eval`, `eval-name`, `eval-question`, `requested-model`, `observed-at` |
| `eval-observations` | eval observation | scope IDs, `run`, `experiment`, `eval`, `eval-result`, `requested-model`, `resolved-model`, `rollout-mode`, `observed-at` |
| `usage` | model invocation | scope IDs, `run`, `invocation`, `engine`, `engine-version`, `requested-model`, `resolved-model`, `rollout-mode`, `input-tokens`, `output-tokens`, `cache-read-tokens`, `cache-write-tokens`, `reasoning-tokens`, `aic`, `estimated-usd`, `observed-at`, `organization-link`, `repository-link`, `workflow-link`, `run-link` |
| `firewall-observations` | one run-level destination decision or explicit evidence-state observation | scope IDs, `run`, `firewall-observation`, `run-conclusion`, `rollout-mode`, `observed-at`, `firewall-expected`, `firewall-enabled`, `firewall-evidence-available`, `evidence-state`, `evidence-completeness`, `evidence-freshness`, evidence and requested horizon fields, `evidence-coverage-percent`, `last-successful-collection-at`, `gh-aw-firewall-version`, policy provenance fields, `domain`, `host`, `port`, `protocol`, `decision`, `request-count`, policy-rule attribution fields, baseline and drift fields, `review-state`, `review-priority`, `run-link`, `evidence-link` |
| `firewall-policy-rules` | one effective firewall policy rule and domain pattern for one run | scope IDs, `run`, `observed-at`, `rule-id`, `rule-order`, `action`, `protocol`, `domain-pattern`, `description`, `hit-count`, `ssl-bump-enabled`, `dlp-enabled`, `host-access-enabled`, `policy-source`, `policy-manifest-identity`, `run-link`, `evidence-link` |
| `model-usage-summary` | model usage summary | `model`, `resolved-model`, `engine`, `requested-model`, `runs`, `invocations`, `total-aic`, `estimated-usd`, `pricing` |
| `engine-usage-summary` | agentic engine usage summary | `engine`, `runs`, `invocations`, `total-aic`, `estimated-usd`, `min-engine-version`, `max-engine-version`, `models` |
| `outcomes` | safe-output outcome observation | scope IDs, `package`, `runtime-repository`, `workflow-name`, `run`, `run-conclusion`, `safe-output`, `outcome-number`, `outcome-title`, `outcome-summary`, `outcome-body-html`, `outcome-category`, `outcome-status`, `outcome-state`, `evidence-strength`, `rollout-mode`, `engine`, `engine-version`, `requested-model`, `resolved-model`, `published-at`, `observed-at`, `issue-link`, `pull-request-link`, `run-link`, `external-link`, `organization-link`, `repository-link`, `workflow-link` |
| `findings` | finding | scope IDs, `run`, `finding`, `finding-severity`, `finding-status`, `finding-summary`, `observed-at`, `engine`, `engine-version`, `requested-model`, `resolved-model`, `issue-link`, `pull-request-link`, `run-link`, `external-link`, `organization-link`, `repository-link`, `workflow-link` |
| `operational-values` | value observation | scope IDs, `observation-id`, `run`, `run-attempt`, `experiment`, `operational-case`, `evaluator-digest`, `rollout-mode`, `operational-value`, `operational-value-definition`, `requested-evidence-at`, `evidence-cutoff`, `maturity-at`, `maturity-status`, `baseline-value`, `delta-from-baseline`, `accepted-evidence-provenance`, `diagnostics`, `diagnostic-definitions`, `observed-at`, `evidence-link`, `organization-link`, `repository-link`, `workflow-link`, `run-link` |
| `github-api-rate-limits` | one observation of one GitHub API quota resource at one checkpoint for one credential | `observation-id`, `operation-execution-id`, `observed-at`, `credential`, `credential-type`, `resource`, `bucket`, `maximum-lane`, `history-series`, `remaining`, `limit`, `used`, `remaining-percent`, `reset-at`, `minutes-to-reset`, `consumed-since-previous`, `burn-rate-per-minute`, `projected-remaining-at-reset`, `projected-exhaustion-at`, `runway-ratio`, `risk-status`, `risk-order`, `is-current`, `operation`, `phase`, `outcome`, `attribution-status`, `operation-consumed` |
| `github-api-collector-health` | one GitHub API telemetry collection checkpoint | `operation-execution-id`, `observed-at`, `credential`, `operation`, `phase`, `outcome`, `cache-hydrated`, `cache-bytes`, `cache-entries`, `cache-folders`, `rate-limit-error` |
| `github-api-call-stacks` | one JavaScript stack frame from one GitHub API telemetry collection checkpoint | `operation-execution-id`, `observed-at`, `credential`, `operation`, `phase`, `outcome`, `stack-frame-id`, `stack-parent-id`, `stack-depth`, `stack-frame` |

“Scope IDs” means the applicable `organization`, `repository`, and `workflow` fields. Fields that do not apply to an observation are absent rather than fabricated. Link-bearing source fields are relation-specific optional fields whose intrinsic type is one Section 9.1 link object. `organization-link`, `repository-link`, `workflow-link`, `issue-link`, `pull-request-link`, `run-link`, `evidence-link`, and `external-link` correspond to the `organization`, `repository`, `workflow`, `issue`, `pull-request`, `run`, `evidence`, and `external` link relations, respectively; a source row MUST NOT encode multiple link relations inside one field.

For `outcomes`, `repository` identifies the target repository that owns the durable safe output, while `runtime-repository` identifies the repository where the attributed workflow ran.

### 5.2 Raw Token Classes

The canonical raw-token measures are `input-tokens`, `output-tokens`, `cache-read-tokens`, `cache-write-tokens`, and `reasoning-tokens`. They remain separate because provider reporting conventions may overlap.

### 5.3 Packages, Graders, Evals, and Operational Value

A package groups one orchestrator and one or more workers that execute centrally managed operations. `max-ai-credits` is the configured per-run limit for one workflow; `package-aic-allowance` is the sum of those limits for one complete package attempt and is not actual usage. `package-inventory-warnings` is the package-level count of missing compiled orchestration and declared worker inventory. A grader applies a named grading criterion and produces a deterministic grader observation. An eval is a binary evaluation question and produces a `yes`, `no`, or `unknown` observation; it may use an AI model. Operational value is a separate absolute-attainment observation with an evidence cutoff and maturity time. These concepts are not interchangeable.

### 5.4 Normative Source Requirements

- **DLS-SEM-017:** A `metric`, `table`, or `chart` view `data.source` **MUST** name exactly one source from Section 5.1. An `element` view `data.sources` **MUST** name one or more unique sources from Section 5.1. An optional `data.route-field` **MUST** name one field from `data.source`.
- **DLS-SEM-018:** Each logical source **MUST** preserve the grain declared in Section 5.1; duplicated observations **MUST** retain distinct observation identifiers in provenance.
- **DLS-SEM-019:** A `usage` row **MUST** represent one model invocation and **MUST NOT** repeat invocation-level AIC across token-class rows.
- **DLS-SEM-020:** Grader values, eval results, AIC, each raw-token measure, outcome states, and operational value **MUST** remain separately named throughout filtering, aggregation, and presentation.
- **DLS-SEM-021:** `rollout-mode` **MUST** use `review`, `live`, or `unknown`.
- **DLS-SEM-022:** `workflow-role` **MUST** use `orchestrator`, `worker`, or `standalone`. An orchestrator or worker workflow **MUST** identify its `package`; a standalone workflow **MUST NOT** identify a package.
- **DLS-SEM-023:** `max-ai-credits` and `package-aic-allowance`, when available, **MUST** be non-negative. `package-aic-allowance` **MUST** equal the sum of the package's available configured per-run workflow limits and **MUST NOT** be presented as actual AIC usage.
- **DLS-SEM-024:** A `github-api-rate-limits` row **MUST** preserve the grain declared in Section 5.1 and **MUST NOT** contain cache or collector-health fields. `remaining-percent` **MUST** equal `remaining / limit * 100`, and `used` **MUST** equal `limit - remaining` when GitHub does not supply it.
- **DLS-SEM-025:** Rate-limit burn and forecast fields **MUST** be materialized before dashboard evaluation. Calculations **MUST** partition observations by `credential`, `resource`, and `reset-at`; they **MUST NOT** cross reset boundaries. `risk-status` **MUST** be `critical`, `warning`, `healthy`, or `unknown`, with centralized and testable thresholds. Stale, partial, unavailable, or insufficient observations **MUST NOT** be presented with a fabricated healthy forecast.
- **DLS-SEM-026:** Operation consumption attribution **MUST** use paired `before` and `after` observations with the same stable `operation-execution-id`, credential, resource, and reset window. When this evidence is absent or inconsistent, `attribution-status` **MUST** be `unavailable` and `operation-consumed` **MUST** be null.
- **DLS-SEM-027:** `github-api-collector-health` **MUST** remain distinct from GitHub quota health. A credential identifier **MUST** be a non-secret operational alias or role and **MUST NOT** contain a token or credential value.
- **DLS-SEM-028:** A `github-api-call-stacks` row **MUST** preserve one captured JavaScript frame as text, identify its checkpoint, and use `stack-frame-id` and `stack-parent-id` to preserve call order without fabricating unavailable frames.

---

## 6. Scope, Time, and Filters

### 6.1 Scope

`scope` is a mapping whose allowed keys are `organizations`, `repositories`, and `workflows`. Each value is a non-empty sequence of domain identifiers. A missing key is unbounded at that scope level.

### 6.2 Time

`time` is a mapping containing either `range` or optional `start` and `end` RFC 3339 timestamps. `range` is a positive integer followed by `h`, `d`, or `w`, such as `30d`. A relative range resolves to `[evaluated-at - range, evaluated-at)`, where the presenter exposes one RFC 3339 `evaluated-at` instant for the dashboard. Absolute `start` is inclusive and `end` is exclusive. Missing absolute bounds are unbounded. Time comparisons use instants; calendar time units use UTC.

### 6.3 Filters

`filters` maps a canonical dimension to either one scalar value or a non-empty sequence of values. Values within a sequence are alternatives; separate filter keys are conjunctive. `rollout-mode` is an ordinary dimension and follows the same rules as every other filterable dimension.

### 6.4 Context Composition

Dashboard defaults establish the initial context. A custom view's `data` context narrows that context. It cannot expand it.

- **DLS-CTX-001:** Scope constraints at different levels **MUST** be combined by intersection and **MUST** preserve organization–repository–workflow ancestry.
- **DLS-CTX-002:** `time.start` and `time.end` **MUST** be RFC 3339 timestamps, and `start` **MUST** precede `end`.
- **DLS-CTX-003:** Time filtering **MUST** include observations at `start` and exclude observations at `end`.
- **DLS-CTX-004:** A scalar filter **MUST** use equality; sequence values **MUST** use logical OR; distinct filter keys **MUST** use logical AND.
- **DLS-CTX-005:** A view context **MUST** inherit omitted dashboard defaults and **MUST** combine supplied scope, time, and filters by intersection.
- **DLS-CTX-006:** `rollout-mode` **MUST** be filterable, groupable, and displayable by the same mechanisms as other dimensions.
- **DLS-CTX-007:** Missing or `unknown` dimension values **MUST NOT** match a concrete filter value and **MUST** match the explicit value `unknown`.
- **DLS-CTX-008:** Filtering **MUST** occur before aggregation, ordering, and limiting.
- **DLS-CTX-009:** `time.range` **MUST** match `^[1-9][0-9]*(h|d|w)$` and **MUST NOT** appear with `start` or `end`.
- **DLS-CTX-010:** A presenter resolving `time.range` **MUST** expose `evaluated-at` and use it consistently for every page and view in the dashboard.

---

## 7. Dimensions, Measures, and Aggregation

### 7.1 Canonical Dimensions

Canonical dimensions include entity IDs, `package`, `workflow-role`, `variant`, `workflow-active`, `run-status`, `run-conclusion`, `outcome-state`, `rollout-mode`, `engine`, `requested-model`, `resolved-model`, operational-value definition, categorical observation results, and temporal fields.

GitHub API rate-limit dimensions additionally include `credential`, `credential-type`, `resource`, `bucket`, `maximum-lane`, `history-series`, `operation`, `phase`, `outcome`, `risk-status`, `is-current`, and `attribution-status`. `bucket` identifies one resource and credential. `maximum-lane` preserves that identity together with its quota maximum so observations with the same maximum lane receive a stable series color. `history-series` preserves the bucket identity while starting a new visual segment after an unavailable collection checkpoint so a line does not bridge a known evidence gap. None of these fields changes the observation grain.

### 7.2 Canonical Measures

| Measure | Meaning | Additivity |
|---|---|---|
| `input-tokens` | Provider-reported input tokens | Additive |
| `output-tokens` | Provider-reported output tokens | Additive |
| `cache-read-tokens` | Provider-reported cache-read tokens | Additive |
| `cache-write-tokens` | Provider-reported cache-write tokens | Additive |
| `reasoning-tokens` | Provider-reported reasoning tokens | Additive |
| `aic` | Authoritatively supplied AI Credits | Additive |
| `value` on `grader-observations` | Value emitted by a grader | Non-additive by default |
| `operational-value` | Absolute attainment under a named definition | Non-additive by default |
| `limit` | GitHub quota capacity for one resource and credential window | Non-additive |
| `used` | GitHub-reported or arithmetically derived requests used in the current window | Non-additive |
| `remaining` | Requests remaining in the current window | Non-additive |
| `remaining-percent` | Remaining capacity normalized to the resource limit | Non-additive |
| `minutes-to-reset` | Observation-relative minutes until the exact reset timestamp | Non-additive |
| `consumed-since-previous` | Requests consumed since the previous same-window observation | Non-additive |
| `burn-rate-per-minute` | Reset-safe estimated requests consumed per minute | Non-additive |
| `projected-remaining-at-reset` | Forecast remaining capacity at reset | Non-additive |
| `runway-ratio` | Estimated time to exhaustion divided by time to reset | Non-additive |
| `operation-consumed` | Reliably paired requests consumed by one operation execution | Non-additive |

Entity counts are obtained with `count` or `distinct-count`; they are not stored measures.

### 7.2.1 Units

A dashboard may declare reusable units in `dashboard.units`. A field definition selects one declared unit by setting `unit` to its identifier. The unit `name` is its human-readable name, `symbol` is the compact label appended to presented values, and `significant` is the smallest presentation increment. Presenters round a unit-bearing value to the nearest multiple of `significant`, with halfway cases rounded away from zero, without changing the value used for filtering, aggregation, or ordering. The decimal places implied by `significant` are retained. The optional `format` selects a defined presentation format and defaults to ordinary numeric formatting when omitted. For example:

```yaml
units:
  aic:
    name: AI Credits
    symbol: AIC
    significant: 1
  human-duration:
    name: Human-friendly duration
    symbol: s
    significant: 1
    format: duration
```

The AIC definition uses a significance of `1` because one AI Credit is the integral accounting unit worth one cent; AIC values are presented without a decimal fraction. The `duration` format interprets values as seconds and presents compact cascading components. It presents values below one minute as seconds (`45s`), values below one hour as minutes and seconds (`1m 30s`), values below one day as hours and minutes (`1h 23m`), and longer values as days and hours (`1d 3h`). The lower component is retained when zero, and components below the selected precision are omitted.

- **DLS-UNIT-001:** A field `unit`, when present, **MUST** reference exactly one unit declared by `dashboard.units`.
- **DLS-UNIT-002:** Unit formatting **MUST** affect presentation only and **MUST NOT** change filtering, aggregation, ordering, limiting, source data, or provenance.
- **DLS-UNIT-003:** For a unit without `format`, a presenter **MUST** append the declared `symbol` to a unit-bearing value and round it to the nearest multiple of `significant`, with halfway cases rounded away from zero.
- **DLS-UNIT-004:** `format`, when present, **MUST** be `duration`. A `duration` unit **MUST** declare `symbol: s` and `significant: 1`. A presenter **MUST** round its value to the nearest whole second with halfway cases rounded away from zero, preserve the sign, and present its absolute components using the compact cascading form defined above. Component suffixes are intrinsic to this format, so the presenter **MUST NOT** append another `symbol`.

### 7.3 Aggregates

Allowed aggregate values are `count`, `distinct-count`, `sum`, `mean`, `min`, `max`, and `none`. Omitted `aggregate` means `none`. `count` counts non-null field values. `distinct-count` counts distinct non-null values.

Allowed `time-unit` values are `hour`, `day`, `week`, and `month`. Buckets are half-open UTC intervals. Weeks begin Monday at 00:00:00Z; months begin on the first day.

Unaggregated dimensions in an encoding form the grouping key. Aggregated fields are computed once per resulting group. A metric with no unaggregated dimension computes one value over its effective context.

A field definition may also include an optional `as` property to name the aggregate output for subsequent references. This allows a view to refer to a derived metric by a stable identifier instead of inferring an implementation-specific name. When `as` is omitted, the canonical identifier is `<aggregate>-<field>`. See **DLS-AGG-009** and **DLS-AGG-010** for the normative validation rules.

An **output row** is the post-aggregation result of applying grouping and aggregation to a view's encoding. An output row is **entity-grain** when its output identifier is a canonical entity ID (for example, one row per repository or one row per run); otherwise it is **group-grain**, and its output identifier is the tuple of its remaining unaggregated output dimensions (for example `(day, run-conclusion)`), each taken after time bucketing.

The **canonical post-aggregation row order** is defined for every output grain, entity-grain or group-grain, as follows:

1. Apply each declared `order-by` clause in sequence, comparing each row's resolved output identifier value ascending or descending as declared.
2. Break any ties remaining after step 1, or order all rows when `order-by` is entirely omitted, by the view's remaining unaggregated output dimensions that are not already fully determined by step 1. Only the grouping-capable encoding channels defined in Section 11.1 (`x`, `y`, `color`, and each `columns` entry) can hold an unaggregated output dimension; `value` and `href` are excluded because they do not participate in grouping. Consider these channels in that fixed declaration order (`x`, then `y`, then `color`, then each `columns` entry in its declared sequence), each compared ascending by canonical field value after time bucketing.
3. Break any ties still remaining after step 2 by canonical entity ID ascending, when a canonical entity ID is present at the output grain; an entity-grain output row always has a canonical entity ID available for this step.

A presenter **MUST** apply `limit` only after the canonical post-aggregation row order from steps 1 through 3 is fully resolved.

### 7.4 Normative Aggregation Requirements

- **DLS-AGG-001:** An implementation **MUST** group only by dimensions and **MUST** aggregate only measures or entity identifiers compatible with the selected aggregate.
- **DLS-AGG-002:** `sum` **MUST** be accepted only for the five raw-token measures and `aic`.
- **DLS-AGG-003:** Different raw-token measures **MUST NOT** be combined into a derived total because provider reporting classes may overlap; a combined presentation **MUST** retain separate measures.
- **DLS-AGG-004:** AIC aggregation **MUST** sum only available, non-negative AIC observations, retain all contributing provenance, and **MUST NOT** substitute zero for missing AIC.
- **DLS-AGG-005:** Grader `value` and `operational-value` **MUST** use `none`, `mean`, `min`, or `max`, and aggregation **MUST** retain grader identity or operational-value definition, respectively.
- **DLS-AGG-006:** `count` and `distinct-count` **MUST** ignore absent values and **MUST NOT** substitute zero.
- **DLS-AGG-007:** A time unit **MUST** be applied before grouping and **MUST** use the UTC boundaries in Section 7.3.
- **DLS-AGG-008:** Rankings **MUST** disclose the ranked measure, direction, filters, time range, scope, and tie behavior; the ranking key **MUST** be resolved against the post-aggregation output identifier before applying `limit`, and ties **MUST** then be broken using the canonical post-aggregation row order defined above for every post-aggregation output grain, entity-grain or group-grain, not only entity-grain outputs.
- **DLS-AGG-009:** A field definition with `aggregate` other than `none` **MAY** include `as`; if omitted, the validator **MUST** derive a canonical output identifier as `<aggregate>-<field>`. A field definition with `aggregate: none` **MUST NOT** include `as`.
- **DLS-AGG-010:** A view **MUST** reject duplicate aggregate-output identifiers within the same view and **MUST** reject ambiguous or invalid `data.order-by.field` references that do not resolve to exactly one source field at the output grain or one aggregate-output identifier; such failures **MUST** use `DLS-E010`.
- **DLS-AGG-011:** If, after applying steps 1 and 2 of the canonical post-aggregation row order, one or more output rows remains tied and no canonical entity ID is available at the output grain to complete step 3, or if any remaining unaggregated output dimension used in step 2 has no canonical comparison defined by this specification for its declared or intrinsic type, a validator **MUST** reject the view with `DLS-E010` rather than leaving the presenter to invent an ordering.

### 7.5 Presenter Data-Processing Language

A presenter may compile the declarative view context and encoding into the following small row-processing language. This language is an implementation interface, not an additional dashboard-document vocabulary. Its operators are plain structured data so that a presenter can transfer source rows and an operator sequence to a Web Worker without transferring executable code.

Every request contains `data`, a sequence of row mappings, and `operators`, an ordered sequence. Processing returns a new sequence and does not mutate `data`.

| Operator | Shape | Result |
|---|---|---|
| `filter` | `predicates` and optional `search` | Retains rows matching every predicate and the optional case-insensitive search. A predicate has `field` and exactly one of `equals`, `in`, or `includes`. `search` has `fields` and `query`. |
| `summarize` | optional `by` and required `values` | Produces one row per distinct `by` tuple, or one row for the full input when `by` is omitted. Each value has `field`, `as`, and a `reducer`. |
| `arrange` | ordered `by` entries | Orders rows by each `field`; `direction` is `asc` or `desc`. |
| `slice` | `limit` and optional `offset` | Retains the requested contiguous range. |

The `summarize` reducers are `count`, `distinct-count`, `sum`, `mean`, `min`, and `max`, with the semantics in Section 7.3. An empty numeric input yields `null` for `mean`, `min`, and `max`, and zero for `sum`. Operators execute from first to last; therefore a conforming compilation places filtering before summarization, arrangement, and slicing.

```json
{
  "data": [
    { "repository": "example/api", "status": "open", "score": 0.8 }
  ],
  "operators": [
    { "op": "filter", "predicates": [{ "field": "status", "equals": "open" }] },
    {
      "op": "summarize",
      "by": ["repository"],
      "values": [{ "field": "score", "as": "mean-score", "reducer": "mean" }]
    },
    { "op": "arrange", "by": [{ "field": "mean-score", "direction": "desc" }] },
    { "op": "slice", "limit": 10 }
  ]
}
```

- **DLS-PROC-001:** A processing request **MUST** contain only structured-clone-compatible data and **MUST NOT** contain source text or executable callbacks.
- **DLS-PROC-002:** A processor **MUST** apply operators in declaration order and **MUST NOT** mutate the supplied rows.
- **DLS-PROC-003:** A processor **MUST** implement filter conjunction, alternative values, missing-value behavior, aggregation, and ordering consistently with Sections 6.3 and 7.3.
- **DLS-PROC-004:** A presenter using a worker **MUST** correlate responses with requests and **MUST NOT** apply a superseded response over a newer user interaction.

---

## 8. Provenance, Freshness, and Data States

### 8.1 Data-Set Metadata

Each logical source is accompanied by metadata outside the dashboard YAML:

| Field | Meaning |
|---|---|
| `source-id` | Stable identifier for the supplying source |
| `source-kind` | Human-readable source category |
| `as-of` | Latest observation time represented |
| `retrieved-at` | Time the data was made available to the presenter |
| `coverage-start`, `coverage-end` | Known half-open coverage interval |
| `completeness` | `complete`, `partial`, or `unknown` |
| `freshness` | `fresh`, `stale`, or `unknown` |
| `provenance-link` | Optional safe link to source evidence |

Freshness is an asserted data property. This specification does not define a cache or infer a universal staleness threshold.

### 8.2 Data States

Data quality has three independent axes:

| Axis | Values |
|---|---|
| Availability | `available`, `empty`, `unavailable` |
| Completeness | `complete`, `partial`, `unknown` |
| Freshness | `fresh`, `stale`, `unknown` |

`empty` means a valid selection returned no observations. It may be partial, stale, or unknown on the other axes. `unavailable` means no usable result exists.

### 8.3 Normative Data Requirements

- **DLS-DATA-001:** Every consumed logical source **MUST** provide `source-id`, `source-kind`, `as-of`, `retrieved-at`, `completeness`, and `freshness`.
- **DLS-DATA-002:** Provenance and freshness **MUST** remain associated with derived metrics, tables, charts, rankings, and links.
- **DLS-DATA-003:** A presenter **MUST** expose `as-of`, freshness, completeness, and source identity for every page or view. Source metadata is runtime input outside the dashboard YAML.
- **DLS-DATA-004:** An empty selection **MUST** have availability `empty`; `count` and `distinct-count` over that selection **MUST** produce zero, while other aggregates **MUST** remain absent.
- **DLS-DATA-005:** An unavailable result **MUST** identify the affected source and **MUST NOT** fabricate observations or carry forward an unmarked previous value.
- **DLS-DATA-006:** A partial result **MUST** identify known missing scope or time coverage and **MUST NOT** be labeled complete.
- **DLS-DATA-007:** A stale result **MUST** retain its original `as-of` value and **MUST** be explicitly identified as stale.
- **DLS-DATA-008:** Availability, completeness, and freshness **MUST** remain separate; `unknown` completeness or freshness **MUST** remain distinct from every known value on the same axis.

---

## 9. Links and Findings

### 9.1 Link Model

A link has `relation`, `href`, and `label`. Allowed relations are `organization`, `repository`, `workflow`, `run`, `issue`, `pull-request`, `evidence`, and `external`. When a relation-specific link field from Section 5.1 is present on a source row, it contains exactly one link object whose `relation` matches the field name.

`dashboard.github-url-base` selects the GitHub web URL base for GitHub-addressable entity links. A deployment that omits it uses `https://github.com`; an enterprise deployment sets it to its GitHub Enterprise web URL base. A presenter **MUST** resolve generated GitHub links against that base, rather than assuming GitHub.com.

A finding is an observation with a stable finding ID, summary, status, severity, observation time, provenance, applicable scope, and zero or more relation-specific link fields. Finding status uses `open`, `resolved`, `dismissed`, or `unknown`. Severity uses `critical`, `high`, `medium`, `low`, `informational`, or `unknown`.

### 9.2 Normative Link Requirements

- **DLS-LINK-001:** Every link **MUST** contain one allowed `relation`, an absolute HTTPS `href`, and a non-empty `label`.
- **DLS-LINK-002:** Links **MUST** retain the provenance and subject association from which they were derived.
- **DLS-LINK-003:** A finding or outcome **MUST** expose relation-specific links to its associated issue, pull request, or run when those associations are available.
- **DLS-LINK-004:** A finding, outcome, or operational-value observation without an available link association **MUST** remain valid and **MUST NOT** contain a fabricated link.
- **DLS-LINK-005:** A relation-specific link field, when present, **MUST** contain exactly one Section 9.1 link object and **MUST NOT** contain a sequence, mapping of multiple relations, or scalar URL.
- **DLS-LINK-006:** A presenter **MUST** render every GitHub-addressable entity exposed in the user experience as a link to that entity when its address is available. This requirement applies wherever the entity is rendered, including identifiers, names, and labels in metrics, tables, charts, rankings, filters, and detail views. A presenter **MUST NOT** fabricate a link when an entity address is unavailable.
- **DLS-LINK-007:** A presenter **MUST**, wherever sufficient GitHub identity is available, resolve and render organizations, repositories, workflows, runs, issues, and pull requests as links to their GitHub web views. It **MUST** use `dashboard.github-url-base` when configured, or `https://github.com` otherwise. A presenter **MUST NOT** infer a link when the entity identity is insufficient or ambiguous.

---

## 10. Built-in Pages

### 10.1 Syntax

```yaml
- id: runs
  kind: built-in
  page: runs
  title: Runs
  icon: play
  class-name: runs-page
```

Allowed built-in page names are:

`overview`, `organizations`, `repositories`, `packages`, `workflows`, `runs`, `experiments`, `graders`, `evals`, `usage`, `engines-models`, `operational-value`, and `findings`.

The optional page `icon` is one of `server`, `workflow`, `play`, `repo`, `package`, `issue`, `graph`, `shield`, `meter`, `beaker`, or `codescan`. It controls navigation presentation without changing page semantics and defaults to `server`.

The optional page `navigation-label` provides a concise sidebar label when the page title is more descriptive. A dashboard `navigation` section may reference a focused subset of declared pages; omitted pages remain available as deep-link destinations.

The optional page `class-name` is a canonical identifier that a renderer adds to the page container. It lets a document opt into page-specific presentation without requiring the renderer to infer styling from a page ID or built-in page name.

The presenter provides one filter bar in the view chrome for every page. Clicking the horizon text toggles its free-form filters, time-horizon controls, and rollout-mode controls. The presenter applies edits automatically to matching source fields, treating values for one field as alternatives and filters for different fields as conjunctive. Time-horizon and rollout-mode selections are global client-side settings persisted in local storage. All rollout modes are active by default.

### 10.2 Required Content

- **DLS-PAGE-001:** A built-in page **MUST** contain `id`, `kind: built-in`, and one allowed `page`; an omitted title **MUST** default to the page name with words capitalized.
- **DLS-PAGE-002:** The `overview` page **MUST** expose distinct runtime, security and controls, value and outcomes, episodes and autonomy, cost and efficiency, and evidence-quality summaries ordered by urgency. Each summary **MUST** identify its state, material observed value or unavailable prerequisite, and an investigation target, with provenance and freshness available from its declared sources.
- **DLS-PAGE-003:** The `organizations` page **MUST** expose organization inventory, repository count, workflow count, run count, available usage measures, and data state by organization.
- **DLS-PAGE-004:** The `repositories` page **MUST** expose repository inventory and rankings by run count, AIC, and available operational value without combining different operational-value definitions.
- **DLS-PAGE-005:** The `workflows` page **MUST** expose workflow inventory, active state, rollout mode, run count, run conclusions, downstream outcome counts, available usage, findings, and operational value.
- **DLS-PAGE-006:** The `runs` page **MUST** expose run status trends and counts, terminal conclusions, scope, rollout mode, engine, requested model, resolved model, time, and run links.
- **DLS-PAGE-007:** The `experiments` page **MUST** expose experiment definitions and observed run-to-variant assignments, grader observations, eval observations, outcomes, usage, and operational value without claiming causation.
- **DLS-PAGE-008:** The `graders` page **MUST** keep grader definitions and grader observations distinguishable and expose observed subject, result, score when present, time, and provenance.
- **DLS-PAGE-009:** The `evals` page **MUST** keep eval definitions and eval observations distinguishable and expose observed subject, `YES`, `NO`, or `UNKNOWN` result, evaluation model when available, time, and provenance.
- **DLS-PAGE-010:** The `usage` page **MUST** present each raw-token measure separately from AIC and expose estimated USD, engine, engine version, requested model, resolved model, scope, rollout mode, time, and provenance.
- **DLS-PAGE-011:** The `engines-models` page **MUST** expose model and agentic-engine summaries with AIC totals, estimated pricing, run counts, engine version ranges, plus run-level engine, requested model, and resolved model evidence where available.
- **DLS-PAGE-012:** The `operational-value` page **MUST** expose a time-ordered absolute-attainment series with definition, operational case, evaluator digest, subject, requested evidence time, effective evidence cutoff, maturity time and status, accepted evidence provenance, freshness, applicable experiment assignment, and separate baseline delta when available. Declared diagnostics **MUST** be presented separately as direction-aware change from each metric's first observation.
- **DLS-PAGE-013:** The `findings` page **MUST** expose finding summary, severity, status, scope, time, provenance, and available issue, pull-request, and run links.
- **DLS-PAGE-014:** Every built-in page **MUST** honor the dashboard scope, time, and filters and expose availability, completeness, and freshness independently.
- **DLS-PAGE-015:** The `packages` page **MUST** expose centrally managed package inventory, rollout-mode filtering, actual package AIC against summed per-run limits without treating missing usage as zero, the complete-attempt AIC allowance, retained usage coverage, and time-ordered successful, failed, and cancelled package-run trends.
- **DLS-PAGE-016:** When `class-name` is present, it **MUST** be a canonical identifier and a renderer **MUST** add it to the page container without deriving additional CSS class names from `id` or `page`.
- **DLS-PAGE-017:** A presenter **MUST** render one filter bar in the view chrome for every page, toggle its tuning controls from the horizon text, and apply valid filter edits automatically. A presenter **MUST** persist time-horizon and rollout-mode settings globally in local storage and activate all rollout modes by default.

---

## 11. Custom Pages

### 11.1 Syntax and View Classes

A custom page contains a non-empty `views` sequence. Each view has one `data` mapping and one mark. Data marks use an `encoding`; named UI elements use `element`. A named UI element may include a non-empty `intent` that records the operator outcome the element is designed to support. This authoring metadata is retained as a hint for future agentic mutation and is not rendered as visible or accessible content.

Any view may include the optional Boolean `locked` authoring hint. When `true`, an agent evolving the dashboard should preserve the view and modify it only to correct bugs. `locked` does not affect presentation, accessibility, data processing, or validation of the view's other fields.

A table encoding may declare `actions` to materialize an intent as a `copy-prompt` icon-and-label button in the table's leading columns. Each action has non-empty `intent`, `presentation`, `icon`, and `label` values plus a non-empty `context` sequence of unique source fields. An action may use `when` with a source field and scalar `equals` value to limit the action to rows whose field has the same scalar type and value. Activating the row action opens a modal preview containing the complete prompt and a separate copy control; opening the preview does not write to the clipboard. The prompt contains the intent followed by only the available scalar values selected by `context`, serialized as an ordered JSON object and explicitly identified as untrusted data. Link objects contribute only their HTTPS `href`. Authors do not interpolate row values into the intent, and undeclared row fields are not copied.

A custom page may also contain a non-empty `sections` sequence that groups its views for presentation. Each section contains a unique canonical `id`, optional `title` and `description`, one `layout` value of `full`, `wide`, or `narrow`, and a non-empty `views` sequence. Section view references must name every view on the page exactly once and preserve view declaration order. An omitted section title defaults from its section ID. A section may pair `count-source` with a non-empty `count-label` to expose the effective source row count in its heading.

#### 11.1.1 Route-Bound Page Templates

A custom page may declare a constrained route binding, a navigation parent, or both:

```yaml
- id: repository-detail
  kind: custom
  title: Repository
  route:
    hash-query-parameter: repository
  views:
    - id: repository-authored-workflows
      data:
        sources: [workflows]
      mark: element
      element: repository-workflows
```

The route selects the page through `#page-<page-id>?<parameter>=<value>`, with the page ID and query components percent-encoded as defined by URI syntax. For `#page-repository-detail?repository=github%2Fgh-aw`, the decoded, trimmed route value is `github/gh-aw`. A non-empty route value allocates that custom-page instance: the presenter uses it as the page title and final breadcrumb label and supplies it as an opaque route binding to route-aware named elements. A missing or empty value leaves the declared page title in place and supplies an empty binding.

This binding is constrained templating, not general string interpolation. A presenter treats the value as text, never as markup or executable content, and does not substitute it into arbitrary document fields. A named element may apply stricter domain validation before using the value for filtering or links. A route-aware named element may replace the provisional route-value title and description with human-readable text from its selected declared-source row; the presenter must apply the same text-only treatment to that allocation.

An element view may declare a compact `title-link` beside an allocated page title. Its `href-field` names one relation-specific link field and its `identifier-field` names one scalar field declared by the same selected source. When both values are present, the presenter renders the identifier as `#<identifier>` and uses the link object's HTTPS `href` as the target. Missing or invalid runtime values leave the title unlinked. This supports issue and pull request numbers as well as workflow run IDs without parsing identifiers from URLs.

`navigation-page` identifies a different declared page whose navigation item remains current while the custom page is active. The presenter uses that page as the custom page's parent breadcrumb. This supports detail and diagnostic subpages without requiring presentation components to contain navigation policy.

| Semantic view | `mark` values | Required encoding |
|---|---|---|
| Metric | `metric` | `value` |
| Table | `table` | `columns` |
| Chart | `chart` | `x`, `y` |
| Named UI element | `element` | no encoding; one `element` name |
| Callout | `callout` | no encoding or data; one `callout` mapping |

Allowed encoding channels are `value`, `columns`, `x`, `y`, `color`, `reference`, and `href`. `columns` is a non-empty sequence of field definitions; other channels contain one field definition. The `href` channel references a link-typed source field and does not select from multiple links. The quantitative `reference` channel is available only to dot charts and renders each distinct value as a horizontal reference line in the corresponding color series.

Field `type` values are `nominal`, `ordinal`, `quantitative`, and `temporal`. When omitted, type defaults to the intrinsic field type. A field title defaults to its kebab-case field name with words capitalized. A field may reference one dashboard unit through `unit`; the unit applies to metric, table, and chart value presentation. `published-at` is temporal.

Callout views declare static explanatory content rather than logical-source observations. A callout requires non-empty view `title` and `description` fields plus a `callout` mapping with a non-empty `label` and canonical Octicon `icon`; it does not declare `data` or `encoding`.

The optional table-column field `display` is `text`, `status`, `grader-status`, `mode`, `active-state`, `label`, or `digest` and defaults to `text`. It selects presentation independently from the field name. Named UI element values include `domain-attention`, `package-status-grid`, `summary-grid`, `context-summary`, `signal-list`, `package-activity`, `package-detail`, `package-reports`, `repository-workflows`, `workflow-detail`, `workflow-runtime`, `outcome-detail`, `outcome-detail-section`, `experiments-evaluation`, and `dispatch-catalog`; renderers dispatch these values without inferring behavior from page IDs, view IDs, or source contents. The overview domain-attention element keeps its six operational domains distinct, package-status-grid surfaces per-package readiness as an island of cards, and the remaining elements can be independently assembled through `views`, `sections`, and `layout`. The `experiments-evaluation` element may declare `config.body` to render the reusable `overview`, `table`, or `detail` composition slices separately or together.

A chart may set `chart` to `line`, `dot`, `bar`, `pie`, `heatmap`, `histogram`, `scatter`, or `swimlane`. When `chart` is omitted, temporal `x` has a line time-series default and any other valid chart has a bar default. Line, dot, and scatter charts use temporal `x`. Dot charts preserve exact timestamps, do not connect observations, and may encode quantitative `reference` values as horizontal lines. Scatter charts preserve exact timestamps as proportional positions on the time axis and do not connect observations. A pie chart uses nominal or ordinal `x` for categories and quantitative `y` for values. A histogram uses nominal or ordinal `x` to identify each sample and automatically bins the resulting quantitative `y` values after aggregation, ordering, and limiting. Its deterministic bin count is the smaller of the sample count and Sturges' value `ceil(log2(sample count) + 1)`; an empty sample produces no bins and an equal-valued sample produces one bin. A histogram does not use `color` or `href`. A heatmap uses nominal or ordinal `x` and `y` axes to define discrete cells and an aggregated quantitative `color` value. A heatmap is intended only for compact matrices: authors must set `data.limit` no greater than 100, and presenters must reject visual matrices larger than 100 cells or 12 categories on either axis. Every cell must expose its two category labels and formatted value as text, not color alone. A swimlane chart uses an unbucketed temporal `x` and an unaggregated nominal or ordinal `y`; its presenter may coalesce visually contiguous observations in the same labeled categorical lane into one range without connecting observations across gaps or implying quantitative distance between lanes. A chart may set Boolean `table` to control its companion data table. An omitted value hides the table for line, dot, pie, heatmap, histogram, scatter, and swimlane charts and includes it for bar charts; `true` always includes the table and `false` always omits it. These known widget types and defaults are semantic; this specification does not define visual styling.

A view may set the structural `layout` hint to `full`, `half`, or `third`. The values describe the preferred share of an available row, not fixed dimensions. Presenters **MAY** collapse every hint to `full` when space, accessibility, or output media requires it; source order remains the reading and focus order.

A table view may set `controls` to `interactive` or `static`; an omitted value defaults to `interactive`. Interactive tables may expose filtering, sorting, summaries, and progressive row disclosure. Static tables expose all rows in source order without those controls. A table may set `empty-message` to a non-empty textual description shown inside its zero-row table body.

A table view may set `tree` to a mapping containing `id-field` and `parent-field`. Both values name distinct canonical source fields. The presenter orders each parent before its children, indents the first encoded column by hierarchy depth, and exposes the result as an accessible tree grid. The caller frame in a stack is the parent of the callee frame, so outermost frames appear before deeper nested frames. Rows with an empty or unavailable parent are roots. Tree tables must use `controls: static` so filtering, sorting, summaries, and progressive row disclosure cannot separate a child from its ancestors.

### 11.2 Data Narrowing

View `data` contains `source` for `metric`, `table`, and `chart`, or a non-empty unique `sources` sequence for `element`. Callout views do not contain `data`. Every data-bearing view may also contain:

- `scope`, `time`, and `filters` as defined in Section 6;
- for `metric`, `table`, and `chart`, `limit`, a positive integer; and
- for `metric`, `table`, and `chart`, `order-by`, a non-empty sequence of mappings containing `field` and `direction`, where direction is `asc` or `desc`.

An omitted `data` inherits dashboard defaults. Omitted `limit` means no language-level limit. Omitted `order-by` uses the canonical post-aggregation row order defined in Section 7.4 starting directly from its tie-break steps: entity-grain rows order by canonical entity ID ascending, and group-grain rows order by their remaining unaggregated output dimensions, in encoding declaration order, ascending by canonical field value after time bucketing.

`data.order-by.field` resolves against the post-aggregation output grain. It **MUST** reference either:

1. a source field still valid at the output grain without aggregation; or
2. an aggregate-output identifier produced by an encoding field definition, using the explicit `as` value or the canonical `<aggregate>-<field>` output name when `as` is omitted.

If `order-by.field` matches more than one possible output, or matches a source field that is not present at the post-aggregation output grain, the validator **MUST** reject the document with `DLS-E010`. A presenter **MUST** apply the ranking using the resolved output identifier before `limit`, then apply the canonical post-aggregation row order defined in Section 7.4 (**DLS-AGG-008**, **DLS-AGG-011**) to break remaining ties, for both explicit and omitted `order-by`.

### 11.3 Progressive Disclosure

A view may set `disclosure` to `essential` or `supplemental`. An omitted value defaults to `essential`. Essential views contain the minimum information needed for the page's primary task and are visible initially. Supplemental views contain useful but non-essential detail and are initially collapsed behind a user-operated control.

A page that uses `disclosure` has an **initial information-unit count** equal to its number of effective essential views. The upper bound of four is a conservative design heuristic informed by Cowan's finding that attention-based short-term storage is limited to approximately four chunks [COWAN-2001]. A dashboard view has not been experimentally established as one memory chunk, so this bound is a guardrail rather than a claim of psychological equivalence. Authors **SHOULD** expose fewer essential views when task analysis supports doing so. Pages that do not use `disclosure` retain the version 0.1.0 presentation behavior for compatibility.

Disclosure changes presentation only. It does not change data processing, data state, provenance, links, source order, or whether required page content is available to the user.

### 11.4 Normative Custom-View Requirements

- **DLS-VIEW-001:** A custom page **MUST** contain `id`, `kind: custom`, and a non-empty `views` sequence; an omitted title **MUST** default from its page ID.
- **DLS-VIEW-002:** Every view **MUST** contain a unique `id`, a `data` mapping, and one allowed `mark`. A `metric`, `table`, or `chart` view **MUST** contain one canonical `data.source` and an `encoding` mapping. An `element` view **MUST** contain one or more unique canonical `data.sources`, one allowed `element`, and no `encoding`.
- **DLS-VIEW-003:** `metric` **MUST** encode exactly one `value` field and **MAY** encode `href`; it **MUST NOT** encode chart or table channels.
- **DLS-VIEW-004:** `table` **MUST** encode non-empty `columns` and **MAY** encode `href`; it **MUST NOT** encode `value`, `x`, `y`, or `color`.
- **DLS-VIEW-005:** `chart` **MUST** encode `x` and `y`, **MAY** encode `color` and `href`, and **MUST NOT** encode `value` or `columns`. Its optional `chart` widget **MUST** be `line`, `dot`, `bar`, `pie`, `heatmap`, `histogram`, `scatter`, or `swimlane`. Except for heatmaps and swimlanes, `y` **MUST** be quantitative. Line, dot, and scatter charts **MUST** use temporal `x`; dot and scatter charts **MUST NOT** connect observations, and scatter charts **MUST** position observations proportionally by timestamp. Dot charts **MAY** encode one unaggregated quantitative `reference` field as horizontal lines. Other chart widgets **MUST NOT** encode `reference`. Pie, heatmap, and histogram charts **MUST** use nominal or ordinal `x`. A histogram **MUST NOT** encode `color` or `href` and **MUST** automatically bin its post-processing quantitative `y` values using the deterministic rule in Section 11.1. A heatmap **MUST** use nominal or ordinal `y`, **MUST** encode an aggregated quantitative `color`, **MUST** declare `data.limit` no greater than 100, and **MUST NOT** render more than 100 cells or 12 categories on either axis. Its cells **MUST** expose both category labels and the formatted quantitative value without relying on color alone. A swimlane **MUST** use unbucketed temporal `x` and unaggregated nominal or ordinal `y`, **MUST** render each observation in exactly one labeled categorical lane, and **MUST NOT** connect observations or imply quantitative distance between lanes.
- **DLS-VIEW-006:** A `chart` with temporal `x` **MUST** use the line time-series default when its widget is omitted; any other valid `chart` **MUST** use the bar default. An optional `layout` hint **MUST** be `full`, `half`, or `third`, **MUST NOT** change source order, and **MAY** be collapsed by a presenter.
- **DLS-VIEW-007:** An encoding field **MUST** exist in the selected source and its declared type **MUST** be compatible with its intrinsic type or aggregate output type; when the field is aggregated, the effective output identifier **MUST** be the explicit `as` value or the canonical `<aggregate>-<field>` name, and duplicate identifiers within a view **MUST** be rejected. An `href` field **MUST** have intrinsic type link.
- **DLS-VIEW-008:** A field definition **MUST** contain `field` and **MAY** contain only `type`, `aggregate`, `time-unit`, `title`, `as`, `display`, and `unit` in addition; `as` is valid only when `aggregate` is not `none`. `display` is valid only on table columns and **MUST** be `text`, `status`, `grader-status`, `mode`, `active-state`, `label`, `digest`, or `outcome-link`.
- **DLS-VIEW-009:** `time-unit` **MUST** be used only with a temporal field and **MUST** use an allowed value from Section 7.3.
- **DLS-VIEW-010:** `data.limit` **MUST** be a positive integer, and `data.order-by.field` **MUST** reference either a source field valid at the post-aggregation output grain or one unique aggregate-output identifier. Ambiguous or invalid order references **MUST** be rejected with `DLS-E010`, and a group-grain output whose canonical post-aggregation row order cannot be totally resolved **MUST** be rejected with `DLS-E010` under **DLS-AGG-011**.
- **DLS-VIEW-011:** A custom view **MUST NOT** contain scripts, joins, formulas, expressions, templates, plugins, or undeclared transforms.
- **DLS-VIEW-012:** A custom view **MUST** apply defaults, filtering, aggregation, ordering, and limiting in the order defined by Sections 6, 7, and 11.2, and ordering **MUST** use the resolved output identifier before applying `limit` and then the canonical post-aggregation row order from **DLS-AGG-008**, using the same algorithm whether `order-by` is explicit or omitted. A `chart`'s series and a `table`'s rows **MUST** inherit this canonical post-aggregation row order without constraining visual styling beyond the mark defaults in **DLS-VIEW-006**.
- **DLS-VIEW-013:** Before mark-specific rendering, a custom view **MUST** determine and expose exactly one view-level availability state of `available`, `empty`, or `unavailable`, together with its source provenance, freshness, completeness, effective scope, effective time range, and effective filters. An `empty` or `unavailable` state **MUST NOT** make the view invalid or cause the presenter to omit it; its textual state output **MUST** identify the affected source or sources, effective scope, time range, and filters.
- **DLS-VIEW-014:** Under `empty`, a `metric` **MUST** render an absent aggregate value, except that `count` and `distinct-count` **MUST** render zero; a `table` **MUST** render zero rows; and a `chart` **MUST** render zero points. Under `unavailable`, a `metric` **MUST** render no numeric value and a `table` or `chart` **MUST** render no rows or points. An `element` **MUST** preserve each declared source's data state. A presenter **MUST NOT** synthesize placeholder observations, zero-valued non-count aggregates, or links for either state.
- **DLS-VIEW-015:** A presenter rendering `href` **MUST** use the referenced link object's `href` as the navigation target and **MUST** expose the link object's `label` as the accessible link label. If the referenced link field is absent for a datum, including every resulting datum, the datum and view **MUST** remain valid and **MUST** render without links.
- **DLS-VIEW-016:** `disclosure`, when present, **MUST** be exactly `essential` or `supplemental`; an omitted value **MUST** default to `essential`.
- **DLS-VIEW-017:** A page containing one or more views with `disclosure` **MUST** have at least one and no more than four effective essential views. Declarative built-in view definitions and custom page views use the same count. Section references **MUST NOT** be counted as additional views.
- **DLS-VIEW-018:** On initial presentation, a presenter **MUST** expose essential views and **MUST** collapse supplemental views behind user-operated disclosure controls. User-directed expansion **MAY** expose more than four views.
- **DLS-VIEW-019:** Supplemental views **MUST** remain discoverable and operable and **MUST NOT** be silently omitted. Disclosure controls and views **MUST** preserve document source order in reading and focus order.
- **DLS-VIEW-020:** A disclosure control **MUST** expose the controlled view's accessible name and expanded state. Collapsed content **MUST** be excluded from sequential focus navigation and the accessibility tree.
- **DLS-VIEW-021:** Disclosure state **MUST NOT** alter filtering, aggregation, ordering, limiting, provenance, freshness, completeness, availability, links, required built-in content, or semantic output.
- **DLS-VIEW-022:** An `element` mark **MUST** name exactly one supported UI element and **MUST** render only from its declared `data.sources`. A presenter **MUST NOT** select an element from page IDs, view IDs, source names, or source contents.
- **DLS-VIEW-023:** A presenter **MUST** select a field's `status`, `grader-status`, `mode`, `active-state`, `label`, `digest`, or `outcome-link` treatment only from its `display` value and **MUST NOT** infer that treatment from the field name. A presenter **MUST** visually constrain `outcome-link` output evidence to one line with an ellipsis at every supported viewport size while preserving the complete text for accessible technologies.
- **DLS-VIEW-024:** A custom page `sections` sequence, when present, **MUST** be non-empty. Every section **MUST** have a unique canonical `id`, one `layout` value of `full`, `wide`, or `narrow`, and a non-empty `views` sequence. Sections **MUST** reference every page view exactly once and preserve view declaration order; an omitted section title **MUST** default from its section ID. `count-source` and non-empty `count-label`, when used, **MUST** appear together and expose that source's effective row count without changing view data.
- **DLS-VIEW-025:** A presenter **MUST** apply a field's referenced unit consistently to metric values, table cells, chart value labels, chart data tables, and accessible chart labels.
- **DLS-VIEW-026:** A custom page `route`, when present, **MUST** be a mapping containing `hash-query-parameter`, `navigation-page`, or both. Each present value **MUST** be a canonical identifier. `navigation-page` **MUST** reference a different declared dashboard page. Built-in pages **MUST NOT** declare `route`.
- **DLS-VIEW-027:** A presenter **MUST** resolve a custom page route from `#page-<page-id>?<parameter>=<value>`. It **MUST** use a non-empty decoded, trimmed route value as the provisional page title and final breadcrumb label and supply it as an opaque binding to route-aware named elements; a missing or empty value **MUST** preserve the declared title and supply an empty binding. When `navigation-page` is present, the presenter **MUST** expose that page as the current navigation item and parent breadcrumb. A route-aware named element **MAY** replace that provisional title and description with human-readable text from its selected declared-source row. Route and allocated values **MUST** be treated only as text and **MUST NOT** be interpreted as markup, code, a URI, or a general-purpose content template.
- **DLS-VIEW-028:** Table `controls`, when present, **MUST** be `interactive` or `static`; an omitted value **MUST** default to `interactive`. A static table **MUST** expose every effective row without filter, sort, summary, pagination, or nested-scroll controls. `column-summaries`, when present, **MUST** be Boolean and controls whether an interactive table renders its column-summary row; an omitted value **MUST** default to `true`. A temporal column summary **MUST** expose the earliest valid timestamp as Start, the latest valid timestamp as Stop, and their elapsed Duration instead of treating timestamps as categorical values. `empty-message`, when present, **MUST** be non-empty text and **MUST** appear only inside a zero-row table body.
- **DLS-VIEW-029:** A table action **MUST** use `copy-prompt` presentation, a canonical icon, non-empty intent and label, and a non-empty sequence of unique `context` fields declared by the table source. A conditional action field **MUST** be declared by the table source, and `equals` **MUST** match a row field only when both scalar type and value are equal. A presenter **MUST** open a keyboard-operable modal preview containing the complete prompt and a separate copy control, **MUST NOT** write to the clipboard when opening the preview, and **MUST** return focus to the row action when the preview closes. The prompt **MUST** contain the intent followed by only the available scalar values selected by `context`, preserve declared context order in JSON serialization, identify the JSON as untrusted data, reduce a selected link object to its HTTPS `href`, and exclude every undeclared or non-scalar row value. It **MUST NOT** require author-defined interpolation and **MUST** announce whether the explicit clipboard operation succeeded or failed.
- **DLS-VIEW-030:** A `metric`, `table`, or `chart` on a routed custom page **MAY** declare `data.route-field`. The field **MUST** exist in `data.source`. The presenter **MUST** retain only rows whose field value exactly matches the decoded route value, using case-insensitive text comparison, before the processing order in Section 11.2. A missing route value **MUST** produce an empty effective row set. `element` views **MUST NOT** declare `data.route-field`.
- **DLS-VIEW-031:** An `element` view **MAY** declare `title-link` with exactly one `href-field` and one `identifier-field` declared by the same selected source. `href-field` **MUST** name a relation-specific link field and `identifier-field` **MUST** name a scalar field. When a route-aware element allocates a title with both runtime values present, the presenter **MUST** render a sibling link labeled `#<identifier>` using the link object's safe HTTPS target; absent or invalid values **MUST** leave the title-link hidden. Other marks **MUST NOT** declare `title-link`.
- **DLS-VIEW-032:** A `chart` view **MAY** declare Boolean `table`; `true` **MUST** include the companion data table and `false` **MUST** omit it. When `table` is omitted, line, dot, pie, heatmap, histogram, scatter, and swimlane charts **MUST** omit the table and bar charts **MUST** include it. Other marks **MUST NOT** declare `table`.
- **DLS-VIEW-033:** A swimlane presenter **MUST** expose persistent text labels for every lane and readable time labels on its primary axis. Each isolated observation or contiguous observation range **MUST** be focusable and have an accessible name containing its category, observation count, and exact timestamp or timestamp range. It **MUST NOT** rely on color alone.
- **DLS-VIEW-034:** An `element` view **MAY** declare a non-empty `intent` describing the operator outcome it is designed to support. Other marks **MUST NOT** declare `intent`. A presenter **MUST** treat `intent` as inert authoring metadata and **MUST NOT** render it as visible or accessible content.
- **DLS-VIEW-035:** `locked`, when present, **MUST** be Boolean. When `true`, an agent evolving the dashboard **SHOULD NOT** modify the view except to correct bugs. A presenter **MUST** treat `locked` as inert authoring metadata and **MUST NOT** let it alter presentation, accessibility, data processing, or other view semantics.
- **DLS-VIEW-036:** A `table` view **MAY** declare `tree` with distinct canonical `id-field` and `parent-field` values declared by its selected source. A tree table **MUST** use `controls: static`. Its presenter **MUST** order every available parent before its children, expose hierarchy depth in an accessible tree grid, and indent the first encoded column by depth. A row with an empty or unavailable parent **MUST** be treated as a root; a cycle **MUST NOT** prevent any row from rendering.
- **DLS-VIEW-037:** A presenter **MAY** cluster a dense scatter chart before rendering, provided clustering preserves every color series when the rendered-point budget permits and caps rendered points at a documented implementation limit. Clustering **MUST** run outside the main browser thread when workers are available. While clustering is pending, the chart **MUST** expose visible progress with `status` semantics; each rendered cluster **MUST** expose its observation count in its accessible name.

---

## 12. Validation and Errors

Validation proceeds conceptually through YAML syntax, document count, structural vocabulary, references and types, semantic compatibility, and safety constraints. This order does not prescribe implementation architecture.

- **DLS-VAL-001:** A validator **MUST** report every detected error with an error code, a human-readable message, and a location identifying the nearest YAML path.
- **DLS-VAL-002:** A validator **MUST** reject a document when any Level 1 structural requirement fails.
- **DLS-VAL-003:** A Level 2 or Level 3 validator **MUST** reject incompatible source fields, filters, aggregates, encodings, links, or data relationships. A validator **MUST** reject an `href` reference to a non-link field or an ambiguous multi-link field with link-specific error code `DLS-E009`, and **MUST** reject ambiguous or invalid aggregate-order references with `DLS-E010`. A valid custom view **MUST NOT** be rejected merely because its runtime result is `empty` or `unavailable`; `DLS-E012` applies only when required external source metadata needed to determine those states is missing.
- **DLS-VAL-004:** Error reporting **MUST NOT** expose credentials, secret values, or sensitive source payloads.
- **DLS-VAL-005:** A validator **MUST** reject a page that uses `disclosure` and has zero or more than four effective essential views using `DLS-E013`.

Error codes are listed in Appendix B.

---

## 13. Security, Privacy, and Accessibility

### 13.1 Security

Dashboard documents are declarative data, not executable programs. Untrusted YAML, labels, links, and provenance values may be attacker-controlled.

### 13.2 Privacy

Run, finding, grader, eval, usage, and provenance data may identify people, repositories, or confidential work. Data minimization and access control occur outside this language, but presentations need to preserve data-quality and provenance truthfully.

### 13.3 Accessibility

Accessible semantics apply independently of visual renderer choice. Each view has a title, table fields have labels, links have labels, and data states have text equivalents.

### 13.4 Cognitive-Load Evaluation

The four-view limit is a deterministic authoring bound. Teams should also evaluate representative page tasks with representative users because view complexity, prior knowledge, accessibility needs, and task pressure are not captured by element counts.

The **Single Ease Question** (SEQ) is a seven-point post-task difficulty rating [SEQ]. As an initial investigation bound, teams **SHOULD** target a mean SEQ of at least 5.5, the published cross-study benchmark, and inspect task completion, errors, time, and the score's uncertainty rather than treating the mean alone as proof of usability.

The **NASA Task Load Index** (NASA-TLX) measures mental, physical, and temporal demand, performance, effort, and frustration on 0–100 scales [NASA-TLX]. Its authors did not establish a universal pass/fail score. Teams **SHOULD** preregister a task- and population-specific baseline and smallest effect of interest, report all six subscales and uncertainty intervals, and investigate a page when the confidence interval for its paired workload increase exceeds that bound. Weighted and unweighted scoring **MUST NOT** be combined without identification.

Research should compare one through four essential views, record disclosure use, and include keyboard and assistive-technology tasks. The evidence supports using four as a ceiling, not as a target.

### 13.5 Normative Safety Requirements

- **DLS-SAFE-001:** A parser **MUST** use YAML safe-loading behavior and **MUST** reject custom tags, aliases, and cyclic structures.
- **DLS-SAFE-002:** A processor **MUST NOT** execute document content or interpret any field as code, a template, a command, or a network-fetch instruction.
- **DLS-SAFE-003:** Human-readable document and data strings **MUST** be treated as text and **MUST NOT** be interpreted as markup without context-appropriate sanitization.
- **DLS-SAFE-004:** Link handling **MUST** reject credentials in URIs and every scheme other than `https`.
- **DLS-SAFE-005:** Documents and provenance **MUST NOT** contain authentication credentials, secret tokens, or private keys.
- **DLS-SAFE-006:** A presenter **MUST** expose only observations and links permitted by the consuming context and **MUST NOT** imply that language validity grants data access.
- **DLS-SAFE-007:** Every page and view **MUST** have a non-empty accessible name, using its title or title default.
- **DLS-SAFE-008:** Metrics, charts, and time series **MUST** expose a textual value or tabular equivalent, and tables **MUST** expose labeled columns.
- **DLS-SAFE-009:** Color **MUST NOT** be the only means of communicating a category, status, outcome, freshness, completeness, or severity.
- **DLS-SAFE-010:** Every availability, completeness, and freshness value **MUST** have a distinct textual label, and each link **MUST** expose its non-empty label.
- **DLS-SAFE-011:** A presenter's report action toolbar **MUST** expose a descriptive accessible name or description for its refresh control identifying what the control does, and **MUST** expose a non-empty accessible label for its GitHub repository link when `dashboard.repository` is present.
- **DLS-SAFE-012:** A presenter that renders `outcome-body-html` **MUST** rebuild it through a context-appropriate element and attribute allowlist, discard executable or embedded content, and apply **DLS-SAFE-004** to retained links and images.
- **DLS-SAFE-013:** A presenter **MUST** render user-controlled list content as sanitized, inert text and **MUST** systematically constrain list item titles with visual ellipsis at every supported viewport size while preserving the complete text for accessible technologies.
- **DLS-SAFE-014:** A presenter **MUST** expose every visible site-wide callout independently of the active page with its title and description as text and a descriptively named dismiss control. Dismissal **MUST** last for the lifetime of the loaded document and **MUST NOT** be persisted across document loads.
- **DLS-SAFE-015:** A presenter **MUST** treat table-action context as untrusted data, serialize it without interpretation, and keep it explicitly separated from the author-declared intent. Table actions **MUST NOT** execute document or row content.

---

## 14. Compliance Testing

### 14.1 Test Suite Requirements

A compliance suite uses valid and invalid YAML fixtures, logical data fixtures with explicit source metadata, and deterministic expected semantic outputs. Tests do not require a particular renderer.

- **DLS-TEST-001:** A conformance test suite **MUST** exercise every normative requirement applicable to the claimed class and level.
- **DLS-TEST-002:** Each test result **MUST** record test ID, requirement ID, implementation version, pass or fail status, and failure evidence.
- **DLS-TEST-003:** Tests involving time **MUST** include exact start and end boundaries; tests involving missing data **MUST** distinguish absent, zero, empty, unavailable, partial, stale, and unknown.

### 14.2 Compliance Checklist

In the table, “accept” means validation succeeds; “reject” means validation fails with an applicable error; “expose” means the semantic output contains the listed information.

| Requirement | Test ID | Level | Procedure and expected outcome |
|---|---|---:|---|
| DLS-CONF-001–005 | T-CONF-001 | 1–3 | Inspect full and partial claims; verify labels, coverage, results, and enumerated gaps. |
| DLS-DOC-001–015 | T-DOC-001 | 1 | Apply positive and negative syntax, root, version, identity, vocabulary, GitHub URL base, callouts, defaults, page-shape, and scalar-type fixtures. |
| DLS-SEM-001–007 | T-SEM-001 | 2 | Validate entity ancestry, active state, run status, run conclusion, and explicit experiment assignments. |
| DLS-SEM-008–016 | T-SEM-002 | 2 | Distinguish grader, eval, tokens, AIC, run conclusions, outcomes, engine/models, and value; reject causal labeling. |
| DLS-SEM-017–027 | T-SEM-003 | 2 | Validate source vocabulary, grain, token classes, rollout modes, package workflow roles and membership, per-run package allowances, distinct measure names, reset-safe rate-limit forecasting, credential isolation, correlated attribution, and collector separation. |
| DLS-CTX-001–008 | T-CTX-001 | 2 | Exercise ancestry, boundary times, Boolean filter rules, inheritance, rollout mode, unknown, and operation order. |
| DLS-AGG-001–011 | T-AGG-001 | 2 | Exercise allowed aggregates, compatibility, nulls, UTC buckets, ranking disclosure, and deterministic ties for entity-grain and group-grain outputs, including total-order rejection. |
| DLS-DATA-001–008 | T-DATA-001 | 2 | Exercise required metadata, derivation traceability, and each distinct data state. |
| DLS-LINK-001–007 | T-LINK-001 | 2 | Validate link shape, safety, provenance, available associations, absent associations, one-link-per-field cardinality, GitHub URL base resolution, and linked rendering of every GitHub-addressable entity. |
| DLS-PAGE-001–017 | T-PAGE-001 | 3 | Evaluate each built-in fixture for required content, defaults, context, data states, page classes, and shared filter chrome. |
| DLS-VIEW-001–006 | T-VIEW-001 | 3 | Validate custom structure and every allowed mark/channel combination. |
| DLS-VIEW-007–015, DLS-VIEW-025, DLS-UNIT-001–004 | T-VIEW-002 | 3 | Validate fields, types, link-compatible `href`, units and compact duration formatting, time units, ordering, exclusions, operation order, exposed context, and link labels. |
| DLS-VIEW-016–021 | T-VIEW-003 | 3 | Validate disclosure vocabulary, one-to-four essential views, initial collapsed state, accessible controls, source order, and unchanged semantic output. |
| DLS-VIEW-022–024, DLS-VIEW-026–037 | T-VIEW-004 | 3 | Validate named element dispatch, explicit field display treatments, complete ordered custom-page section layouts, route allocation, title links, optional chart data tables, tree-table hierarchy, swimlane accessibility, bounded scatter clustering progress, and inert element intent and view-lock hints. |
| DLS-VAL-001–005 | T-VAL-001 | 1–3 | Verify rejection, coded path-specific errors, semantic checks, progressive-disclosure bounds, and secret redaction. |
| DLS-SAFE-001–006, DLS-SAFE-012, DLS-SAFE-015 | T-SAFE-001 | 3 | Exercise safe YAML, inert content, outcome-HTML allowlisting, prompt-context serialization, HTTPS links, secrets, and authorization boundaries. |
| DLS-SAFE-007–010 | T-SAFE-002 | 3 | Inspect names, textual alternatives, labels, and non-color semantics. |
| DLS-SAFE-011 | T-SAFE-003 | 3 | Inspect the report action toolbar's refresh control description and GitHub repository link label. |
| DLS-SAFE-014 | T-SAFE-004 | 3 | Inspect site-wide placement, text treatment, accessible dismissal, volatile dismissal state, and row-equality visibility. |
| DLS-TEST-001–003 | T-TEST-001 | 1–3 | Inspect coverage, result metadata, time boundaries, and missing-data distinctions. |


### 14.3 Custom Link Fixture Requirements

A Level 3 compliance suite MUST include at least one positive and one negative custom-view fixture for `href` link rendering and validation. The positive fixture MUST include a custom view whose `href.field` references a relation-specific link field and logical data containing one row where that field is present and one row where it is absent. The expected semantic output MUST use the present link object's `href` as the navigation target, expose its `label` as the accessible link label, and leave the absent-link row unlinked.

```yaml
language-version: "0.1.0"
dashboard:
  id: findings-links
  title: Findings Links
  pages:
    - id: findings-table
      kind: custom
      title: Findings with Pull Requests
      views:
        - id: open-findings
          data:
            source: findings
            filters:
              finding-status: open
          mark: table
          encoding:
            columns:
              - field: finding-summary
              - field: finding-severity
            href:
              field: pull-request-link
```

The negative fixture MUST include a custom view whose `href.field` references a field that is not link-typed, such as `finding-summary`, or an implementation extension field that contains multiple links. The expected validation result MUST reject the document with `DLS-E009`.

```yaml
language-version: "0.1.0"
dashboard:
  id: invalid-finding-links
  title: Invalid Finding Links
  pages:
    - id: findings-table
      kind: custom
      views:
        - id: invalid-href
          data:
            source: findings
          mark: table
          encoding:
            columns:
              - field: finding-summary
            href:
              field: finding-summary
```

### 14.4 Grouped Ordering Fixture Requirements

A Level 2 or Level 3 compliance suite MUST include at least one time-bucketed grouped chart fixture and one grouped table fixture that demonstrate the canonical post-aggregation row order from Section 7.4.

The grouped chart fixture MUST group `runs` by day and `run-conclusion`, order explicitly by the temporal dimension ascending, and use logical data containing more than one `run-conclusion` value on at least one shared day. The expected semantic output MUST break the same-day tie using the remaining unaggregated output dimension `run-conclusion`, taken from the `color` encoding, ordered ascending by canonical field value, independent of source row iteration order.

```yaml
language-version: "0.1.0"
dashboard:
  id: run-conclusions
  title: Run Conclusions
  pages:
    - id: run-health
      kind: custom
      views:
        - id: run-conclusions-by-day
          data:
            source: runs
            order-by:
              - field: started-at
                direction: asc
          mark: chart
          encoding:
            x:
              field: started-at
              type: temporal
              time-unit: day
            y:
              field: run
              type: quantitative
              aggregate: count
            color:
              field: run-conclusion
              type: nominal
```

The grouped table fixture MUST group `usage` by `resolved-model`, order by summed `aic` descending with `limit` applied, and use logical data containing rows whose summed `aic` ties across more than one `resolved-model`. The expected semantic output MUST apply `limit` only after resolving ties among equally ranked models by `resolved-model` ascending, so the retained rows are reproducible independent of renderer iteration order.

```yaml
language-version: "0.1.0"
dashboard:
  id: model-usage
  title: Model Usage
  pages:
    - id: usage-ranking
      kind: custom
      views:
        - id: top-models-by-aic
          data:
            source: usage
            order-by:
              - field: sum-aic
                direction: desc
            limit: 10
          mark: table
          encoding:
            columns:
              - field: resolved-model
              - field: aic
                aggregate: sum
                as: sum-aic
```

### 14.5 Recommended Execution Procedure

1. Validate positive and negative YAML fixtures.
2. Validate semantic fixtures and relationships.
3. Evaluate context and aggregation fixtures.
4. Inspect provenance, freshness, links, and data states.
5. Evaluate every built-in page and custom mark.
6. Inspect security, privacy, and accessibility semantics.
7. Publish the conformance claim and machine-readable test results.

---

## 15. References

### 15.1 Normative References

- **[RFC 2119]** Bradner, S. *Key words for use in RFCs to Indicate Requirement Levels*. RFC 2119. <https://www.ietf.org/rfc/rfc2119.txt>
- **[RFC 3339]** Klyne, G.; Newman, C. *Date and Time on the Internet: Timestamps*. RFC 3339. <https://www.rfc-editor.org/rfc/rfc3339>
- **[RFC 3986]** Berners-Lee, T.; Fielding, R.; Masinter, L. *Uniform Resource Identifier (URI): Generic Syntax*. RFC 3986. <https://www.rfc-editor.org/rfc/rfc3986>
- **[YAML 1.2.2]** *YAML Ain't Markup Language, Version 1.2.2*. <https://yaml.org/spec/1.2.2/>
- **[AIC]** [AI Credits Specification](/gh-aw/specs/ai-credits-specification/)
- **[GRADERS]** [Graders Specification](/gh-aw/specs/graders-specification/)

### 15.2 Informative References

- **[SEMVER]** *Semantic Versioning 2.0.0*. <https://semver.org/>
- **[VEGA-LITE]** *Vega-Lite: A Grammar of Interactive Graphics*. <https://vega.github.io/vega-lite/>
- **[WCAG 2.2]** *Web Content Accessibility Guidelines (WCAG) 2.2*. W3C Recommendation. <https://www.w3.org/TR/WCAG22/>
- **[EXPERIMENTS]** [A/B Experiments Specification](/gh-aw/experimental/experiments-specification/)
- **[OUTCOMES]** [Outcomes](/gh-aw/reference/outcomes/)
- **[COWAN-2001]** Cowan, N. *The Magical Number 4 in Short-Term Memory: A Reconsideration of Mental Storage Capacity*. Behavioral and Brain Sciences 24(1), 87–114. <https://doi.org/10.1017/S0140525X01003922>
- **[SEQ]** Sauro, J.; Dumas, J. S. *Comparison of Three One-Question, Post-Task Usability Questionnaires*. CHI 2009. <https://doi.org/10.1145/1518701.1518946>
- **[NASA-TLX]** Hart, S. G.; Staveland, L. E. *Development of NASA-TLX (Task Load Index): Results of Empirical and Theoretical Research*. Human Mental Workload, 139–183. <https://doi.org/10.1016/S0166-4115(08)62386-9>

---

## 16. Change Log

### Version 0.1.0 (Working Draft)

- Initial Dashboard Language specification.
- Defined intrinsic entities, observations, dimensions, measures, and relationships.
- Defined built-in pages and constrained custom views.
- Added provenance, freshness, data states, links, safety requirements, and compliance tests.
- Defined the canonical post-aggregation row order for entity-grain and group-grain output rows, revised **DLS-AGG-008** and added **DLS-AGG-011**, aligned omitted and explicit `order-by` semantics in Section 11.2, updated **DLS-VIEW-010** and **DLS-VIEW-012**, and added grouped chart and grouped table compliance fixtures in Section 14.4.
- Required presenters to render every GitHub-addressable entity as a link when its address is available.
- Added `dashboard.github-url-base` so generated GitHub entity links default to GitHub.com and can target GitHub Enterprise deployments.
- Added essential and supplemental view disclosure, a four-essential-view authoring bound, accessible presentation requirements, and SEQ and NASA-TLX user-research guidance.
- Added centrally managed package semantics and the `packages` built-in page for mode-filtered package AIC utilization and package-run trends.
- Added `dashboard.repository` and **DLS-DOC-012** so a presenter's report action toolbar can expose a GitHub repository link, and added **DLS-SAFE-011** requiring a descriptive refresh control and a labeled repository link.
- Added the `github-api-rate-limits`, `github-api-collector-health`, and `github-api-call-stacks` logical sources, reset-safe derived measures, correlated operation attribution, call-site evidence, risk semantics, and strict separation of GitHub quota state from collector/cache health.
- Added constrained custom-page hash-query routing and route-bound templating through **DLS-VIEW-026** and **DLS-VIEW-027**.
- Added route-aware human-readable title allocation and allowlisted `outcome-body-html` presentation through **DLS-SAFE-012**.
- Added dashboard-level site-wide callouts, optional source-row visibility conditions, and volatile accessible dismissal through **DLS-DOC-015** and **DLS-SAFE-014**.
- Updated the complete example to declare repository AIC distribution as a linked, ordered pie chart.
- Added the optional unit `format` and deterministic compact `duration` presentation for human-friendly elapsed times.

---

## Appendices

### Appendix A: Complete Example (Informative)

```yaml
language-version: "0.1.0"
dashboard:
  id: agentic-operations
  title: Agentic Operations
  description: Workflow activity, usage, findings, and operational value.
  github-url-base: https://github.com
  repository: octo-org/agentic-operations
  defaults:
    scope:
      organizations:
        - octo-org
    time:
      range: 30d
    filters:
      rollout-mode:
        - review
        - live
  units:
    aic:
      name: AI Credits
      symbol: AIC
      significant: 1
  pages:
    - id: overview
      kind: built-in
      page: overview
    - id: workflows
      kind: built-in
      page: workflows
    - id: usage-by-repository
      kind: custom
      title: Usage by Repository
      views:
        - id: total-aic
          title: Total AI Credits
          data:
            source: usage
          mark: metric
          encoding:
            value:
              field: aic
              type: quantitative
              aggregate: sum
              unit: aic
        - id: daily-runs
          title: Daily Runs
          data:
            source: runs
          mark: chart
          encoding:
            x:
              field: started-at
              type: temporal
              time-unit: day
            y:
              field: run
              type: quantitative
              aggregate: count
            color:
              field: rollout-mode
              type: nominal
        - id: largest-spenders
          title: Largest AIC Spenders
          data:
            source: usage
            order-by:
              - field: sum-aic
                direction: desc
          mark: chart
          chart: pie
          encoding:
            x:
              field: repository
              type: nominal
            y:
              field: aic
              type: quantitative
              aggregate: sum
              as: sum-aic
            href:
              field: repository-link
```

### Appendix B: Error Codes (Normative)

| Code | Meaning |
|---|---|
| `DLS-E001` | Invalid YAML syntax |
| `DLS-E002` | Invalid YAML document count or root |
| `DLS-E003` | Missing or invalid required field |
| `DLS-E004` | Unknown or duplicate key |
| `DLS-E005` | Non-canonical vocabulary or identifier |
| `DLS-E006` | Unknown source, field, or reference |
| `DLS-E007` | Incompatible mark, channel, type, or time unit |
| `DLS-E008` | Forbidden executable or transformation feature |
| `DLS-E009` | Unsafe, invalid, ambiguous, or incompatible link or `href` reference |
| `DLS-E010` | Invalid scope, filter, time range, aggregation, or aggregate-order reference |
| `DLS-E011` | Invalid entity relationship or source grain |
| `DLS-E012` | Missing required external provenance or data-state metadata; not an `empty` or `unavailable` runtime result |
| `DLS-E013` | Invalid progressive-disclosure configuration or essential-view count |

### Appendix C: Invalid Examples (Informative)

#### C.1 Multiple YAML Documents

```yaml
language-version: "0.1.0"
dashboard: {}
---
language-version: "0.1.0"
dashboard: {}
```

Invalid because a file contains more than one YAML document.

#### C.2 Non-Canonical ID

```yaml
language-version: "0.1.0"
dashboard:
  id: Agentic_Operations
  title: Agentic Operations
  pages: []
```

Invalid because the ID is not kebab-case and `pages` is empty.

#### C.3 Forbidden Join and Expression

```yaml
- id: combined-usage
  kind: custom
  views:
    - id: calculated-cost
      data:
        source: usage
      join: runs
      mark: metric
      encoding:
        value:
          expression: raw-token-count * rate
```

Invalid because `join` and `expression` are not language vocabulary and arbitrary joins and expressions are excluded.

#### C.4 Incompatible Measure

```yaml
- id: summed-value
  kind: custom
  views:
    - id: value-total
      data:
        source: operational-values
      mark: metric
      encoding:
        value:
          field: operational-value
          aggregate: sum
```

Invalid because operational value is non-additive and cannot use `sum`.

### Appendix D: Semantic Distinctions (Informative)

| Concept | Example question answered | Not equivalent to |
|---|---|---|
| Raw tokens | How many provider-reported input tokens were observed? | AIC, cost, outcome, or value |
| AIC | How many authoritative AI Credits were attributed? | Raw tokens or operational value |
| Run conclusion | Did the completed run succeed, fail, time out, or end another way? | Downstream outcome, grader result, or eval result |
| Outcome | Was a safe output later accepted, rejected, pending, ignored, or otherwise classified? | Run conclusion or operational value |
| Grader observation | What result did a named grading criterion emit? | Eval observation or run conclusion |
| Eval observation | Did a named binary evaluation return `yes`, `no`, or `unknown`? | Grader observation or operational value |
| Operational value | What absolute attainment was observed under a named definition and evidence cutoff? | AIC, outcome, or causal impact |

---
