---
title: Central Agentic Ops Activity Specification
description: Normative collection, snapshot, data-quality, authority, and consumer requirements for CAO Activity.
version: 1.0.0
status: Working Draft
editors:
  - GitHub Next
---

# Central Agentic Ops Activity Specification

**Version:** 1.0.0
**Status:** Working Draft
**Latest Version:** https://github.com/githubnext/gh-aw-cao/blob/main/specs/activity.md
**Editors:** GitHub Next

## Abstract

This specification defines CAO Activity as the shared collection boundary for
Central Agentic Ops. It defines Activity's authority, required inputs and
outputs, immutable snapshot identity, data-quality semantics, fallback
behavior, and consumer obligations. It does not define dashboard presentation,
workflow rollout policy, or durable operational outcomes.

## 1. Status and conformance

This document is a Working Draft and may be updated, replaced, or made
obsolete. Sections 2 through 8 are normative. This introduction, examples, and
explicitly identified notes are informative.

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD",
"SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" are to
be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

An Activity publisher conforms when it satisfies Sections 2 through 7. An
Activity consumer conforms when it satisfies Section 8.

## 2. Role and authority

CAO Activity is deterministic collection infrastructure. It MUST collect and
normalize bounded operational evidence into one reusable point-in-time
snapshot.

Activity:

- MUST NOT select rollout targets or determine rollout mode;
- MUST NOT act as an orchestrator, worker, or agent;
- MUST NOT write to target repositories;
- MUST NOT treat workflow execution as proof of progress, outcome, or value;
- MUST preserve the distinction between observed evidence, derived records,
  and unavailable or incomplete evidence.

The control policy remains the authority for rollout and repository scope.
Activity MAY record resolved policy and inventory as evidence, but that record
does not grant authority.

## 3. Collection boundary

An Activity refresh MUST create a coherent snapshot from the inputs available
to the same workflow run. Inputs MAY include:

- installed workflow sources and compiled metadata;
- resolved control policy and package inventory;
- bounded GitHub Actions run metadata;
- `gh aw` logs, audits, and declared telemetry artifacts; and
- records retained from a compatible prior Activity snapshot.

The publisher MUST bound remote acquisition by repository scope, evidence
window, pagination, or another explicit limit. It MUST NOT discover workflows
in target repositories merely because those repositories appear in rollout
policy. Installed workflow discovery is bounded to the checked-out control
repository.

The Activity indexer MUST operate from checked-out metadata and the collected
snapshot. It MUST NOT silently start an independent, unbounded history scan to
fill missing fields.

## 4. Snapshot contract

The scheduled and manually dispatchable Activity workflow is the only
publisher of the shared Activity cache. Each published snapshot MUST use an
immutable identity derived from the publisher's workflow run ID and run
attempt. A consumer that dispatches Activity MUST restore the exact snapshot
for the completed run and attempt rather than an unspecified latest snapshot.

The snapshot MUST identify when it was generated and the repository scope and
evidence window it represents. It MUST include collection-state metadata that
allows consumers to determine availability and completeness without inferring
either from row counts.

The concrete files and schemas are defined by
[`activity/README.md`](../activity/README.md). Changing or removing a required
file, field, identity rule, or quality meaning is a contract change and MUST be
reviewed with this specification and affected consumer specifications.

The cache is a reusable transport and efficiency mechanism. It MUST NOT be
represented as durable historical authority.

## 5. Data quality

For every evidence class used by a consumer, the snapshot or its derived source
MUST communicate:

- **availability:** whether usable evidence was obtained;
- **completeness:** whether the declared scope and evidence window were fully
  evaluated;
- **freshness:** whether the observation satisfies the consumer's required
  time boundary; and
- **coverage:** the evaluated portion of the declared population when it can
  be measured.

An empty collection MUST NOT imply a complete zero unless the evidence class is
available, complete, and fresh for the requested scope and window. Unknown,
missing, stale, and partial states MUST remain distinguishable from zero.

## 6. Evidence precedence

Native `gh aw` logs, audits, and declared artifacts are authoritative for the
fields they provide. Derived records MUST retain sufficient identity and
provenance to relate an observation to its repository, workflow, run, and
evidence source when those dimensions are available.

Fallback collection MUST NOT overwrite a more authoritative artifact-derived
field with a weaker observation. Retained records MUST remain distinguishable
from observations collected during the current refresh.

Credentials, tokens, private keys, and secret values MUST NOT appear in the
snapshot, telemetry ledger, or derived sources. Credential telemetry MAY use a
stable non-secret alias, role, or credential class.

## 7. Failure and fallback

When primary collection fails, the publisher MAY preserve a compatible prior
snapshot and MAY perform a bounded GitHub Actions workflow-run fallback. It
MUST record the primary and fallback outcomes.

Fallback run metadata MAY establish basic run identity, status, conclusion,
and timestamps. It MUST NOT be marked complete for artifact-only evidence that
the fallback did not evaluate.

If neither primary collection nor fallback provides usable evidence, the
publisher MUST emit a valid unavailable state rather than fabricate records or
report a complete empty result. Missing scope, credentials, access, or required
evidence MUST fail closed as unavailable, incomplete, skipped, or no-op.

## 8. Consumer obligations

An Activity consumer:

- MUST validate that the snapshot covers its required repository scope and
  evidence window;
- MUST honor availability, completeness, freshness, and coverage metadata;
- MUST NOT render missing or incomplete evidence as an authoritative zero;
- MUST fetch or explicitly report missing evidence when the snapshot cannot
  satisfy its contract;
- MUST NOT infer rollout or target-writing authority from snapshot contents;
- MUST preserve evidence provenance through derived records where supported by
  the source; and
- SHOULD reuse one compatible snapshot instead of repeating equivalent remote
  collection.

Dashboard source vocabulary and source-level semantics are defined by the
[Dashboard Language Specification](../docs/dashboard-language-specification.md).
Dashboard presentation and attention semantics are defined by the
[Dashboard Specification](dashboard.md).

## Informative references

- [CAO Activity](../docs/activity.md) explains the workflow and its dashboard
  relationship for operators and contributors.
- [Data Acquisition Audit](data-acquisition-audit.md) inventories current API,
  indexing, and caching behavior; it is informative rather than normative.
- [Dashboard data health](../docs/dashboard-data-health.md) explains how the
  dashboard presents quality states.
