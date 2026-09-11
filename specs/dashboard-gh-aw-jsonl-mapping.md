---
title: Cached gh-aw JSONL mapping
description: Normative mapping of cached schema-v2 gh-aw JSONL into canonical dashboard data.
---

# Cached gh-aw JSONL mapping

The schema-v2 `gh-aw-logs.jsonl` source SHALL be mapped into the existing
canonical stores without adding source-shaped stores, indexes, or
relationships. The normative ingestion expression is
`dashboard/site/src/data/ingest/expressions/gh-aw-logs-v2.json`.

The mapping SHALL preserve these mandatory relationships:

```text
Workflow -> Repository
Run -> Repository and Workflow
Session -> Run
Event -> Session
```

The mapping SHALL NOT emit Package or Transaction observations. Transactions
remain the database-operation audit ledger maintained by the ingestion
coordinator. Enriched `job_details` SHALL emit canonical Job observations.

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

Run identity SHALL be:

```text
github:run:<databaseId>:attempt:<attempt>
```

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
| `gh_aw_version`, `ghAwVersion`, `cli_version`, `version`, or `aw_info.cli_version` | `ghAwVersion` |
| `engine` or `aw_info.engine_name` | `engine` |
| `engine_id` or `aw_info.engine_id` | `engineId` |
| `engine_version` or `aw_info.version` | `engineVersion` |
| `requested_model` | `requestedModel` |
| `resolved_model`, `model`, or `aw_info.model` | `resolvedModel` |
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

## 3 Job mapping

Each `job_details[]` item SHALL emit one Job belonging to the canonical Run.
Job identity SHALL use the GitHub job ID. The mapping SHALL preserve `name`,
`status`, `conclusion`, `started_at`, and `completed_at`; it SHALL derive
`durationSeconds` when both timestamps are valid. Runner fields SHALL remain
`unknown` because cached JSONL does not provide authoritative runner identity.

## 4 Agentic Session mapping

Every unique enriched Run SHALL emit one Session:

| Session field | Mapping |
| --- | --- |
| `id` | Deterministic source ID from canonical Run ID plus `agentic` |
| `runId` | Canonical Run ID |
| `kind` | `unified-operational-log` |
| `status` | Enriched `status`, otherwise `unknown` |
| `startedAt` | `started_at`, then `created_at`, then observation time |
| `completedAt` | `updated_at` only when status is `completed` |
| `jobId` | Omitted because one enriched Run can contain multiple Jobs |

## 5 Agentic Event mapping

Agentic Events SHALL use the mapped Session ID, source `gh-aw-logs`, a stable
semantic ID, the source line as `payloadRef`, and the source line-derived
sequence as `sourceSequence`.

| Source condition | Event `type` |
| --- | --- |
| Enriched Run has a start or creation time | `workflow_run_started` |
| Every enriched Run | `agent.session` with source `agent` |
| Enriched Run is completed | `workflow_run_completed` |
| Conclusion is failure or `failure_kind` exists | `workflow_run_failed` |
| Token usage or AIC exists | `workflow_run_usage` |
| `working_set` exists | `workflow_run_working_set` |
| `behavior_fingerprint` or `task_domain` exists | `workflow_run_behavior` |
| Each `agentic_assessments[]` item | `workflow_run_assessment` |
| Each `graders.results[]` item | `workflow_run_grader` |
| `safe_items_count` exists | `workflow_run_safe_outputs` |
| `comparison` exists | `workflow_run_comparison` |

Each `mcp_tool_usage.tool_calls[]` item SHALL emit a `tool.call` Event and a
correlated outcome Event. A `success` status SHALL emit `tool.result`; every
other source status SHALL emit `tool.error` while preserving that status. Both
Events SHALL use source `mcp` and the source `tool_call_id` as `correlationId`.

Audit arrays SHALL map to compact canonical Events rather than an audit-shaped
store: `key_findings` to `audit.finding`, `observability_insights` to
`audit.observability`, `recommendations` to `audit.recommendation`,
`missing_tools` to `audit.missing_tool`, `missing_data` to
`audit.missing_data`, `noops` to `audit.noop`, `mcp_failures` to
`audit.mcp_failure`, and `skill_activations` to `audit.skill_activation`.

Each `safe_outputs[]` item, or `audit.created_items[]` when `safe_outputs` is
absent, SHALL emit `safe_output.created` with source `safe-output`.

Event records SHALL populate only the existing Event model fields:

```text
id
sessionId
timestamp
source
type
summary
status
correlationId
payloadRef
sourceSequence
sequence
observedAt
provenance
```

## 6 `github_api_rate_limit` envelope

Each `github_api_rate_limit` envelope SHALL map to one Event:

| JSONL or ingestion source | Canonical Event field |
| --- | --- |
| Collection context | `sessionId`, `timestamp`, `observedAt` |
| Constant `github-api` | `source` |
| Constant `github_api_rate_limit` | `type` |
| `rate_limit.host` | `correlationId` |
| `rate_limit.end.remaining` and `rate_limit.end.limit` | `summary` |
| Positive remaining capacity | `status: available` |
| Exhausted or unavailable remaining capacity | `status: exhausted` |
| JSONL source line | `payloadRef`, `sourceSequence` |

The envelope has no run or session identity. It SHALL be emitted only when
explicit collection context resolves an owning canonical Run. The adapter
SHALL create or resolve a deterministic collection Session for that Run.
Missing collection context SHALL leave rate-limit records unmapped rather than
assign them to an adjacent or inferred Run.

## 7 Privacy boundary

The canonical mapping SHALL retain only fields required by existing Run, Job,
Session, and Event contracts. It SHALL NOT persist complete audit objects, MCP
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
sessions
events
rateLimits
mappedRateLimits
```

Reingesting identical input and collection context SHALL preserve entity
counts and canonical IDs. It MAY append a new Transaction ledger record for
the new database ingestion operation.
