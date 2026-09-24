---
title: Cached gh-aw JSONL mapping
description: Normative mapping of cached schema-v2 gh-aw JSONL into canonical dashboard data.
---

# Cached gh-aw JSONL mapping

Each schema-v2 activity shard SHALL be mapped into the existing
canonical stores without adding source-shaped stores, indexes, or
relationships. The normative ingestion expression is
`dashboard/site/src/data/ingest/expressions/gh-aw-logs-v2.json`.

The mapping SHALL preserve these mandatory relationships:

```text
Workflow -> Repository
Run -> Repository and Workflow
Domain, Tool, Audit, and Issue -> Run
```

The mapping SHALL NOT emit Campaign or Transaction observations. Transactions
remain the database-operation audit ledger maintained by the ingestion
coordinator. Enriched `job_details` MAY feed published job-performance
projections but SHALL NOT emit canonical Job observations.

## 0 Acquisition and shard scope

`cao.json` SHALL resolve the bounded set of repositories that Activity may
inspect; it SHALL NOT provide Workflow or Run identity. Activity SHALL invoke
`gh aw logs --repo OWNER/REPOSITORY` once for each resolved repository and SHALL
give each repository an independent `--cached-jsonl` wildcard prefix. Every
retained shard is part of the same schema-v2 runtime observation source.

Canonical ingestion SHALL process shards individually and use their content
hashes to skip unchanged inputs. Each activity shard SHALL contain the
concatenated retained shards for publication and browser ingestion; it MUST NOT
be interpreted as a separate observation source in addition to those shards.

Runtime ownership SHALL always come from the execution repository represented
by `request.repository` or the enriched Run's `organization` and `repository`.
Target repositories carried in dispatch titles, campaign policy, safe-output
records, or other payload fields MUST NOT participate in the Repository,
Workflow, or Run ownership joins below.

## 1 `workflow_runs` envelope

The `workflow_runs` envelope contains raw GitHub Actions run listings.
Payload rows SHALL be deduplicated by `databaseId` and `attempt`.

| JSONL source | Canonical entity | Canonical field |
| --- | --- | --- |
| `request.repository` | Repository | `id`, `owner`, `name`, `fullName` |
| Constant `unknown` | Repository | `visibility` |
| `payload[].workflowName` | Workflow | `id`, `name` |
| Resolved enriched `workflow_path` | Workflow | `path` |
| Mapped Repository ID | Workflow | `repositoryId` |
| `payload[].databaseId` | Run | `id`, `githubRunId` |
| `payload[].attempt` | Run | `attempt` |
| `payload[].number` | Run | `number` |
| `payload[].displayTitle` | Run | `title` |
| `payload[].event` | Run | `event` |
| `payload[].status` | Run | `status` |
| `payload[].conclusion` | Run | `conclusion` |
| `payload[].headBranch` | Run | `branch` |
| `payload[].headSha` | Run | `headSha` |
| `payload[].createdAt` | Run | `createdAt` |
| `payload[].startedAt` | Run | `startedAt` |
| `payload[].updatedAt` | Run | `updatedAt` |
| `payload[].updatedAt` when status is `completed` | Run | `completedAt` |
| `payload[].url` | Run | `runLink` |
| Mapped Repository and Workflow IDs | Run | `repositoryId`, `workflowId` |

Repository identity SHALL use the normalized `OWNER/REPOSITORY` coordinate
because this source variant does not expose an immutable GitHub repository ID.
Workflow identity SHALL use Repository plus authoritative workflow path when
the enriched records resolve one unique path for the workflow name. Otherwise,
it SHALL use a source-namespaced Repository-plus-workflow-name coordinate and
leave the path absent.

Source rows SHALL be deduplicated by run ID and attempt before normalization.
The canonical Run identity SHALL be:

```text
github:run:<normalized-owner>/<normalized-repository>:<databaseId>
```

The winning observation SHALL retain `attempt`; an attempt does not create a
second canonical Run.

## 2 `run` envelope

The `run` envelope contains the enriched agentic workflow-run observation.
Records SHALL be deduplicated by `run_id` and `run_attempt`. The observation
with the latest valid `updated_at` SHALL win. Records with equal timestamps
SHALL merge in source order so fields appended by audit enrichment do not
discard fields from the earlier record. Later fields, including explicit
`null` values, SHALL override earlier fields.

The enriched observation SHALL update the same canonical Run identity created
from `workflow_runs`. When no raw listing exists, the enriched observation MAY
create the base Run using its own GitHub and workflow fields.

| JSONL source | Canonical Run field |
| --- | --- |
| `run_id` | `id`, `githubRunId` |
| `run_attempt` | `attempt` |
| `organization` | `owner` |
| `repository` | `repository`, `repositoryFullName` |
| `workflow_path` | `workflowPath` and related Workflow `path` |
| `display_title` | `title` |
| `event` or `event_name` | `event` |
| `status` | `status` |
| `conclusion` | `conclusion` |
| `classification` | `classification` |
| `intentional_failure` | `intentionalFailure` |
| `failure_kind` | `failureKind` |
| `duration` | `duration` |
| `action_minutes` | `actionMinutes` |
| `agent_id`, `agent`, `engine_id`, or `aw_info.engine_id` | `agentId` |
| `agent_version`, `engine_version`, or `aw_info.version` | `agentVersion` |
| `model_id`, `resolved_model`, `model`, `aw_info.model`, or dominant `by_model` entry | `modelId` |
| completed `started_at` or `created_at` through `completed_at`, falling back to `updated_at` | `agenticDurationSeconds` |
| `firewall_analysis.requests_by_domain.*.allowed` or audit equivalent | `firewallAllowedCalls` |
| `firewall_analysis.requests_by_domain.*.blocked` or audit equivalent | `firewallBlockedCalls` |
| `mcp_tool_usage.tool_calls` or audit equivalent | `mcpToolCalls` |
| `mcp_tool_usage.tool_calls[].output_size` or audit equivalent | `mcpResponseBytes` |
| the single `graders.results[]` entry identified by `operational-value` | `operationalGrader` |
| high-severity or high-priority audit findings, insights, and recommendations | `highPriorityAuditItems` |
| medium-severity or medium-priority audit findings, insights, and recommendations | `mediumPriorityAuditItems` |
| `gh_aw_version`, `ghAwVersion`, `cli_version`, `version`, or `aw_info.cli_version` | `ghAwVersion` |
| `engine` or `aw_info.engine_name` | `engine` |
| `engine_id` or `aw_info.engine_id` | `engineId` |
| `engine_version` or `aw_info.version` | `engineVersion` |
| `requested_model` or `requestedModel` | `requestedModel` |
| `resolved_model`, `resolvedModel`, `model_resolved`, `model`, `aw_info.model`, or dominant `by_model` entry | `resolvedModel` |
| `agent_runtime` or `aw_info.agent_runtime` | `agentRuntime` |
| `firewall_version`, `aw_info.firewall_version`, or `aw_info.awf_version` | `firewallVersion` |
| `gateway_version` or `aw_info.awmg_version` | `gatewayVersion` |
| `token_usage_summary.total_aic` or `aic` | `aic`, `aicTotal` |
| `token_usage_summary` or `token_usage` | `tokenUsage` |
| `ambient_context` | `ambientContext` |
| `working_set` | `workingSet` |
| `behavior_fingerprint` | `behaviorFingerprint` |
| `task_domain` | `taskDomain` |
| `comparison` | `comparison` |
| `agentic_assessments` | `agenticAssessments` |
| `graders` | `graders` |
| `context` | `context` |
| `github_api_calls` | `githubApiCalls` |
| `safe_items_count` | `safeItemsCount` |
| `error_count` | `errorCount` |
| `logs_path` | `logsPath` |
| `audit_path` | `auditPath` |

Raw `workflow_runs` values SHALL own GitHub execution state when both source
variants contain the field. Enriched values SHALL own agentic analysis fields.
Absent, explicit `null`, zero, `false`, and empty collections SHALL remain
distinct.

Unavailable immutable aggregates SHALL map to `null`. When the corresponding
firewall, MCP, or audit evidence class is present but contains no matching
entries, its count or size aggregate SHALL map to zero.
Explicit top-level firewall or MCP evidence, including `null` or an empty
collection, SHALL take precedence over the audit equivalent; audit evidence is
used only when the top-level field is absent.

## 2.1 Token-optimization supporting evidence

The schema-v2 `run` envelope supplies supporting token-optimization evidence at
the grain declared by the source schema:

| JSONL source | Canonical projection |
| --- | --- |
| `turns` | Run-level turn diagnostic |
| `token_usage_summary.total_aic` | Run-aggregate AIC |
| `token_usage_summary.total_input_tokens` | Run-aggregate input tokens |
| `token_usage_summary.total_output_tokens` | Run-aggregate output tokens |
| `token_usage_summary.total_cache_read_tokens` | Run-aggregate cache-read tokens |
| `token_usage_summary.total_cache_write_tokens` | Run-aggregate cache-write tokens |
| `token_usage_summary.by_model` | Run-and-model aggregate usage |
| `token_usage_summary.cache_efficiency` | Run-level cache diagnostic |
| `experiments.assignments` | One experiment assignment per map entry for the Run |
| `mcp_tool_usage.tool_calls[]` | Correlated canonical Tool records |
| canonical Run conclusion | Completed-Run reliability evidence |

The summary and `by_model` objects SHALL retain aggregate cost grain and MUST
NOT fabricate API-invocation identities. When invocation-grain API-proxy usage
is also collected, adapters SHALL prefer it for invocation queries and MUST NOT
add the corresponding summary AIC a second time.

Token-efficiency opportunities, interventions, and comparisons MUST NOT be
inferred solely from high cost, aggregate token usage, or a safe-output creation
record. They require the explicit producer observations, frozen assignment, and
evidence rules in `specs/dashboard-data.md` Section 5.5. Safe-output creation is
not accepted-outcome evidence without an authoritative disposition or frozen
evaluator rule.

## 3 Job detail mapping

`job_details[]` items are not canonical entities. Producers MAY retain them for
the published `job-performance` logical source, but normalized canonical shards,
SQLite, and IndexedDB MUST omit them.

## 4 Run-owned record ownership

Every Domain, Tool, Audit, and Issue emitted from an enriched Run SHALL carry
that Run's canonical `runId`. Source observations that describe an agent or tool
interaction context SHALL NOT create a canonical entity or intermediate
ownership relationship between a Run and its records.

Each observation SHALL be classified using `specs/dashboard-data.md`
Section 11: firewall network activity becomes a Domain, MCP, Bash, and skill
calls become Tools, issue and pull-request safe outputs become Issues, and every
other lifecycle, agent, policy, or grader observation becomes an Audit.

## 5 Run-owned record mapping

Run-owned records SHALL use their owning Run ID, source `gh-aw-logs`, a stable
semantic ID, the source line as `payloadRef`, and the source line-derived
sequence as `sourceSequence`.

Enriched Runs SHALL emit these Audit records:

| Source condition | Audit `type` |
| --- | --- |
| Enriched Run has a start or creation time | `workflow_run_started` |
| Every enriched Run | `agent.session` with source `agent`, an agent-context Audit and not a canonical entity |
| Enriched Run is completed | `workflow_run_completed` |
| Conclusion is failure or `failure_kind` exists | `workflow_run_failed` |
| Token usage or AIC exists | `workflow_run_usage` |
| `working_set` exists | `workflow_run_working_set` |
| `behavior_fingerprint` or `task_domain` exists | `workflow_run_behavior` |
| Each `agentic_assessments[]` item | `workflow_run_assessment` |
| Each `graders.results[]` item | `workflow_run_grader` |
| `safe_items_count` exists | `workflow_run_safe_outputs` |
| `comparison` exists | `workflow_run_comparison` |

Each `mcp_tool_usage.tool_calls[]` item SHALL emit a `tool.call` Tool record and
a correlated outcome record. When the run-level projection is absent or empty,
`audit.mcp_tool_usage.tool_calls[]` SHALL provide the tool calls. A `success`
status SHALL emit `tool.result`; every other source status SHALL emit
`tool.error` while preserving that status. Both records SHALL use source `mcp`
and the source `tool_call_id` as `correlationId`.

Firewall evidence SHALL map to Domain records that preserve the observed host,
its allowed or blocked decision, and its request count rather than being counted
once per record.

Audit arrays SHALL map to compact canonical Audit records rather than an
audit-shaped store: `key_findings` to `audit.finding`, `observability_insights` to
`audit.observability`, `recommendations` to `audit.recommendation`,
`missing_tools` to `audit.missing_tool`, `missing_data` to
`audit.missing_data`, `noops` to `audit.noop`, `mcp_failures` to
`audit.mcp_failure`, and `skill_activations` to `audit.skill_activation`.
A `skill_activations` item SHALL become a Tool record with `toolType="skill"`
and `isSkill=true`. Each record SHALL preserve the source item's `code` as its
machine-readable audit kind. Dashboard queries SHALL use `code` when present and
retain the `audit.*` type only as the category and legacy fallback.

Each `safe_output_item` envelope SHALL emit `safe_output.created` with source
`safe-output` for its preceding `run` envelope with the
same `run_id`. When no item envelopes are present for a Run, `safe_outputs[]`,
or `audit.created_items[]` when `safe_outputs` is absent, SHALL provide the
records instead. This precedence prevents the duplicated projection in the Run
envelope from creating duplicate records. The record SHALL preserve the source
item's `type` as `safeOutputType` and SHALL preserve or derive
`githubEntityType` from explicit target kind, canonical github.com URL shape,
or the safe-output action. Non-GitHub provider items and items without
conclusive GitHub entity evidence SHALL leave `githubEntityType` absent.
When the collector enriches a GitHub issue safe-output item with a
`github_issue_status` object, the Issue record SHALL preserve its `state`,
`closed`, `state_reason`, `closed_at`, and status `observed_at` values as
`state`, `closed`, `stateReason`, `closedAt`, and `statusObservedAt`.
An item with a resolvable canonical issue or pull-request URL SHALL become an
Issue record carrying its owner, repository, number, URL, and `isPullRequest`;
every other safe-output item SHALL remain an Audit record.
For a `report_incomplete` item, the record summary SHALL preserve its concise
`reason`, falling back to `Required evidence was unavailable.` when no reason
is present. The verbose `details` field SHALL NOT be copied into the summary.
When the published evidence retains only a failed `report_incomplete` MCP tool
outcome, campaign problem diagnosis SHALL still classify the Run as
`Incomplete Evidence` and SHALL use a generic unavailable-evidence diagnosis
instead of presenting the lower-level `driver_exit` wrapper.

For `workflow_dispatch` Runs whose display title has the canonical
`workflow · owner/repository · review|live` shape, the adapter SHALL derive
both `targetRepository` and the Run's effective `rolloutMode` from that title.
The dispatched mode SHALL take precedence over workflow-level rollout defaults.

Run-owned records SHALL populate only the existing shared record fields:

```text
id
runId
timestamp
source
type
summary
status
correlationId
payloadRef
sourceSequence
safeOutputType
githubEntityType
sequence
observedAt
provenance
```

They MAY additionally populate the specialized fields declared for their record
type in `specs/dashboard-data.md` Section 12: `domain`, `decision`, and
`requestCount` for a Domain; `toolType`, `isSkill`, and `name` for a Tool; and
`owner`, `repository`, `repositoryFullName`, `number`, `url`, and
`isPullRequest` for an Issue. An Issue MAY additionally populate `state`,
`closed`, `stateReason`, `closedAt`, and `statusObservedAt` from bounded
GraphQL enrichment.

The Activity collector MAY append a schema-v2
`token_efficiency_observation` envelope only from the validated
`token-efficiency-observation` Actions artifact produced by
`optimization-token-optimizer`. The envelope SHALL join to the preceding
canonical Run by `observation.optimizerRunId` and SHALL emit exactly one
`token_efficiency.opportunity` Audit and one `token_efficiency.intervention`
Audit. These records MAY additionally retain the Section 5.5 identity,
evidence, state, disposition, variant, proposed-savings, supersession, and
attributable-Run fields needed by their Dashboard Language projections.

The artifact is the authoritative structured boundary for those fields. The
collector and adapter MUST NOT reconstruct opportunity identity, intervention
identity, disposition, or supersession from issue titles, bodies, comments, or
other display text. A matching `safe_output_item` MAY supply only the resulting
issue link by same-Run correlation.

The Activity collector MAY append a schema-v2
`token_efficiency_lifecycle_observation` envelope only from a validated
`token-efficiency-lifecycle-claim` artifact produced by
`optimization-token-intervention-tracker`. The collector SHALL correlate the
claim to exactly one optimizer observation and exactly one same-Run
`create_issue` safe-output record. An accepted claim is authoritative for the
maintainer decision only. Any implementation pull request SHALL independently
match the assigned target Repository, change the assigned Workflow path, and
use GitHub's authoritative open or merged state before the lifecycle advances.
When implementation Run IDs are supplied, the collector SHALL verify that each
Run belongs to the target Repository and the implementation pull request's head
commit before retaining it. Each observation SHALL retain its claim source ID,
schema revision, immutable generation, observed time, completeness, freshness,
and evidence links in `sourceProvenance`.
The append-only lifecycle shard SHALL retain that optimizer Run as a
`token_efficiency_run_context` envelope so lifecycle records keep their canonical
Run relationship after ordinary Activity-window pruning. This
context envelope does not represent an additional Run.
Issue titles, bodies, comments, and open or closed state MUST NOT establish
acceptance, implementation, disposition, or lineage.

## 6 `github_api_rate_limit` envelope

Each `github_api_rate_limit` envelope SHALL map to one Audit record:

| JSONL or ingestion source | Canonical Audit field |
| --- | --- |
| Collection context | `runId`, `timestamp`, `observedAt` |
| Constant `github-api` | `source` |
| Constant `github_api_rate_limit` | `type` |
| `rate_limit.host` | `correlationId` |
| `rate_limit.end.remaining` and `rate_limit.end.limit` | `summary` |
| Positive remaining capacity | `status: available` |
| Exhausted or unavailable remaining capacity | `status: exhausted` |
| JSONL source line | `payloadRef`, `sourceSequence` |

The envelope has no run identity. It SHALL be emitted only when
explicit collection context resolves an owning canonical Run. The adapter
SHALL link the Audit directly to that Run. Missing collection context SHALL
leave rate-limit records unmapped rather than assign them to an adjacent or
inferred Run.

## 7 Privacy boundary

The canonical mapping SHALL retain only fields required by existing Run,
Domain, Tool, Audit, and Issue contracts. It SHALL NOT persist complete audit objects, MCP
arguments, responses, error bodies, artifact contents, or other opaque source
payloads. It SHALL NOT query the GitHub API to fill absent operational fields.

## 8 Validation and accounting

Unsupported non-empty source schema versions SHALL fail explicitly. Unknown
record kinds in a supported source version SHALL also fail explicitly.

Ingestion results SHALL report:

```text
records
rawPayloadRecords
rawRuns
agenticRuns
recordsByKind
safeOutputItems
mappedSafeOutputItems
rateLimits
mappedRateLimits
```

Reingesting identical input and collection context SHALL preserve entity
counts and canonical IDs. It MAY append a new Transaction ledger record for
the new database ingestion operation.
