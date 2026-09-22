---
title: Central Agentic Ops Repository Layout and Installation Specification
description: Normative layout, ownership, and installation requirements for CAO catalog and control repositories.
version: 1.0.0
status: Working Draft
editors:
  - GitHub Next
---

# Central Agentic Ops Repository Layout and Installation Specification

**Version:** 1.0.0  
**Status:** Working Draft  
**Latest Version:** https://github.com/githubnext/gh-aw-cao/blob/main/specs/repository-layout-and-installation.md  
**Editors:** GitHub Next

## Abstract

This specification defines the repository layout and installation lifecycle for
Central Agentic Ops (CAO). It establishes one canonical executable runtime
layout for catalog, source-managed, and installed control repositories, assigns
ownership to catalog resources and gh-aw metadata, and defines the
fail-closed materialization strategy required when gh-aw package installation
cannot place arbitrary executable resources at their canonical paths.

## 1. Status and conformance

This document is a Working Draft. Sections 2 through 7 are normative. The
abstract, examples, and rationale are informative unless they contain an
explicit normative requirement.

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD",
"SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" are to
be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

A conforming CAO catalog and a conforming CAO control repository satisfy all
applicable requirements in this document. A component manifest alone does not
claim conformance as a complete installation.

## 2. Repository roles and canonical paths

A repository MAY be a catalog, a source-managed control repository, an installed
control repository, or more than one of those roles.

| Path | Owner | Required role |
| --- | --- | --- |
| `aw.yml` | CAO catalog | Root installation bundle |
| `<campaign>/` | CAO catalog or materializer | Canonical executable campaign runtime |
| `activity/` | CAO catalog or materializer | Canonical Activity runtime |
| `dashboard/` | CAO catalog or materializer | Canonical Dashboard runtime |
| `.github/workflows/` | Control repository and gh-aw | Workflow sources, generated locks, and CAO policy |
| `.github/workflows/cao.json` | Control repository | Persistent non-secret rollout policy |
| `.github/workflows/shared/materialize-cao.mjs` | CAO bootstrap | Trusted canonical-runtime materializer |
| `.github/actions/setup-cao-runtime/` | CAO bootstrap | Local runtime verification action |
| `.github/cao/instructions.md` | Control repository | Optional CAO operator guidance |
| `.github/aw/` | gh-aw | Instructions, package and campaign records, ownership metadata, and gh-aw runtime data |

An executable CAO resource MUST use the same repository-relative path in a
catalog and in a conforming control repository. A conforming implementation
MUST NOT create an executable CAO mirror below `.github/aw/`, nor resolve a
runtime file by probing both a canonical path and an alternate installed path.

`.github/aw/` records do not grant, narrow, or revoke CAO rollout authority.
Only the reviewed control-repository policy and compiled workflow can do so, as
defined by the control architecture specification.

## 3. Catalog manifest and ownership rules

The root `aw.yml` MUST include Activity and Dashboard as the deterministic
components of a complete CAO installation. Operational campaign manifests
MUST identify the workflows and catalog resources that they own.

Activity and Dashboard component manifests are root-package components. Direct
`gh aw add` of either component MAY install its supported manifest resources,
but it MUST be treated as incomplete until canonical runtime materialization
has succeeded. Documentation and tooling MUST direct operators to the root CAO
installer or CAO lifecycle commands for a complete Activity and Dashboard
installation.

A campaign-owned canonical directory is replaceable by the materializer.
Operators MUST NOT rely on uncommitted local changes inside `activity/`,
`dashboard/`, or a materialized `<campaign>/` directory surviving an install or
update. Consumer-owned policy and steering files outside the selected
campaign-owned destinations MUST NOT be replaced by materialization.

Installed package and campaign records under `.github/aw/` MUST be modified
only through gh-aw campaign commands. CAO lifecycle tooling MUST consume those
records as provenance; it MUST NOT create substitute ownership records.

## 4. Canonical materialization

### 4.1 Provenance

Before replacing any runtime destination, the materializer MUST read installed
CAO package or campaign records and select only records belonging to the CAO
catalog repository. Each selected record MUST contain a full, 40-character
`resolvedCommit` SHA. Missing, shortened, tag-only, mutable, or otherwise
invalid provenance MUST fail closed.

The materializer MUST acquire the source archive by that immutable revision and
MUST validate every resource in every selected bundle before replacing any
destination. It MUST NOT fetch a branch, tag, or alternate runtime layout
during workflow execution.

When the root record and exact focused Activity or Dashboard records coexist,
the focused record MUST own its corresponding canonical directory. The root
record MUST NOT overwrite that directory. Each selected revision MUST be
preflighted before the first replacement.

### 4.2 Replacement

Root materialization owns `activity/`, `dashboard/`, `cao.sh`,
`.github/actions/setup-cao-runtime/`, and `.github/cao/instructions.md`.
Focused Activity or Dashboard materialization owns the corresponding canonical
directory. Operational campaign materialization owns its complete
`<campaign>/` directory.

For each selected owned destination, materialization MUST remove the existing
destination and copy the complete selected source destination. This replacement
rule ensures that a file removed by a newer selected revision cannot remain
executable. The materializer MUST NOT remove paths outside the bounded owned
destination set.

### 4.3 Lifecycle entry points

The supported root CAO installer MUST materialize the root runtime after gh-aw
has resolved the root package record. `cao add` MUST materialize a selected
non-root campaign before reading its declaration. `cao add` MUST reject the
root package before invoking gh-aw and direct operators to the root installer.
`cao update` MUST materialize each updated selected package before merging
declarations.

gh-aw package installation by itself cannot run this post-install lifecycle.
Therefore an implementation MUST NOT represent direct Activity or Dashboard
component installation as a complete CAO installation.

## 5. Workflow execution and verification

Activity and Dashboard workflows MUST check out the control repository at
`github.workflow_sha`. They MUST use the repository-local
`$/.github/actions/setup-cao-runtime` action to verify their required canonical
runtime bundle before executing it.

Runtime verification MUST be local and fail closed when a required canonical
file is absent. A workflow MUST NOT download another CAO checkout, use a
catalog ref to replace local runtime provenance, or probe alternate runtime
layouts. Workflow and policy changes MUST remain in the same reviewed commit,
because execution resolves authority at the exact workflow revision.

## 6. Removal and recovery

The current CAO lifecycle does not support package removal. Operators MUST NOT
use `gh aw remove` as a CAO package-removal procedure: it removes workflow files
but does not remove materializer-owned canonical directories or package records,
and would leave orphaned executable material. A future CAO removal lifecycle
MUST remove the selected package record and its bounded canonical destination
transactionally; until then, removal is unsupported.

If package provenance, archive acquisition, archive extraction, bundle
validation, or local runtime verification fails, lifecycle tooling and
workflows MUST stop before executing the affected CAO runtime. An operator MAY
recover only by installing or updating through a supported lifecycle entry
point with valid immutable provenance.

## 7. Compliance testing

A conforming implementation MUST test:

1. materialization with immutable full-SHA provenance and rejection of invalid
   provenance;
2. complete-bundle preflight before destination replacement;
3. replacement that removes stale campaign-owned files;
4. preservation of exact focused Activity and Dashboard ownership during root
   materialization;
5. absence of executable CAO runtime mirrors under `.github/aw/`;
6. local fail-closed Activity and Dashboard runtime verification; and
7. installation and update behavior for canonical destinations; and
8. rejection or documentation of unsupported package removal until a
   transactional removal lifecycle exists.

Generated workflow lock files are implementation artifacts. Conformance tests
MUST validate the editable workflow sources and MUST NOT require hand edits to
lock files.
