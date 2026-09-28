---
title: Central Agentic Ops Operational-Value History Reconstruction Specification
description: Normative requirements and compliance vectors for reconstructing retained operational-value observations.
version: 1.0.0
status: Working Draft
editors:
  - GitHub Next
---

# Central Agentic Ops Operational-Value History Reconstruction Specification

**Version:** 1.0.0  
**Status:** Working Draft  
**Latest Version:** https://github.com/githubnext/gh-aw-cao/blob/main/specs/operational-value-history.md  
**Editors:** GitHub Next

## Abstract

This specification defines an implementation-neutral protocol for reconstructing
historical, repository-scoped operational-value observations. It defines the
campaign adapter exchange, observation schedule, retention and idempotency
rules, validation, retirement, cadence compaction, publication, and failure
behavior.

The protocol is shared by the Activity command-line collector and the Go server
collector. It enables one compliance suite to exercise both implementations
without treating either implementation as the normative oracle.

## Status of This Document

This document is a Working Draft. Sections 1 through 11 are normative.
Sections 12 through 14 are informative.

## 1. Conformance

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD",
"SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" are to
be interpreted as described in [RFC 2119].

This specification defines two conformance classes:

1. A **reconstruction orchestrator** discovers and invokes campaign adapters,
   reconstructs missing observations, and publishes the retained shard. The
   Activity `cao operational-value` command and the Go server collector are
   reconstruction orchestrators.
2. A **campaign adapter** accepts observation requests and emits definitions and
   values as JSON Lines.

A conforming implementation MUST satisfy every requirement for its conformance
class. A reconstruction orchestrator MUST accept injected package, database,
output, observation-time, repository, history-campaign, and retention inputs so
that the compliance tests in Section 11 can run without network access. Binary
names, flags, and in-process APIs are implementation-defined.

An orchestrator conformance run always selects a history campaign and a positive
retention duration. Current-only collection without a history campaign is
outside this specification; the current phase of a history reconstruction
invocation remains normative because it supplies the authoritative definitions.
Implementation extensions, including a current-campaign filter, additional
adapter environment fields, or additional informational warnings, MAY exist.
The conformance harness MUST disable optional filters and compare only the
required environment fields and warning categories.

Conformance concerns the observable request, output, warning, and publication
behavior. Programming language, internal data structures, and process-launch
APIs are not part of this specification.

## 2. Terminology and authority

- **Observation instant**: the timestamp at which a metric is evaluated.
- **Current observation**: an adapter evaluation at the invocation's observation
  instant.
- **Historical observation**: an adapter evaluation at an earlier scheduled
  instant.
- **Definition**: adapter metadata that declares a workflow's evaluation mode,
  adoption instant, cadence, repositories, and metric identifiers.
- **Retained shard**: the schema-v2 operational-value JSONL file carried between
  invocations.
- **Active identifier set**: the metric identifiers declared successfully by a
  campaign during the current invocation.
- **History campaign**: the single campaign selected for historical
  reconstruction in an invocation.
- **Cadence bucket**: the interval ending at a cadence boundary measured from a
  workflow's adoption instant.

The campaign adapter owns campaign-specific evidence collection and scoring.
The reconstruction orchestrator MUST NOT reinterpret or recompute a metric
value. The orchestrator owns scheduling, validation, retention, deduplication,
retirement, compaction, and publication.

Operational-value observations are evidence, not rollout authority. Neither a
definition nor a value grants repository access or permission to perform work.

## 3. Invocation and discovery

### 3.1 Inputs

A reconstruction invocation MUST receive:

- a package root;
- an Activity SQLite database path;
- an output path;
- an observation instant;
- one or more requested repository coordinates; and
- when history is requested, a history-campaign name and a positive retention
  duration.

The observation instant MUST be normalized to UTC in canonical form
`YYYY-MM-DDTHH:mm:ss.sssZ`. Repository coordinates MUST match
`^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$`.

Requested repositories MUST be deduplicated case-insensitively and sorted
case-insensitively. At least one valid repository is REQUIRED. A history request
without a positive retention duration MUST fail before any adapter executes.

### 3.2 Adapter discovery

The orchestrator MUST inspect each non-hidden direct child directory of the
package root in ascending campaign-name order. A regular file named
`operational-value.mjs` in that directory is the campaign adapter. The child
directory name is the campaign identity.

When a history campaign is requested and no discovered adapter has that exact
campaign identity, the invocation MUST fail before publication.

Every discovered campaign adapter MUST execute once at the current observation
instant during a conformance run. Historical reconstruction MUST execute only
the selected history campaign.

## 4. Campaign adapter exchange

### 4.1 Request

The orchestrator MUST send exactly one UTF-8 JSON object followed by a newline
to the adapter's standard input:

```json
{
  "schemaVersion": 1,
  "timestamp": "2026-09-24T10:00:00.000Z",
  "repositories": ["githubnext/gh-aw-cao"],
  "database": "/absolute/path/activity.sqlite"
}
```

`schemaVersion` MUST equal `1`. `timestamp` MUST be the requested canonical
observation instant. For current collection, `repositories` MUST contain all
normalized requested repositories. For historical collection, it MUST contain
only the normalized requested repositories supported by the applicable
definition. `database` MUST be an absolute path.

For a historical request, the orchestrator MUST additionally select exactly one
workflow module by setting `CAO_OPERATIONAL_VALUE_MODULE` to the definition's
`workflowSlug`. The adapter MUST restrict that response to the selected module.

The orchestrator MUST provide `CAO_DATABASE` as the same absolute database path
and `CAO_OPERATIONAL_VALUE_TIMESTAMP` as the invocation's current observation
instant. The latter remains the current invocation instant during historical
requests; the request's `timestamp` is the historical observation instant.

### 4.2 Response framing

An adapter response MUST be UTF-8 JSON Lines. Blank lines MAY occur. Every
non-blank line MUST contain one JSON object. A malformed line MUST invalidate
the whole adapter response.

An object whose `kind` is `operational_value_definition` is a definition.
Every other object is a value record.

### 4.3 Definition records

A definition record has this shape:

```json
{
  "kind": "operational_value_definition",
  "workflowSlug": "example-worker",
  "adoptedAt": "2026-09-15T23:30:36.000Z",
  "evaluationMode": "baseline-comparable",
  "cadenceDays": 1,
  "repositories": ["githubnext/gh-aw-cao"],
  "valueIds": ["example-worker.attainment"]
}
```

The orchestrator MUST reject a definition unless:

- `workflowSlug` matches `^[a-z0-9]+(?:-[a-z0-9]+)*$`;
- `adoptedAt` is a valid timestamp;
- `evaluationMode` is `baseline-comparable` or `attainment-only`;
- `cadenceDays` is a finite number greater than zero;
- `repositories` is a non-empty array of valid repository coordinates;
- `valueIds` is a non-empty array;
- every value ID matches
  `^[a-z0-9]+(?:[._-][a-z0-9]+)*$` and begins with
  `<workflowSlug>.`; and
- no value ID was declared previously in the same adapter response.

The orchestrator MUST canonicalize `adoptedAt`, lowercase and deduplicate the
definition's repositories, and preserve value-ID order.

### 4.4 Value records

A value record MUST contain:

- `timestamp`: a valid timestamp;
- `repository`: a valid coordinate included in the request;
- `valueId`: an identifier matching the value-ID expression in Section 4.3; and
- `value`: a finite JSON number.

It MAY contain:

- `metricRole`: `primary` or `diagnostic`;
- `metricName`: a non-empty string;
- `metricUnit`: a non-empty string;
- `metricDirection`: `increase`, `decrease`, `maintain`, or `target`;
- `maturityStatus`: `matured`, `interim`, or `unavailable`;
- `adoptionAt`: a valid timestamp;
- `evaluationMode`: `baseline-comparable` or `attainment-only`;
- `workflowSlug`: a non-empty string;
- `workflowName`: a non-empty string; and
- both `rollupNumerator` and `rollupDenominator`.

When either rollup field is present, both MUST be present.
`rollupNumerator` MUST be finite and non-negative.
`rollupDenominator` MUST be finite and greater than zero.

For `metricRole`, `metricName`, `metricDirection`, and `maturityStatus`, an
explicit JSON `null` MUST receive the same default as an omitted field. For
every other optional field, an explicitly present JSON `null` is not omission
and MUST be rejected because `null` is outside the field's domain. Timestamps
MUST be canonicalized. String metadata MUST be trimmed.

For omitted metadata, the orchestrator MUST use these publication defaults:

| Field | Default |
| --- | --- |
| `metricRole` | `primary` |
| `metricName` | the `valueId` |
| `metricDirection` | `increase` |
| `maturityStatus` | `matured` |

Other omitted optional metadata MUST remain absent.

## 5. Historical schedule

For each valid definition in the selected history campaign, the orchestrator
MUST intersect the normalized requested repositories with the definition's
supported repositories using case-insensitive comparison. It MUST skip a
definition whose intersection is empty.

Let:

- `A` be the definition's adoption instant;
- `C` be `cadenceDays × 86,400,000` milliseconds;
- `O` be the invocation observation instant;
- `R` be the positive retention duration; and
- `B` be `3`, the fixed number of baseline observations.

The schedule origin `S` MUST be:

```text
S = A                 when evaluationMode = "attainment-only"
S = A - (B × C)       when evaluationMode = "baseline-comparable"
```

The effective cutoff `K` MUST be:

```text
K = max(S, O - R)
```

Candidate instants MUST be generated as `S + nC` for integers `n ≥ 0`, in
ascending order. An instant is included exactly when `K ≤ S + nC < O`.
Consequently, the current observation instant is never reconstructed as
history, and a value exactly at the retention cutoff is eligible.

An implementation MUST abort further historical reconstruction for that
campaign when one definition produces more than 366 included instants. Current
values already accepted MUST remain publishable.

## 6. Incremental reconstruction and validation

### 6.1 Retained identity

The exact identity of an observation is the tuple:

```text
(lowercase campaign, lowercase repository, valueId, serialized timestamp)
```

Before reconstruction, the orchestrator MUST build the retained identity set
from all retained envelopes. Adapter timestamps and newly published timestamps
are canonical; a retained timestamp is used exactly as serialized and is not
silently rewritten while constructing this set. A scheduled instant is complete
only when the set contains every Cartesian-product identity of:

- the definition's supported requested repositories; and
- the definition's value IDs.

The orchestrator MUST skip a complete instant. If any identity is missing, it
MUST invoke the adapter once for that instant with all supported requested
repositories. This makes reconstruction incremental without requiring one
adapter call per missing metric.

After accepting a historical response, the orchestrator MUST add each returned
identity to the retained set before considering later definitions or instants.
A repeated invocation over a complete retained shard MUST emit no new
historical values.

### 6.2 Historical response boundary

Every historical value returned for a definition MUST:

- have a timestamp exactly equal to the requested canonical historical instant;
  and
- have a value ID declared by that definition.

If any returned value violates either constraint, the orchestrator MUST reject
that historical response, warn, and stop reconstructing further definitions and
instants for the campaign. A response MAY omit a repository or value ID; the
missing identity remains incomplete for a later invocation.

Definitions emitted during a historical response MUST NOT alter the active
identifier set or the schedule established by the current response.

## 7. Retention, retirement, and cadence compaction

### 7.1 Retention

Before collection, the orchestrator MUST retain only existing envelopes whose
timestamp is greater than or equal to `O - R`. An existing envelope MUST have:

- `schema_version` equal to `2`;
- `kind` equal to `operational_value`;
- a valid `operational_value.timestamp`; and
- a non-empty `operational_value.campaign`.

Malformed envelopes MUST fail the invocation. Envelopes without campaign
identity MUST be pruned because they cannot participate safely in
campaign-scoped identity.

### 7.2 Identifier retirement

After successful current collection, a campaign with one or more definitions
MUST establish its active identifier set from all value IDs in those
definitions. Before merge, retained values for that campaign whose value ID is
not active MUST be removed.

The retirement operation MUST be campaign-scoped. It MUST preserve retained
values for campaigns that failed, emitted no definitions, or were not
collected. It MUST preserve unrelated campaigns even when their value IDs equal
a retired identifier.

### 7.3 Cadence compaction

For a value with a current definition, let `T` be its timestamp and use `A` and
`C` from Section 5. Its cadence bucket end is:

```text
E = A + ceil((T - A) / C) × C
```

Its cadence identity is:

```text
(lowercase campaign, lowercase repository, valueId, canonical E)
```

Values with no current definition MUST retain the exact identity from Section
6.1. The orchestrator MUST merge retained values before newly collected values.
When multiple values have the same merge identity, the value with the latest
observation timestamp MUST win. Equal timestamps MUST prefer the value
encountered later.

Cadence compaction applies equally before and after adoption. It MUST NOT merge
different campaigns, repositories, or value IDs.

## 8. Published envelope and atomicity

Each accepted value MUST be published as:

```json
{
  "schema_version": 2,
  "kind": "operational_value",
  "operational_value": {
    "timestamp": "2026-09-23T23:30:36.000Z",
    "repository": "githubnext/gh-aw-cao",
    "campaign": "example",
    "campaign_id": "campaign:example",
    "value_id": "example-worker.attainment",
    "value": 3,
    "metric_role": "primary",
    "metric_name": "example-worker.attainment",
    "metric_direction": "increase",
    "maturity_status": "matured"
  }
}
```

The orchestrator MUST map optional adapter metadata to the corresponding
snake-case envelope fields without changing its meaning. Absent optional fields
without defaults MUST be omitted from the serialized object.

When an output path is configured, the complete retained shard MUST be written
to a temporary file in the output file's directory and atomically renamed over
the destination. Publication failure MUST leave no partially written
destination. Temporary files MUST be removed after failure.

## 9. Failure behavior

Adapter and historical reconstruction failures are best-effort failures. The
orchestrator MUST report a warning and continue with the next campaign after a
current adapter failure. After a historical failure, it MUST stop further
history work for that campaign but preserve:

- valid current values;
- valid historical values accepted before the failure; and
- retained values not retired under Section 7.2.

A failed current adapter MUST NOT establish an active identifier set and
therefore MUST NOT retire that campaign's retained values.

Input, discovery, retained-shard parsing, and atomic publication failures are
invocation failures. They MUST NOT replace the destination with partial output.

The server collector MAY treat the completed operational-value invocation as a
best-effort projection stage so that its failure does not block newer Activity
evidence. That integration policy does not weaken this section's publication
requirements.

## 10. Resource, security, and privacy requirements

An orchestrator that launches adapters as processes:

- MUST use a bounded execution time; the default SHOULD be two minutes;
- MUST bound standard output and standard error independently; the default
  SHOULD be 16 MiB per stream;
- MUST terminate the adapter and its descendants after timeout, cancellation,
  output overflow, or process completion;
- MUST provide only the environment required by the adapter;
- MUST use installation- or invocation-scoped GitHub credentials; and
- MUST redact credential values from warnings and errors.

When a GitHub API reserve is configured, the orchestrator MUST check the
remaining core quota before each current campaign adapter. It MUST skip that
campaign with a warning when the remaining quota is at or below the reserve. It
MUST check again after collection and warn when collection crossed below the
reserve. A reserve-check failure MUST be a warning and MUST NOT expose a
credential.

The database and retained shard are evidence inputs. Implementations MUST NOT
log their contents, adapter request evidence, metric provenance, or credentials.

## 11. Compliance test suite

### 11.1 Harness contract

A compliance harness MUST create an isolated package root, adapter, database
placeholder, retained shard, and output path. Every test invocation MUST select
a history campaign and positive retention duration unless the test is verifying
rejection of those inputs. The harness MUST be able to:

1. invoke either reconstruction orchestrator with equivalent inputs;
2. record every adapter request and selected module;
3. supply deterministic adapter JSONL or failures;
4. parse the resulting shard as JSON objects; and
5. compare warnings by requirement category rather than implementation-specific
   wording or additional informational warnings.

Except where ordering is the subject of a test, comparisons MUST compare
canonical JSON values rather than textual object-key order. A test MUST NOT call
GitHub unless it is specifically exercising the optional reserve behavior.

### 11.2 Required tests

| Test ID | Requirement | Procedure and expected result |
| --- | --- | --- |
| OVH-DISC-001 | Deterministic discovery | Place adapters in `zeta/`, `.hidden/`, and `alpha/`. Only `alpha` and `zeta` execute, in that order. |
| OVH-DISC-002 | Missing history campaign | Request an absent history campaign. Invocation fails before adapter execution and publication. |
| OVH-IN-001 | Repository normalization | Supply mixed-case duplicates in unsorted order. The adapter receives one of each, sorted case-insensitively. |
| OVH-IN-002 | Required history retention | Request history without a positive retention duration. Invocation fails before adapter execution. |
| OVH-ADP-001 | Request contract | Assert schema version, canonical timestamp, normalized repositories, absolute database path, and required environment fields. |
| OVH-ADP-002 | Module isolation | Assert each history request sets `CAO_OPERATIONAL_VALUE_MODULE` to exactly the scheduled definition's workflow slug. |
| OVH-DEF-001 | Definition domains | Mutate each required definition field outside its domain. Each response is rejected. |
| OVH-DEF-002 | Definition ID uniqueness | Declare the same value ID twice in one current response. The response is rejected. |
| OVH-VAL-001 | Value domains | Mutate each required and optional value field outside its domain. Each response is rejected. |
| OVH-VAL-002 | Null versus omission | Omit each optional field, then provide it as `null`. The four defaulted fields receive their defaults in both cases; explicit `null` is rejected for every other optional field. |
| OVH-VAL-003 | Rollup pair | Supply neither rollup field, each field alone, a negative numerator, a zero denominator, and a valid pair. Only neither and the valid pair are accepted. |
| OVH-SCH-001 | Baseline schedule | Apply Vector A in Section 11.3. Exactly 12 historical requests are made in ascending order. |
| OVH-SCH-002 | Attainment schedule | Apply Vector B. Exactly 9 historical requests are made in ascending order. |
| OVH-SCH-003 | Inclusive retention cutoff | Apply Vector C. Exactly 5 historical requests are made; an instant equal to the cutoff is included. |
| OVH-SCH-004 | Exclusive observation instant | Set the observation instant to a cadence boundary. No historical request equals that instant. |
| OVH-SCH-005 | Schedule bound | Provide a cadence and retention that yield 367 instants. Further history stops with a warning and current values remain publishable. |
| OVH-INC-001 | Complete tuple skip | Preload every repository/value-ID tuple for one instant. No adapter request is made for that instant. |
| OVH-INC-002 | Partial tuple replay | Omit one tuple from the retained shard. The adapter executes once for that instant with all supported repositories. |
| OVH-INC-003 | Repeat idempotency | Run reconstruction twice over the first output. The second run adds zero historical values and the canonical shard is unchanged. |
| OVH-BOUND-001 | Historical boundary | Return a wrong timestamp, then an undeclared value ID. Each response is rejected, later history for that campaign stops, and current values remain. |
| OVH-RET-001 | Retention | Place envelopes immediately before, at, and after the cutoff. The first is pruned and the latter two remain. |
| OVH-RET-002 | Campaign identity | Retain an envelope without campaign identity. It is pruned and never used as a completion key. |
| OVH-RET-003 | Metric retirement | Remove a previously retained ID from a successful definition. That campaign's old ID is removed; the same ID in another campaign remains. |
| OVH-CMP-001 | Cadence winner | Supply multiple timestamps in one cadence bucket. Only the latest remains; a newly collected equal timestamp replaces retained data. |
| OVH-CMP-002 | Cadence isolation | Use equal timestamps and IDs across different campaigns and repositories. No cross-campaign or cross-repository merge occurs. |
| OVH-PUB-001 | Envelope mapping | Verify schema version, kind, campaign identity, defaults, canonical timestamps, optional metadata, and rollup mapping. |
| OVH-PUB-002 | Atomic publication | Inject a write or rename failure. The prior destination remains complete and no partial destination is visible. |
| OVH-FAIL-001 | Current adapter failure | Fail the first of two adapters. The second executes and the failed campaign's retained values are not retired. |
| OVH-FAIL-002 | Historical adapter failure | Fail a historical request after a successful current response. Current and earlier accepted history publish; later history for that campaign does not execute. |
| OVH-SEC-001 | Process bounds | Exercise timeout and output overflow with a descendant process. The process tree terminates and a sanitized warning is produced. |
| OVH-EQV-001 | Cross-implementation equivalence | Run both orchestrators on Vectors A through D and the failure vectors. Their adapter request traces and canonical published JSON values are identical. |

### 11.3 Normative vectors

All vector timestamps are UTC. Each vector uses one repository and one value ID
unless stated otherwise.

| Vector | Mode | Adoption `A` | Cadence | Observation `O` | Retention | Expected historical instants |
| --- | --- | --- | ---: | --- | ---: | --- |
| A | `baseline-comparable` | `2026-09-15T23:30:36.000Z` | 1 day | `2026-09-24T10:00:00.000Z` | 30 days | `2026-09-12T23:30:36.000Z` through `2026-09-23T23:30:36.000Z`, daily (12) |
| B | `attainment-only` | `2026-09-15T23:30:36.000Z` | 1 day | `2026-09-24T10:00:00.000Z` | 30 days | `2026-09-15T23:30:36.000Z` through `2026-09-23T23:30:36.000Z`, daily (9) |
| C | `baseline-comparable` | `2026-09-15T23:30:36.000Z` | 1 day | `2026-09-24T23:30:36.000Z` | 5 days | `2026-09-19T23:30:36.000Z` through `2026-09-23T23:30:36.000Z`, daily (5) |
| D | `baseline-comparable` | `2026-09-15T23:30:36.000Z` | 1 day | `2026-09-24T23:30:36.000Z` | 30 days | Vector A's origin through `2026-09-23T23:30:36.000Z`; never `O` |

For OVH-EQV-001, the initial retained shard MUST also contain:

1. a value for the selected campaign with an identifier absent from its current
   definitions; and
2. a value for an unrelated campaign.

The expected output removes the first value and preserves the second.

## 12. Security and privacy considerations

Historical reconstruction can repeatedly expose a campaign adapter to
repository evidence and scoped credentials. The bounds in Section 10 prevent a
malformed adapter from exhausting process, output, or GitHub API resources.
Atomic publication prevents a failed reconstruction from corrupting the
retained evidence shard.

Metric values and provenance can reveal repository security or operational
posture. Implementations should grant retained-shard and database access only to
the control plane and authorized dashboard readers.

## 13. References

### 13.1 Normative references

- [RFC 2119] Bradner, S. *Key words for use in RFCs to Indicate Requirement
  Levels*. <https://www.rfc-editor.org/rfc/rfc2119>
- [CAO Activity Specification](./activity.md)
- [CAO Server Ingestion Specification](./server-ingestion.md)

### 13.2 Informative references

- [CAO Dashboard Data Specification](./dashboard-data.md)
- [Operational-value design skill](../.github/skills/add-operational-value/SKILL.md)

## 14. Change log

### 1.0.0

- Initial Working Draft defining shared Activity CLI and Go server historical
  reconstruction behavior and implementation-neutral compliance vectors.
