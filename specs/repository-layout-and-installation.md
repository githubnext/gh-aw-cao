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
fail-closed materialization strategy required when gh-aw campaign installation
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
| `plugin.json` | CAO catalog or Agent Plugin installer | Separately installed portable Agent Plugin manifest |
| `com.github.copilot/extensions/cao-dashboard/` | CAO catalog or Agent Plugin installer | Separately installed Copilot CLI extension and Dashboard canvas runtime |
| `specs/dashboard-data.md` | CAO catalog or Agent Plugin installer | Canonical data specification bundled with the separate Dashboard extension |
| `.github/workflows/` | Control repository and gh-aw | Workflow sources, generated locks, and CAO policy |
| `.github/workflows/cao.json` | Control repository | Persistent non-secret rollout policy |
| `.github/workflows/shared/materialize-cao.mjs` | CAO bootstrap | Trusted canonical-runtime materializer |
| `.github/actions/setup-cao-runtime/` | CAO bootstrap | Local runtime verification action |
| `.github/actions/setup-gh-aw/` | CAO bootstrap | Local policy-pinned gh-aw setup action |
| `.github/cao/instructions.md` | Control repository | Optional CAO operator guidance |
| `.github/aw/` | gh-aw | Instructions, campaign records, ownership metadata, and gh-aw runtime data |

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
MUST identify only the workflows and catalog resources that they own and MUST
NOT import the root catalog package. Operational campaigns MUST be installed
through `cao add` after control-plane installation so the lifecycle command can
materialize their canonical runtime without reinstalling control-plane or Agent
Plugin resources.

Activity and Dashboard component manifests are root-campaign components. Direct
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

Installed campaign records under `.github/aw/` MUST be modified
only through gh-aw campaign commands. CAO lifecycle tooling MUST consume those
records as provenance; it MUST NOT create substitute ownership records.

## 4. Canonical materialization

### 4.1 Provenance

Before replacing any runtime destination, the materializer MUST read installed
CAO campaign records and select only records belonging to the CAO
catalog repository. Each selected record MUST contain a full, 40-character
`resolvedCommit` SHA. Missing, shortened, tag-only, mutable, or otherwise
invalid provenance MUST fail closed.

For Activity, Dashboard, and root installation, the materializer MUST acquire
the prebuilt `cao-runtime-<resolvedCommit>.tgz` archive. Exact stable `vX.Y.Z`
source references use that release's assets; other references use an unexpired
artifact from a successful `cao-runtime.yml` push or release run at that SHA.
The materializer MUST verify GitHub's signed build provenance with `gh
attestation verify`, requiring the catalog repository, the
`.github/workflows/cao-runtime.yml` signer, matching source and signer commit
digests, and a GitHub-hosted runner before extracting the archive. It MUST then
validate the revision-bound file inventory, checksums, bounded ownership, and
required runtime resources in every selected bundle before replacing any
destination. Missing, expired, mismatched, or unverifiable artifacts MUST fail
closed, without latest-release or install-time source/npm fallback.

Operational campaigns retain source-archive acquisition by their immutable
revision. Workflow execution MUST NOT fetch a branch, tag, or alternate runtime
layout. Local developer source materialization is a separate, explicit path
that may use npm packing.

When the root record and exact focused Activity or Dashboard records coexist,
the focused record MUST own its corresponding canonical directory. The root
record MUST NOT overwrite that directory. Each selected revision MUST be
preflighted before the first replacement.

### 4.2 Replacement

Root materialization owns `activity/`, `dashboard/`, `cao.sh`,
`.github/actions/setup-cao-runtime/`, `.github/actions/setup-gh-aw/`, and
`.github/cao/instructions.md`. Every repository-local action referenced by a
workflow that the root campaign installs MUST be provided at its canonical path
by the root installation; installed workflow files MUST NOT be rewritten to
reference the catalog, because gh-aw records their content hashes.
Focused Activity or Dashboard materialization owns the corresponding canonical
directory. Operational campaign materialization owns its complete
`<campaign>/` directory.

Activity and Dashboard materialization MUST copy only the production resources
selected at build time by `npm pack` using the dedicated
`runtime/package.json` manifest's `files` field. The package MUST include the operator CLI, collection and query
modules, local preview runtime,
dashboard build inputs, production browser sources, and required dependency
manifests at their canonical source paths. Compatible libraries may be bundled
with esbuild, retaining their license notices; filesystem-relative CLI modules,
workers, and build inputs MUST retain their canonical paths. Packing MUST disable
lifecycle scripts and MUST NOT install dependencies or publish to a registry. Package
metadata MUST remain in temporary staging rather than replacing a consumer's
root `package.json`. It MUST NOT copy dashboard tests, fixtures, screenshots,
development plans, lint/test configuration, or catalog-only component
manifests. Production runtime directories selected by the package's `files`
field MUST NOT contain development-only resources.

The producer workflow MUST build and test with read-only repository permission,
then attest in a separate job that does not check out or execute source code.
Stable release assets MUST be published separately, without overwriting
existing assets, only for a published non-prerelease `vX.Y.Z` tag matching the
build SHA on main history. Main artifacts are retained for 90 days; release
assets are the durable distribution path. Normal installation requires Node.js 24 or newer and GitHub CLI v2.68.0 or
newer, authenticated before repository access. The installer MUST reject older
or unparseable versions before repository creation or file writes. Installation
MUST NOT invoke npm. Existing dashboard build dependency installation is
unchanged apart from omitting development dependencies.

The control-plane installer MUST NOT install the Agent Plugin manifest,
Copilot extension, bundled specification documents, or repository-only
dashboard authoring skills. Those resources belong to the separate Agent
Plugin or catalog authoring installation. Root materialization MUST preserve
pre-existing resources outside its owned destination set, including separately
installed plugin resources and skills.
The installer MUST add the repository-root `aw.yml` package. That manifest MUST
explicitly compose only the Activity, dashboard, and validation workflows, the
five shared control-plane resources, seven portable control-repository skills
(including the Agentic Workflows router), one Agentic Workflows agent, and the
gh-aw project settings. The router skill MUST load current routing guidance
through the canonical upstream Agentic Workflows skill on `main` instead of
copying its routing table. The custom agent MUST delegate to the installed
router skill instead of maintaining a second routing table.
If canonical guidance cannot be loaded, the router MUST fail explicitly rather
than use stale remembered guidance. Version-sensitive workflow behavior MUST
remain constrained by the control repository's policy-pinned `gh aw` CLI, and
shipped CAO skills MUST delegate parsing, mutation, compilation, querying, and
verification to existing deterministic `gh aw`, `cao`, and repository
validation commands. It MUST declare only
`.github/agents/agentic-workflows.md` in its nonempty `agents` list so agent
auto-discovery cannot install repository-only agents. Because gh-aw v0.91.5
auto-scans root `skills/` even when `skills` entries are explicit, that
directory MUST contain only the seven portable skills declared by the root
manifest. Additional package manifests MUST live only in campaign or component
directories.

For each selected owned destination, materialization MUST remove the existing
destination and copy the complete selected production bundle. Operational
campaigns retain complete-directory replacement. This replacement
rule ensures that a file removed by a newer selected revision cannot remain
executable. The materializer MUST NOT remove paths outside the bounded owned
destination set.

### 4.3 Lifecycle entry points

The supported root CAO installer MUST materialize the root runtime after gh-aw
has resolved the root package record. For a main or SHA source, the
materializer MUST wait at most five minutes when the exact runtime build is
queued or running, then fail closed if it does not complete successfully; it
MUST NOT substitute another revision or build from source. `cao add` MUST materialize a selected
non-root campaign before reading its declaration. `cao add` MUST reject the
root campaign before invoking gh-aw and direct operators to the root installer.
`cao update` MUST materialize each updated selected campaign before merging
declarations.

The installer MUST check tools, Node.js 24+, GitHub sign-in, and checkout-root
readiness before installation or upgrade. Creating a control repository MUST
require either explicit `--create-repo` or default-No confirmation on a
controlling terminal when no GitHub checkout or remote is available. An exact
`OWNER/NAME` argument MUST support non-interactive use. Interactive creation
MUST list the signed-in user and organizations for which GitHub reports
repository-creation permission, and require an explicit owner selection and
valid repository name. It SHOULD suggest `cao` when the selected owner has no
repository with that name, and MUST surface lookup failures rather than treating
them as availability. A Git checkout without remotes MUST be connected in place;
a directory without a Git checkout MUST receive a new clone. The terminal prompt
MUST provide keyboard-driven selection and MUST fall back to numbered plain text
when `ACCESSIBLE` or `NO_COLOR` is set or the terminal reports no styling
support. It MUST create a private repository and refuse an existing clone
directory. After a successful
installation without `--setup` or `--quickstart`, it MUST finish without
another prompt and print the setup command for later. `--setup` MUST open
guided setup directly on the controlling terminal without allowing streamed
children to consume installer source from stdin. Interactive `--quickstart`
MUST preserve that controlling terminal for its progress UI. `--quickstart`
MUST also run with plain progress from a clean current public or private
control-repository checkout when no terminal is available or `CI` is set.
Outside a checkout it MUST default only to the signed-in user's available
`cao` repository name; another coordinate MUST require
`--create-repo OWNER/NAME`. Informational status lines SHOULD remain
aligned with completed steps while using muted styling to distinguish existing
state from completed work. Animated presentation MUST be disabled when
`ACCESSIBLE`, `NO_COLOR`, or `CI` is set or the terminal reports no styling
support.

Guided setup MUST separate prompt presentation from policy authority, show the
exact plan with default-No confirmation before applying settings, verify the
Pages source without changing visibility, require separate default-No consent
for a public dashboard before changing credentials, and atomically save policy only after both
succeed. The repository-scope prompt MUST state that comma-separated names and
`*` wildcard patterns are accepted; wildcard patterns MUST be expanded before
review so only exact repository names are saved. Cancellation before
application MUST leave policy, credentials, and
Pages unchanged. Declining or cancelling public-dashboard consent MUST remove
only a newly created site where possible and leave an existing site with
restriction or unpublication guidance. Failures after application starts MUST disclose possible
partial external changes rather than imply rollback. Setup MUST NOT install
campaigns, dispatch workflows, commit, or push. The UI and its license notices
MUST be bundled so installed setup does not need npm or consumer node_modules.

Without an interactive terminal or when `CI` is set, setup MUST apply only a
deterministic public-control-repository profile. It MUST require the control
repository to be public, require an empty campaign map, and require existing
scope to be absent or already exactly the control repository. It MUST configure
and verify public GitHub Pages with GitHub Actions as its source, select
repository `GITHUB_TOKEN` (`workflow-token`) authentication, set exact
self-only Activity scope, preserve unrelated policy fields, and write policy
last. It MUST fail before external mutation for private/internal repositories,
broader existing scope, or non-empty campaigns. It MUST use plain unstyled
output and MUST NOT prompt, open a browser, install a campaign, dispatch,
commit, or push.

`--quickstart` MUST be a separate, explicit end-to-end path rather than an
implicit continuation of install or setup. It MUST use a clean current public
or private control repository, default to creating the private
`USERNAME/cao` control repository outside a checkout, or create another private
control repository only when `--create-repo OWNER/NAME` requests it. It MUST
disclose before execution that it publishes a public dashboard, creates the
private `USERNAME/cao` control repository when needed, targets a pinned
fictional emergency-rollout incident in the public
`githubnext/gh-aw-cao-bug-bash` repository unless `--target OWNER/REPO` selects
another existing public target, runs Bug Bash against
that target in review mode, and may consume up to 700 AI credits. The flag itself
authorizes the bounded campaign installation, commit, push, dispatch,
collection, and deployment effects in interactive and headless use; the
installer MUST NOT add a redundant post-install confirmation.
Each potentially long quickstart phase MUST expose elapsed progress and end in
an explicit success, warning, or failure state. Node experimental-runtime
diagnostics MUST NOT be mixed into normal quickstart progress.

The quickstart MUST:

- require the checked-out default branch and refuse any pre-install working-tree
  change; it MAY add its bounded commit on top of existing repository history;
- accept public, private, and internal control repositories because its target
  and collected evidence are public, without widening that visibility exception
  to another target or campaign;
- validate an explicit target as public, or select
  `githubnext/gh-aw-cao-bug-bash` and verify that its configured immutable
  revision remains available; it MUST NOT create, fork, copy, or otherwise
  mutate a target repository and MUST NOT fall back to a mutable branch;
- supply the canonical starter hypothesis from the campaign contract rather
  than target content; the pinned target and its reachable history MUST NOT
  contain the incident explanation, root-cause hint, failing reproduction, or
  intentional-bug warning that would reveal the seeded defect;
- configure exact global scope for the control repository and selected public
  target while declaring `control-plane.activity.repositories` as only the
  control repository;
- set Bug Bash to `review`, cap selection at one repository, set rollout to
  100 percent for the exact selected target, and cap its worker at `review`;
- select repository-local workflow-token mode and require public GitHub Pages
  with GitHub Actions as its source;
- refuse unrelated working-tree paths, stage only `.github/`, `activity/`,
  `dashboard/`, `bug-bash/`, `cao.sh`, gh-aw's root `.gitattributes`, and its
  `.vscode/settings.json` project settings, refuse pre-staged changes, then
  create and push one commit on the repository default branch;
- dispatch one Bug Bash orchestrator and at most one investigation worker,
  preserving a blocked or failed outcome rather than converting it to
  `no-finding`;
- dispatch Activity with a correlatable request ID, require a successful
  data-bearing Activity artifact with at least one unique run, then require the
  corresponding dashboard deployment to succeed; and
- never modify the selected target; and
- print the target, dashboard, workflow-run, and control-repository URLs only after
  those success conditions are verified.

`control-plane.activity.repositories`, when present, MUST contain exact
repository coordinates, contain at least one entry, remain within
`control-plane.scope.allowed-owners`, and, when an exact repository allowlist is
present, be its subset. Activity authentication MUST use that declared
collection subset instead of silently narrowing broader rollout scope. Without
the field, existing fail-closed authentication behavior remains unchanged.

`cao update` without a ref MUST retain release-based selection. An explicit
`main`, `master`, `latest`, or commit SHA MUST resolve once to a full catalog
commit SHA before any package is reapplied. Every selected installed CAO package MUST be reapplied
at that same SHA through gh-aw, and its recorded `resolvedCommit` MUST match
before materialization. Explicit-ref updates replace campaign-owned files;
they MUST NOT widen operator-owned rollout settings.

`main` and `master` MUST both resolve the catalog repository's default branch
reported by GitHub, not assume a literal branch name or use the control
repository's default branch.

`latest` MUST select the highest published stable `vMAJOR.MINOR.PATCH` version,
excluding drafts, prereleases, and non-version tags across all release pages.
It MUST provide an explicit path from an untagged install back to release-based updates. It MUST
NOT depend on a release tag existing at the previously installed commit.
Options MUST be accepted before or after the ref without interpreting option
values as refs, and multiple refs MUST be rejected before any mutation.

gh-aw campaign installation by itself cannot run this post-install lifecycle.
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

The current CAO lifecycle does not support campaign removal. Operators MUST NOT
use `gh aw remove` as a CAO campaign-removal procedure: it removes workflow files
but does not remove materializer-owned canonical directories or campaign records,
and would leave orphaned executable material. A future CAO removal lifecycle
MUST remove the selected campaign record and its bounded canonical destination
transactionally; until then, removal is unsupported.

If campaign provenance, archive acquisition, archive extraction, bundle
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
8. rejection or documentation of unsupported campaign removal until a
   transactional removal lifecycle exists; and
9. exclusion of development-only and Agent Plugin resources from new control
   installations, preservation of separately installed plugin resources, and
   completeness of the documented installation commit in a fresh checkout.

Generated workflow lock files are implementation artifacts. Conformance tests
MUST validate the editable workflow sources and MUST NOT require hand edits to
lock files.
