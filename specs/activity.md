---
title: Central Agentic Ops Activity Specification
description: Normative collection, snapshot, data-quality, authority, and consumer requirements for CAO Activity.
version: 1.1.0
status: Working Draft
editors:
  - GitHub Next
---

# Central Agentic Ops Activity Specification

**Version:** 1.1.0
**Status:** Working Draft
**Latest Version:** https://github.com/githubnext/gh-aw-cao/blob/main/specs/activity.md
**Editors:** GitHub Next

## Abstract

This specification defines CAO Activity as the shared collection boundary for
Central Agentic Ops. It defines Activity's authority, required inputs and
outputs, immutable snapshot identity, data-quality semantics, failure behavior,
and consumer obligations. It does not define dashboard presentation, workflow
rollout policy, or durable operational outcomes.

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

CAO Activity is deterministic collection infrastructure. It MUST collect one
bounded `gh aw logs` JSONL snapshot for reuse. It MUST NOT normalize, index, or
derive additional records from that snapshot.

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
to the same workflow run. Inputs are limited to compiled workflow metadata in the checked-out control
repository, a compatible prior JSONL cache entry, and the bounded run metadata,
audits, and declared artifacts acquired by one `gh aw logs` invocation.

The publisher MUST bound remote acquisition by repository scope, evidence
window, pagination, or another explicit limit. It MUST NOT discover workflows
in target repositories merely because those repositories appear in rollout
policy. Installed workflow discovery is bounded to the checked-out control
repository.

Activity MUST NOT invoke a post-processing indexer, GitHub APIs, or another
remote collector to fill missing fields.

## 4. Snapshot contract

The scheduled and manually dispatchable Activity workflow is the only
publisher of the shared Activity cache. Each published snapshot MUST use an
immutable identity derived from the publisher's workflow run ID and run
attempt. A consumer that dispatches Activity MUST restore the exact snapshot
for the completed run and attempt rather than an unspecified latest snapshot.

The snapshot consists only of the JSONL produced by `gh aw logs`. Consumers
MUST determine availability, completeness, freshness, and scope for their own
use and MUST NOT infer those properties from row counts.

The concrete cache file and identity rule are defined by
[`activity/README.md`](../activity/README.md). Changing the file or identity
rule is a contract change and MUST be reviewed with affected consumers.

The cache is a reusable transport and efficiency mechanism. It MUST NOT be
represented as durable historical authority.

## 5. Data quality

For every evidence class used by a consumer, the consumer MUST establish:

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
fields they provide. Consumers deriving records from them MUST retain
sufficient identity and provenance to relate an observation to its repository,
workflow, run, and evidence source when those dimensions are available.

When audit generation is enabled, a publisher MAY retain bounded normalized
audit aggregates and non-secret agent, model, runtime, compiler, firewall, and
gateway identifiers. It MUST NOT publish raw prompts, messages, tool arguments,
authorization values, credentials, response bodies, secret values, or
transcripts from audit or usage artifacts. Nested values, collections, and
strings MUST have explicit publication bounds.

Retained records MUST NOT overwrite a more authoritative artifact-derived
field with a weaker observation. They MUST remain distinguishable from
observations collected during the current refresh.

Credentials, tokens, private keys, and secret values MUST NOT appear in the
snapshot, telemetry ledger, or derived sources. Credential telemetry MAY use a
stable non-secret alias, role, or credential class.

## 7. Failure and retained snapshots

When primary log collection fails, the publisher MAY preserve a compatible
prior JSONL snapshot. It MUST fail the workflow rather than publish a
post-processed failure state.

The publisher MUST NOT respond to a failed `gh aw logs` invocation by issuing
per-workflow run-list, per-run detail, or Jobs API fallback requests. Missing
run fields MUST remain unavailable rather than be inferred from a weaker,
independently collected source.

If neither primary collection nor a compatible retained snapshot provides
usable evidence, the publisher MUST fail. Missing scope, credentials, access,
or required evidence MUST fail closed.

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
