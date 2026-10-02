package postgresx

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

// Stable producer fields are native; source-defined attributes remain in
// extension. Presence distinguishes missing from explicitly observed null.
var canonicalFields = []struct {
	key, column string
}{
	{"id", "id"}, {"runId", "run_id"}, {"sessionId", "session_id"},
	{"repositoryId", "repository_id"}, {"targetRepositoryId", "target_repository_id"},
	{"workflowId", "workflow_id"},
	{"status", "status"}, {"conclusion", "conclusion"}, {"event", "event"},
	{"owner", "owner"}, {"repository", "repository"}, {"name", "name"},
	{"fullName", "full_name"}, {"path", "path"}, {"visibility", "visibility"},
	{"state", "state"}, {"campaign", "campaign"}, {"campaignId", "campaign_id"},
	{"headSha", "head_sha"}, {"headBranch", "head_branch"},
	{"source", "source"}, {"sourceId", "source_id"},
	{"repositoryFullName", "repository_full_name"}, {"slug", "slug"},
	{"url", "url"}, {"type", "type"}, {"category", "category"},
	{"correlationId", "correlation_id"},
	{"description", "description"}, {"icon", "icon"}, {"mode", "mode"},
	{"domain", "domain"}, {"decision", "decision"},
	{"toolType", "tool_type"}, {"mcpServer", "mcp_server"}, {"mcpTool", "mcp_tool"},
	{"safeOutputType", "safe_output_type"}, {"githubEntityType", "github_entity_type"},
	{"summary", "summary"}, {"payloadRef", "payload_ref"},
	{"targetRepo", "target_repo"}, {"targetOrganization", "target_organization"},
	{"targetRepository", "target_repository"},
	{"rolloutMode", "rollout_mode"}, {"campaignName", "campaign_name"},
	{"campaignIcon", "campaign_icon"}, {"campaignReadmePath", "campaign_readme_path"},
	{"role", "role"},
	{"workflowPath", "workflow_path"}, {"title", "title"}, {"branch", "branch"},
	{"engine", "engine"}, {"engineVersion", "engine_version"},
	{"requestedModel", "requested_model"}, {"resolvedModel", "resolved_model"},
	{"modelId", "model_id"},
	{"agentId", "agent_id"}, {"agentVersion", "agent_version"},
	{"ghAwVersion", "gh_aw_version"}, {"engineId", "engine_id"},
	{"agentRuntime", "agent_runtime"}, {"firewallVersion", "firewall_version"},
	{"gatewayVersion", "gateway_version"}, {"classification", "classification"},
	{"failureKind", "failure_kind"}, {"failureJob", "failure_job"},
	{"failureMessage", "failure_message"}, {"failureStep", "failure_step"},
	{"failureLog", "failure_log"}, {"failureDetail", "failure_detail"},
	{"terminalOutcome", "terminal_outcome"}, {"terminalOutcomeDetail", "terminal_outcome_detail"},
	{"duration", "duration"}, {"logsPath", "logs_path"}, {"auditPath", "audit_path"},
	{"targetWorkflowPath", "target_workflow_path"}, {"opportunityId", "opportunity_id"},
	{"opportunityKind", "opportunity_kind"}, {"assignmentRunId", "assignment_run_id"},
	{"costGrain", "cost_grain"}, {"interventionId", "intervention_id"},
	{"lifecycleObservationId", "lifecycle_observation_id"},
	{"previousInterventionState", "previous_intervention_state"},
	{"interventionState", "intervention_state"},
	{"previousRecommendationDisposition", "previous_recommendation_disposition"},
	{"recommendationDisposition", "recommendation_disposition"},
	{"supersedesInterventionId", "supersedes_intervention_id"},
	{"supersededByInterventionId", "superseded_by_intervention_id"},
	{"controlVariant", "control_variant"}, {"optimizedVariant", "optimized_variant"},
	{"evidenceState", "evidence_state"}, {"missingReason", "missing_reason"},
	{"safeOutputId", "safe_output_id"}, {"safeOutputUrl", "safe_output_url"},
	{"implementationChangeId", "implementation_change_id"},
	{"implementationPullRequestUrl", "implementation_pull_request_url"},
	{"optimizerWorkflowPath", "optimizer_workflow_path"},
	{"optimizerWorkflowName", "optimizer_workflow_name"},
	{"claimRunId", "claim_run_id"}, {"actor", "actor"},
	{"sourceGraderId", "source_grader_id"}, {"sourceEvalId", "source_eval_id"},
	{"graderId", "grader_id"}, {"evalId", "eval_id"},
	{"experimentId", "experiment_id"}, {"auditId", "audit_id"},
	{"variant", "variant"}, {"graderSource", "grader_source"},
	{"displayName", "display_name"}, {"unit", "unit"}, {"direction", "direction"},
	{"exclusionReason", "exclusion_reason"}, {"evaluatorDigest", "evaluator_digest"},
	{"answer", "answer"}, {"evalResult", "eval_result"},
	{"activationSource", "activation_source"}, {"stateReason", "state_reason"},
	{"valueId", "value_id"}, {"taskDomain", "task_domain"}, {"code", "code"},
	{"grader", "grader"}, {"graderName", "grader_name"},
	{"measurementState", "measurement_state"}, {"canonicalUnit", "canonical_unit"},
	{"issueState", "issue_state"}, {"issueStateReason", "issue_state_reason"},
	{"mcpServerVersion", "mcp_server_version"},
	{"mcpProtocolVersion", "mcp_protocol_version"},
	{"minVersion", "min_version"}, {"version", "version"},
	{"currentVersion", "current_version"}, {"updateState", "update_state"},
	{"readme", "readme"}, {"readmePath", "readme_path"},
	{"registryState", "registry_state"},
	{"ghAwCurrentVersion", "gh_aw_current_version"},
	{"ghAwVersionLabel", "gh_aw_version_label"},
	{"ghAwUpdateState", "gh_aw_update_state"},
	{"admissionStatus", "admission_status"}, {"admissionReason", "admission_reason"},
	{"resource", "resource"},
	{"addCommand", "add_command"}, {"artwork", "artwork"},
	{"publisher", "publisher"}, {"ref", "ref"},
	{"registryId", "registry_id"}, {"registryName", "registry_name"},
	{"resolvedCommit", "resolved_commit"}, {"sourceCoordinate", "source_coordinate"},
	{"message", "message"}, {"error", "error"},
	{"workflow-slug", "workflow_slug"}, {"workflow-name", "workflow_name"},
	{"operational-value-role", "operational_value_role"},
	{"operational-value-name", "operational_value_name"},
	{"operational-value-unit", "operational_value_unit"},
	{"operational-value-direction", "operational_value_direction"},
	{"maturity-status", "maturity_status"}, {"adoption-at", "adoption_at"},
	{"evaluation-mode", "evaluation_mode"},
}

// Evidence may use structured answers or cost grains even though their
// definition records usually carry strings. Keep either shape in a dedicated
// native column without putting the field into the open extension.
var canonicalFlexibleText = []struct{ key, column string }{
	{"answer", "answer_json"}, {"evalResult", "eval_result_json"},
	{"costGrain", "cost_grain_json"},
}

func isCanonicalFlexibleText(key string) bool {
	for _, field := range canonicalFlexibleText {
		if key == field.key {
			return true
		}
	}
	return false
}

var canonicalTimes = []struct {
	key, column string
}{
	{"createdAt", "created_at"}, {"startedAt", "started_at"},
	{"completedAt", "completed_at"}, {"updatedAt", "updated_at"},
	{"observedAt", "observed_at"}, {"timestamp", "timestamp_at"},
	{"firstObservedAt", "first_observed_at"}, {"lastObservedAt", "last_observed_at"},
	{"resultTimestamp", "result_timestamp"}, {"statusObservedAt", "status_observed_at"},
	{"evidenceWindowStart", "evidence_window_start"},
	{"evidenceWindowEnd", "evidence_window_end"},
	{"acceptedAt", "accepted_at"}, {"implementationStartedAt", "implementation_started_at"},
	{"implementationCompletedAt", "implementation_completed_at"},
	{"rejectedAt", "rejected_at"}, {"supersededAt", "superseded_at"},
	{"issueClosedAt", "issue_closed_at"}, {"issueStatusObservedAt", "issue_status_observed_at"},
	{"resourceResetAt", "resource_reset_at"},
	{"closedAt", "closed_at"},
}

var canonicalNumbers = []struct {
	key, column string
}{
	{"attempt", "attempt"}, {"sequence", "sequence"},
	{"number", "issue_number"}, {"durationMs", "duration_ms"},
	{"requestCount", "request_count"},
	{"workerCount", "worker_count"}, {"aicTotal", "aic_total"},
	{"sourceSequence", "source_sequence"}, {"actionMinutes", "action_minutes"},
	{"aic", "aic"}, {"inputTokens", "input_tokens"}, {"outputTokens", "output_tokens"},
	{"cacheReadTokens", "cache_read_tokens"}, {"cacheWriteTokens", "cache_write_tokens"},
	{"reasoningTokens", "reasoning_tokens"}, {"githubApiCalls", "github_api_calls"},
	{"safeItemsCount", "safe_items_count"}, {"errorCount", "error_count"},
	{"agenticDurationSeconds", "agentic_duration_seconds"},
	{"firewallAllowedCalls", "firewall_allowed_calls"},
	{"firewallBlockedCalls", "firewall_blocked_calls"},
	{"mcpToolCalls", "mcp_tool_calls"}, {"mcpResponseBytes", "mcp_response_bytes"},
	{"operationalGrader", "operational_grader"},
	{"highPriorityAuditItems", "high_priority_audit_items"},
	{"mediumPriorityAuditItems", "medium_priority_audit_items"},
	{"invocationCount", "invocation_count"}, {"failedCount", "failed_count"},
	{"value", "value"}, {"threshold", "threshold"},
	{"evidenceConfidence", "evidence_confidence"},
	{"proposedSavingsAic", "proposed_savings_aic"},
	{"recommendationChurnCount", "recommendation_churn_count"},
	{"recommendationChurnRate", "recommendation_churn_rate"},
	{"optimizerRunAttempt", "optimizer_run_attempt"},
	{"claimRunAttempt", "claim_run_attempt"},
	{"baselineValue", "baseline_value"}, {"deltaFromBaseline", "delta_from_baseline"},
	{"rollup-numerator", "rollup_numerator"}, {"rollup-denominator", "rollup_denominator"},
	{"totalEvents", "total_events"}, {"totalOccurrences", "total_occurrences"},
	{"countedOccurrences", "counted_occurrences"},
	{"suppressedOccurrences", "suppressed_occurrences"},
	{"linkedInvocations", "linked_invocations"},
	{"unattributedOccurrences", "unattributed_occurrences"},
	{"totalTokens", "total_tokens"}, {"turns", "turns"},
	{"toolCalls", "tool_calls"}, {"latencyMs", "latency_ms"},
	{"totalRunAic", "total_run_aic"}, {"frictionRatio", "friction_ratio"},
	{"requestBytes", "request_bytes"}, {"responseBytes", "response_bytes"},
	{"maxRepositories", "max_repositories"}, {"rolloutPercent", "rollout_percent"},
	{"monthlyAiCreditBudget", "monthly_ai_credit_budget"},
	{"aiCreditAllowance", "ai_credit_allowance"},
	{"inventoryWarnings", "inventory_warnings"},
	{"maxAiCredits", "max_ai_credits"},
	{"campaignAiCreditAllowance", "campaign_ai_credit_allowance"},
	{"campaignWorkerCount", "campaign_worker_count"},
	{"campaignInventoryWarnings", "campaign_inventory_warnings"},
	{"resourceWaitHours", "resource_wait_hours"},
	{"registryPrecedence", "registry_precedence"},
	{"stars", "stars"}, {"forks", "forks"},
}

// PostgreSQL NUMERIC preserves ordinary decimal scale, but normalizes
// exponent notation and negative zero; exceptional values need the lexeme.
func numericRawLexeme(text string, native any) any {
	if native == nil || strings.ContainsAny(text, "eE") || text == "-0" ||
		(strings.HasPrefix(text, "-0.") && strings.Trim(text[3:], "0") == "") {
		return text
	}
	return nil
}

var canonicalBooleans = []struct {
	key, column string
}{
	{"enabled", "enabled"}, {"isSkill", "is_skill"},
	{"isPullRequest", "is_pull_request"},
	{"closed", "closed"}, {"intentionalFailure", "intentional_failure"},
	{"included", "included"},
	{"issueClosed", "issue_closed"}, {"derived", "derived"},
	{"eventsTruncated", "events_truncated"},
	{"experimental", "experimental"}, {"inventoryReady", "inventory_ready"},
}

var canonicalArrays = []struct{ key, column string }{
	{"attributableRunIds", "attributable_run_ids"},
	{"implementationRunIds", "implementation_run_ids"},
	{"contents", "contents"},
}

var canonicalObjects = []struct{ key, column string }{
	{"tokenUsage", "token_usage"},
	{"ambientContext", "ambient_context"}, {"workingSet", "working_set"},
	{"behaviorFingerprint", "behavior_fingerprint"}, {"comparison", "comparison"},
	{"agenticAssessments", "agentic_assessments"}, {"graders", "graders"},
	{"context", "context"}, {"evidenceProvenance", "evidence_provenance"},
	{"sourceProvenance", "source_provenance"},
	{"implementation", "implementation"}, {"observation", "observation"},
	{"diagnostics", "diagnostics"}, {"metrics", "metrics"},
	{"sources", "sources"}, {"dimensionStates", "dimension_states"},
	{"uncertainty", "uncertainty"}, {"drivers", "drivers"},
	{"groups", "groups"}, {"events", "events"},
	{"unmeasuredDrivers", "unmeasured_drivers"},
	{"workers", "workers"}, {"targets", "targets"},
	{"intelligenceDeclaration", "intelligence_declaration"},
	{"ghAwMetadata", "gh_aw_metadata"}, {"ghAwManifest", "gh_aw_manifest"},
	{"data", "data"}, {"logsPayload", "logs_payload"},
}

// Producer identifiers may be numeric or textual; do not stringify a JSON
// number or turn a textual identifier into a number on round-trip.
var canonicalIdentifiers = []struct {
	key, column string
}{
	{"githubId", "github_id"}, {"githubRunId", "github_run_id"},
}

var canonicalLinks = []struct {
	key, column string
}{
	{"organizationLink", "organization_href"}, {"repositoryLink", "repository_href"},
	{"workflowLink", "workflow_href"}, {"runLink", "run_href"},
	{"campaignLink", "campaign_href"}, {"externalLink", "external_href"},
}

// Mirrors ingest.collections. Inventory names, even names beginning with "$",
// are not implicitly canonical and retain their arbitrary source shape.
var canonicalCollections = map[string]bool{
	"$campaigns": true, "$repositories": true, "$workflows": true, "$runs": true,
	"$jobs": true, "$sessions": true, "$events": true,
	"$domains": true, "$tools": true, "$skills": true, "$friction": true,
	"$audits": true, "$issues": true, "$operationalValues": true,
	"$experiments": true, "$experimentAssignments": true,
	"$graders": true, "$graderObservations": true,
	"$evals": true, "$evalObservations": true,
	"$marketplacePackages": true,
}

func isCanonicalSource(name string) bool { return canonicalCollections[name] }

func isCanonicalTextField(name string) bool {
	for _, field := range canonicalFields {
		if field.key == name {
			return true
		}
	}
	return false
}

func isCanonicalBoolean(name string) bool {
	for _, field := range canonicalBooleans {
		if field.key == name {
			return true
		}
	}
	return false
}

func isCanonicalTime(name string) bool {
	for _, field := range canonicalTimes {
		if field.key == name {
			return true
		}
	}
	return false
}

func canonicalFallbackReason(row model.Row) string {
	for _, field := range canonicalFields {
		if value := row[field.key]; value != nil {
			if _, ok := value.(string); !ok {
				if field.key == "id" {
					if _, ok := value.(json.Number); ok {
						continue
					}
				}
				if isCanonicalFlexibleText(field.key) {
					switch value.(type) {
					case map[string]any, []any:
						continue
					}
				}
				return fmt.Sprintf("known field %s has unsupported type %T", field.key, value)
			}
		}
	}
	for _, field := range canonicalTimes {
		if value := row[field.key]; value != nil {
			text, ok := value.(string)
			if !ok {
				return fmt.Sprintf("known timestamp %s has unsupported type %T", field.key, value)
			}
			if _, err := time.Parse(time.RFC3339Nano, text); err != nil {
				return fmt.Sprintf("known timestamp %s has invalid format", field.key)
			}
		}
	}
	for _, field := range canonicalNumbers {
		if value := row[field.key]; value != nil {
			if _, ok := value.(json.Number); !ok {
				if field.key == "value" {
					if _, ok := value.(string); ok {
						continue
					}
				}
				return fmt.Sprintf("known number %s has unsupported type %T", field.key, value)
			}
		}
	}
	for _, field := range canonicalBooleans {
		if value := row[field.key]; value != nil {
			if _, ok := value.(bool); !ok {
				return fmt.Sprintf("known boolean %s has unsupported type %T", field.key, value)
			}
		}
	}
	for _, field := range canonicalIdentifiers {
		switch value := row[field.key].(type) {
		case nil, string, json.Number:
		default:
			return fmt.Sprintf("known identifier %s has unsupported type %T", field.key, value)
		}
	}
	for _, field := range canonicalLinks {
		if value := row[field.key]; value != nil {
			if field.key == "runLink" {
				if _, ok := value.(string); ok {
					continue
				}
			}
			link, ok := value.(map[string]any)
			if !ok {
				return fmt.Sprintf("known link %s has unsupported shape", field.key)
			}
			if _, ok := link["href"].(string); !ok {
				return fmt.Sprintf("known link %s has unsupported href", field.key)
			}
			for key, part := range link {
				if key != "href" && key != "relation" && key != "label" {
					return fmt.Sprintf("known link %s has unsupported property %s", field.key, key)
				}
				if part != nil {
					if _, ok := part.(string); !ok {
						return fmt.Sprintf("known link %s has unsupported property %s", field.key, key)
					}
				}
			}
		}
	}
	for _, field := range canonicalArrays {
		if value := row[field.key]; value != nil {
			items, ok := value.([]any)
			if !ok {
				return fmt.Sprintf("known array %s has unsupported type %T", field.key, value)
			}
			for _, item := range items {
				if _, ok := item.(string); !ok {
					return fmt.Sprintf("known array %s contains non-string", field.key)
				}
			}
		}
	}
	for _, field := range canonicalObjects {
		if value := row[field.key]; value != nil {
			if native, ok := nativeNestedFields[field.key]; ok {
				if err := native.validate(value); err != nil {
					return err.Error()
				}
			}
			switch value.(type) {
			case map[string]any, []any:
			default:
				return fmt.Sprintf("known structured field %s has unsupported type %T", field.key, value)
			}
		}
	}
	if value, present := row["provenance"]; present {
		if _, ok := canonicalProvenance(value); !ok {
			return "known provenance has unsupported shape"
		}
	}
	return "known field has unsupported representation"
}

func canonicalProvenance(value any) ([]any, bool) {
	parts := make([]any, 7)
	parts[5] = make([]string, 0)
	if value == nil {
		parts[6] = true
		return parts, true
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil, false
	}
	present := make([]string, 0, len(object))
	for key, value := range object {
		switch key {
		case "source", "sourceId", "sourceRevision", "observedAt":
		default:
			return nil, false
		}
		present = append(present, key)
		if value == nil {
			continue
		}
		text, ok := value.(string)
		if !ok {
			return nil, false
		}
		switch key {
		case "source":
			parts[0] = text
		case "sourceId":
			parts[1] = text
		case "sourceRevision":
			parts[4] = text
		case "observedAt":
			instant, err := time.Parse(time.RFC3339Nano, text)
			if err != nil {
				return nil, false
			}
			parts[2] = instant
			if instant.Nanosecond()%1000 != 0 || instant.UTC().Format(time.RFC3339Nano) != text {
				parts[3] = text
			}
		}
	}
	sort.Strings(present)
	parts[5] = present
	parts[6] = false
	return parts, true
}

func decodeCanonicalProvenance(source, sourceID, observedAt, sourceRevision sql.NullString,
	present []string, isNull bool) (any, error) {
	if isNull {
		if len(present) != 0 {
			return nil, errors.New("null canonical provenance has nested fields")
		}
		return nil, nil
	}
	result := make(map[string]any, len(present))
	values := map[string]sql.NullString{
		"source": source, "sourceId": sourceID, "observedAt": observedAt,
		"sourceRevision": sourceRevision,
	}
	for _, key := range present {
		value, ok := values[key]
		if !ok {
			return nil, fmt.Errorf("invalid canonical provenance key %q", key)
		}
		if value.Valid {
			result[key] = value.String
		} else {
			result[key] = nil
		}
	}
	return result, nil
}

func timestampReadExpression(column string) string {
	return `COALESCE(` + column + `_raw, ` + timestampNativeReadExpression(column) + `)`
}

func timestampNativeReadExpression(column string) string {
	utc := "(" + column + " AT TIME ZONE 'UTC')"
	return `CASE WHEN ` + column + ` IS NULL THEN NULL ELSE
		to_char(` + utc + `, 'YYYY-MM-DD"T"HH24:MI:SS') ||
		CASE WHEN to_char(` + utc + `, 'US') = '000000' THEN '' ELSE
			'.' || rtrim(to_char(` + utc + `, 'US'), '0') END || 'Z' END`
}

func canonicalRow(row model.Row) (fields []string, values []any, extension string, ok bool, err error) {
	rest := make(model.Row, len(row))
	fields = make([]string, 0, len(row))
	for k, v := range row {
		rest[k] = v
	}
	values = make([]any, 0)
	for _, field := range canonicalFields {
		v, present := rest[field.key]
		if present && v != nil {
			text, isString := v.(string)
			if !isString {
				if field.key == "id" {
					number, numeric := v.(json.Number)
					if !numeric {
						return nil, nil, "", false, nil
					}
					values = append(values, string(number))
				} else {
					if !isCanonicalFlexibleText(field.key) {
						return nil, nil, "", false, nil
					}
					switch v.(type) {
					case map[string]any, []any:
						values = append(values, nil)
					default:
						return nil, nil, "", false, nil
					}
				}
			} else {
				values = append(values, text)
			}
		} else {
			values = append(values, nil)
		}
		if present {
			fields = append(fields, field.key)
			delete(rest, field.key)
		}
	}
	for _, field := range canonicalTimes {
		v, present := rest[field.key]
		if present && v != nil {
			text, isString := v.(string)
			if !isString {
				return nil, nil, "", false, nil
			}
			instant, parseErr := time.Parse(time.RFC3339Nano, text)
			if parseErr != nil {
				//nolint:nilerr // Invalid known shapes trigger the caller's fail-closed or legacy fallback.
				return nil, nil, "", false, nil
			}
			var lexical any
			if instant.Nanosecond()%1000 != 0 || instant.UTC().Format(time.RFC3339Nano) != text {
				lexical = text
			}
			values = append(values, instant, lexical)
		} else {
			values = append(values, nil, nil)
		}
		if present {
			fields = append(fields, field.key)
			delete(rest, field.key)
		}
	}
	for _, field := range canonicalNumbers {
		v, present := rest[field.key]
		if present && v != nil {
			number, valid := v.(json.Number)
			if !valid {
				if field.key != "value" {
					return nil, nil, "", false, nil
				}
				if _, isString := v.(string); !isString {
					return nil, nil, "", false, nil
				}
				values = append(values, nil, nil)
			} else {
				text := string(number)
				_, parseErr := strconv.ParseFloat(text, 64)
				if parseErr != nil && !strings.Contains(parseErr.Error(), "value out of range") {
					return nil, nil, "", false, nil
				}
				var numeric any
				if len(text) <= 1000 {
					exponent := 0
					var exponentErr error
					if pos := strings.IndexAny(text, "eE"); pos >= 0 {
						exponent, exponentErr = strconv.Atoi(text[pos+1:])
					}
					if exponentErr == nil && exponent >= -1000 && exponent <= 1000 {
						numeric = text
					}
				}
				values = append(values, numeric, numericRawLexeme(text, numeric))
			}
		} else {
			values = append(values, nil, nil)
		}
		if present {
			fields = append(fields, field.key)
			delete(rest, field.key)
		}
	}
	for _, field := range canonicalBooleans {
		v, present := rest[field.key]
		if present && v != nil {
			boolean, isBoolean := v.(bool)
			if !isBoolean {
				return nil, nil, "", false, nil
			}
			values = append(values, boolean)
		} else {
			values = append(values, nil)
		}
		if present {
			fields = append(fields, field.key)
			delete(rest, field.key)
		}
	}
	for _, field := range canonicalIdentifiers {
		v, present := rest[field.key]
		switch identifier := v.(type) {
		case nil:
			values = append(values, nil, nil, nil)
		case string:
			values = append(values, identifier, "string", nil)
		case json.Number:
			text := string(identifier)
			var native any
			if len(text) <= 1000 {
				exponent := 0
				var exponentErr error
				if pos := strings.IndexAny(text, "eE"); pos >= 0 {
					exponent, exponentErr = strconv.Atoi(text[pos+1:])
				}
				if exponentErr == nil && exponent >= -1000 && exponent <= 1000 {
					native = text
				}
			}
			values = append(values, numericRawLexeme(text, native), "number", native)
		default:
			return nil, nil, "", false, nil
		}
		if present {
			fields = append(fields, field.key)
			delete(rest, field.key)
		}
	}
	for _, field := range canonicalLinks {
		v, present := rest[field.key]
		var href, relation, label any
		var parts []string
		if v == nil {
		} else if text, isString := v.(string); isString && field.key == "runLink" {
			href = text
		} else {
			link, isObject := v.(map[string]any)
			if !isObject {
				return nil, nil, "", false, nil
			}
			var isString bool
			href, isString = link["href"].(string)
			if !isString {
				return nil, nil, "", false, nil
			}
			for key, part := range link {
				if key != "href" && key != "relation" && key != "label" {
					return nil, nil, "", false, nil
				}
				if part != nil {
					if _, ok := part.(string); !ok {
						return nil, nil, "", false, nil
					}
				}
				parts = append(parts, key)
			}
			sort.Strings(parts)
			relation, label = link["relation"], link["label"]
		}
		values = append(values, href, relation, label, parts)
		if field.key == "runLink" {
			kind := any(nil)
			if v != nil {
				kind = "object"
				if _, isString := v.(string); isString {
					kind = "string"
				}
			}
			values = append(values, kind)
		}
		if present {
			fields = append(fields, field.key)
			delete(rest, field.key)
		}
	}
	for _, field := range canonicalArrays {
		v, present := rest[field.key]
		var stringsValue []string
		if v != nil {
			items, isArray := v.([]any)
			if !isArray {
				return nil, nil, "", false, nil
			}
			stringsValue = make([]string, len(items))
			for i, item := range items {
				var isString bool
				stringsValue[i], isString = item.(string)
				if !isString {
					return nil, nil, "", false, nil
				}
			}
		}
		values = append(values, stringsValue)
		if present {
			fields = append(fields, field.key)
			delete(rest, field.key)
		}
	}
	for _, field := range canonicalObjects {
		v, present := rest[field.key]
		var encoded any
		if v != nil {
			if native, ok := nativeNestedFields[field.key]; ok {
				if err := native.validate(v); err != nil {
					return nil, nil, "", false, err
				}
			}
			switch v.(type) {
			case map[string]any, []any:
			default:
				return nil, nil, "", false, nil
			}
			raw, marshalErr := json.Marshal(v)
			if marshalErr != nil {
				return nil, nil, "", false, marshalErr
			}
			encoded = string(raw)
		}
		values = append(values, encoded)
		if present {
			fields = append(fields, field.key)
			delete(rest, field.key)
		}
	}
	for _, field := range canonicalFlexibleText {
		var encoded any
		switch value := row[field.key].(type) {
		case map[string]any, []any:
			raw, marshalErr := json.Marshal(value)
			if marshalErr != nil {
				return nil, nil, "", false, marshalErr
			}
			encoded = string(raw)
		}
		values = append(values, encoded)
	}
	var valueText, valueKind any
	switch value := row["value"].(type) {
	case string:
		valueText, valueKind = value, "string"
	case json.Number:
		valueKind = "number"
	}
	values = append(values, valueText, valueKind)
	var idKind any
	switch row["id"].(type) {
	case string:
		idKind = "string"
	case json.Number:
		idKind = "number"
	}
	values = append(values, idKind)
	provenanceValue, present := row["provenance"]
	provenance, supported := canonicalProvenance(provenanceValue)
	if !supported {
		return nil, nil, "", false, nil
	}
	if !present {
		provenance[6] = false
	}
	values = append(values, provenance...)
	if present {
		fields = append(fields, "provenance")
		delete(rest, "provenance")
	}
	sort.Strings(fields)
	if len(rest) == 0 {
		return fields, values, "", true, nil
	}
	raw, err := json.Marshal(rest)
	if err != nil {
		return nil, nil, "", false, err
	}
	return fields, values, string(raw), true, nil
}

func insertCanonical(ctx context.Context, tx *sql.Tx, namespace, name string, ordinal int64, row model.Row) (bool, error) {
	fields, values, extension, ok, err := canonicalRow(row)
	if err != nil || !ok {
		return ok, err
	}
	columns := []string{"namespace", "source_name", "ordinal", "present", "extension"}
	var storedExtension any
	if extension != "" {
		storedExtension = extension
	}
	args := make([]any, 0, 5+len(values))
	args = append(args, namespace, name, ordinal, fields, storedExtension)
	for _, field := range canonicalFields {
		columns = append(columns, field.column)
	}
	for _, field := range canonicalTimes {
		columns = append(columns, field.column, field.column+"_raw")
	}
	for _, field := range canonicalNumbers {
		columns = append(columns, field.column, field.column+"_raw")
	}
	for _, field := range canonicalBooleans {
		columns = append(columns, field.column)
	}
	for _, field := range canonicalIdentifiers {
		columns = append(columns, field.column, field.column+"_kind", field.column+"_numeric")
	}
	for _, field := range canonicalLinks {
		columns = append(columns, field.column, field.column+"_relation", field.column+"_label", field.column+"_present")
		if field.key == "runLink" {
			columns = append(columns, "run_href_kind")
		}
	}
	for _, field := range canonicalArrays {
		columns = append(columns, field.column)
	}
	for _, field := range canonicalObjects {
		columns = append(columns, field.column)
	}
	for _, field := range canonicalFlexibleText {
		columns = append(columns, field.column)
	}
	columns = append(columns, "value_text", "value_kind", "id_kind")
	columns = append(columns, "provenance_source", "provenance_source_id",
		"provenance_observed_at", "provenance_observed_at_raw",
		"provenance_source_revision", "provenance_present", "provenance_null")
	args = append(args, values...)
	placeholders := make([]string, len(args))
	for i := range args {
		placeholders[i] = fmt.Sprintf("$%d", i+1)
	}
	for i, column := range columns {
		for _, field := range canonicalObjects {
			if column == field.column {
				if native, ok := nativeNestedFields[field.key]; ok {
					placeholders[i] = native.writeSQL(placeholders[i]+"::json", 0)
				}
			}
		}
	}
	// The schema-owned identifiers above are constants, not user input.
	// #nosec G202 -- column names come only from the static native field catalogue.
	statement := `INSERT INTO cao_canonical_rows (` + strings.Join(columns, ",") +
		`) VALUES (` + strings.Join(placeholders, ",") + `)`
	_, err = tx.ExecContext(ctx, statement, args...)
	return true, err
}

func readCanonical(ctx context.Context, tx *sql.Tx, namespace, name string) ([]model.Row, bool, error) {
	var count int
	err := tx.QueryRowContext(ctx, `SELECT count(*) FROM cao_canonical_rows
		WHERE namespace = $1 AND source_name = $2`, namespace, name).Scan(&count)
	if err != nil || count == 0 {
		return nil, false, err
	}
	return readCanonicalData(ctx, tx, namespace, name, count)
}

func canonicalFilter(namespace, name string, filter map[string]any) (string, []any) {
	where := `namespace = $1 AND source_name = $2`
	args := []any{namespace, name}
	for _, field := range canonicalFields {
		if value, ok := filter[field.key]; ok {
			args = append(args, value)
			where += fmt.Sprintf(" AND %s = $%d", field.column, len(args))
		}
	}
	for _, field := range canonicalTimes {
		if value, ok := filter[field.key]; ok {
			args = append(args, value)
			where += fmt.Sprintf(" AND %s = $%d", timestampReadExpression(field.column), len(args))
		}
	}
	for _, field := range canonicalBooleans {
		if value, ok := filter[field.key]; ok {
			args = append(args, value)
			where += fmt.Sprintf(" AND %s = $%d", field.column, len(args))
		}
	}
	for _, field := range canonicalNumbers {
		if value, ok := filter[field.key]; ok {
			args = append(args, fmt.Sprint(value))
			if field.key == "value" {
				where += fmt.Sprintf(" AND (COALESCE(value_raw, value::text) = $%d", len(args))
				if _, stringValue := value.(string); stringValue {
					where += fmt.Sprintf(" OR (value_kind = 'string' AND value_text = $%d)", len(args))
				}
				where += ")"
			} else {
				where += fmt.Sprintf(" AND COALESCE(%s_raw, %s::text) = $%d",
					field.column, field.column, len(args))
			}
		}
	}
	return where, args
}

func (r *readTransaction) canonicalPlanRows(ctx context.Context, raw string, filters map[string]any,
	selected []query.SelectedField, count int, remaining int64, queryID string) ([]model.Row, error) {
	where, args := canonicalFilter(r.store.namespace, raw, filters)
	if len(selected) == 0 {
		// Filter and limit run in PostgreSQL, not against the materialized
		// source. This path reconstructs only the bounded result rows.
		columns := []string{"present", "extension"}
		for _, field := range canonicalFields {
			columns = append(columns, field.column)
		}
		for _, field := range canonicalTimes {
			columns = append(columns, timestampReadExpression(field.column))
		}
		for _, field := range canonicalNumbers {
			columns = append(columns, `COALESCE(`+field.column+`_raw, `+field.column+`::text)`)
		}
		for _, field := range canonicalBooleans {
			columns = append(columns, field.column)
		}
		for _, field := range canonicalIdentifiers {
			columns = append(columns, `COALESCE(`+field.column+`, `+field.column+`_numeric::text)`, field.column+"_kind")
		}
		for _, field := range canonicalLinks {
			columns = append(columns, field.column, field.column+"_relation",
				field.column+"_label", field.column+"_present")
			if field.key == "runLink" {
				columns = append(columns, "run_href_kind")
			}
		}
		for _, field := range canonicalArrays {
			columns = append(columns, field.column)
		}
		for _, field := range canonicalObjects {
			columns = append(columns, nestedReadExpression(field.key, field.column))
		}
		for _, field := range canonicalFlexibleText {
			columns = append(columns, field.column+"::text")
		}
		columns = append(columns, "value_text", "value_kind", "id_kind")
		columns = append(columns, "provenance_source", "provenance_source_id",
			timestampReadExpression("provenance_observed_at"),
			"provenance_source_revision", "provenance_present", "provenance_null")
		args = append(args, count+1)
		// #nosec G202 -- columns and predicates are built from static native field definitions.
		rows, err := r.tx.QueryContext(ctx, `SELECT `+strings.Join(columns, ",")+`
						FROM cao_canonical_rows WHERE `+where+` ORDER BY ordinal LIMIT $`+fmt.Sprint(len(args)), args...)
		if err != nil {
			return nil, err
		}
		defer func() { _ = rows.Close() }()
		result := make([]model.Row, 0, count)
		var size int64
		for rows.Next() {
			if len(result) == count {
				return nil, fmt.Errorf("postgres plan row count changed")
			}
			var present []string
			var extension sql.NullString
			values := make([]sql.NullString, len(canonicalFields)+len(canonicalTimes)+len(canonicalNumbers))
			booleanValues := make([]sql.NullBool, len(canonicalBooleans))
			identifierValues := make([]sql.NullString, 2*len(canonicalIdentifiers))
			linkValues := make([]sql.NullString, 3*len(canonicalLinks))
			linkPresent := make([][]string, len(canonicalLinks))
			arrayValues := make([][]string, len(canonicalArrays))
			objectValues := make([]sql.NullString, len(canonicalObjects))
			flexibleValues := make([]sql.NullString, len(canonicalFlexibleText))
			var valueText, valueKind, idKind sql.NullString
			var provenanceSource, provenanceID, provenanceObservedAt, provenanceRevision sql.NullString
			var provenancePresent []string
			var provenanceNull bool
			var runLinkKind sql.NullString
			dest := []any{&present, &extension}
			for i := range values {
				dest = append(dest, &values[i])
			}
			for i := range booleanValues {
				dest = append(dest, &booleanValues[i])
			}
			for i := range identifierValues {
				dest = append(dest, &identifierValues[i])
			}
			for i := range canonicalLinks {
				dest = append(dest, &linkValues[3*i], &linkValues[3*i+1],
					&linkValues[3*i+2], &linkPresent[i])
				if canonicalLinks[i].key == "runLink" {
					dest = append(dest, &runLinkKind)
				}
			}
			for i := range arrayValues {
				dest = append(dest, &arrayValues[i])
			}
			for i := range objectValues {
				dest = append(dest, &objectValues[i])
			}
			for i := range flexibleValues {
				dest = append(dest, &flexibleValues[i])
			}
			dest = append(dest, &valueText, &valueKind, &idKind)
			dest = append(dest, &provenanceSource, &provenanceID, &provenanceObservedAt,
				&provenanceRevision, &provenancePresent, &provenanceNull)
			if err := rows.Scan(dest...); err != nil {
				return nil, err
			}
			row, err := decodeCanonicalExtension(extension)
			if err != nil {
				return nil, err
			}
			for _, key := range present {
				if key == "provenance" {
					row[key], err = decodeCanonicalProvenance(provenanceSource, provenanceID,
						provenanceObservedAt, provenanceRevision, provenancePresent, provenanceNull)
					if err != nil {
						return nil, err
					}
				}
			}
			for _, key := range present {
				found := false
				for i, field := range canonicalFields {
					if key == field.key {
						found = true
						if values[i].Valid {
							row[key] = values[i].String
						} else {
							row[key] = nil
						}
						if key == "id" && values[i].Valid && idKind.String == "number" {
							row[key] = json.Number(values[i].String)
						}
						for j, flex := range canonicalFlexibleText {
							if key == flex.key && flexibleValues[j].Valid {
								var decoded any
								if err := decodeJSON([]byte(flexibleValues[j].String), &decoded); err != nil {
									return nil, err
								}
								row[key] = decoded
							}
						}
						break
					}
				}
				if found {
					continue
				}
				for i, field := range canonicalTimes {
					if key == field.key {
						if values[len(canonicalFields)+i].Valid {
							row[key] = values[len(canonicalFields)+i].String
						} else {
							row[key] = nil
						}
						found = true
						break
					}
				}
				if found {
					continue
				}
				for i, field := range canonicalNumbers {
					if key == field.key {
						raw := values[len(canonicalFields)+len(canonicalTimes)+i]
						if raw.Valid {
							row[key] = json.Number(raw.String)
						} else {
							row[key] = nil
						}
						if key == "value" && valueKind.String == "string" {
							row[key] = valueText.String
						}
						found = true
						break
					}
				}
				if found {
					continue
				}
				for i, field := range canonicalBooleans {
					if key == field.key {
						if booleanValues[i].Valid {
							row[key] = booleanValues[i].Bool
						} else {
							row[key] = nil
						}
						found = true
						break
					}
				}
				if found {
					continue
				}
				for i, field := range canonicalIdentifiers {
					if key == field.key {
						row[key] = decodeCanonicalIdentifier(identifierValues[2*i], identifierValues[2*i+1])
						found = true
						break
					}
				}
				if found {
					continue
				}
				for i, field := range canonicalLinks {
					if key == field.key {
						value, err := decodeCanonicalLinkValue(linkValues[3*i], linkValues[3*i+1],
							linkValues[3*i+2], linkPresent[i],
							field.key == "runLink" && runLinkKind.String == "string")
						if err != nil {
							return nil, err
						}
						row[key] = value
						found = true
						break
					}
				}
				if found {
					continue
				}
				for i, field := range canonicalArrays {
					if key == field.key {
						if arrayValues[i] == nil {
							row[key] = nil
						} else {
							items := make([]any, len(arrayValues[i]))
							for j, value := range arrayValues[i] {
								items[j] = value
							}
							row[key] = items
						}
						found = true
						break
					}
				}
				if found {
					continue
				}
				for i, field := range canonicalObjects {
					if key == field.key {
						if objectValues[i].Valid {
							var value any
							if err := decodeJSON([]byte(objectValues[i].String), &value); err != nil {
								return nil, err
							}
							row[key] = value
						} else {
							row[key] = nil
						}
						break
					}
				}
			}
			size += query.EstimateRowsBytes([]model.Row{row})
			if size > remaining {
				return nil, &query.PlanLimitError{QueryID: queryID, Boundary: query.BoundaryRetainedBytes}
			}
			result = append(result, row)
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
		if len(result) != count {
			return nil, fmt.Errorf("postgres plan row count changed")
		}
		return result, nil
	}
	// SQL projects both relational fields and open extension attributes.
	expressions := make([]string, len(selected))
	for i, field := range selected {
		column := ""
		for _, known := range canonicalFields {
			if field.Field == known.key {
				column = known.column
			}
		}
		for _, known := range canonicalTimes {
			if field.Field == known.key {
				column = timestampReadExpression(known.column)
			}
		}
		for _, known := range canonicalNumbers {
			if field.Field == known.key {
				column = known.column + "_raw"
			}
		}
		for _, known := range canonicalBooleans {
			if field.Field == known.key {
				column = known.column
			}
		}
		identifier := false
		for _, known := range canonicalIdentifiers {
			if field.Field == known.key {
				column, identifier = known.column, true
			}
		}
		link := false
		for _, known := range canonicalLinks {
			if field.Field == known.key {
				column, link = known.column, true
			}
		}
		array := false
		for _, known := range canonicalArrays {
			if field.Field == known.key {
				column, array = known.column, true
			}
		}
		object := false
		for _, known := range canonicalObjects {
			if field.Field == known.key {
				column, object = known.column, true
			}
		}
		args = append(args, field.Field)
		if field.Field == "provenance" {
			expressions[i] = fmt.Sprintf(`CASE WHEN $%d = ANY(present) THEN
				CASE WHEN provenance_null THEN 'null' ELSE
					(SELECT COALESCE(json_object_agg(key, value::json)::text, '{}')
					FROM (VALUES
						('source', CASE WHEN 'source' = ANY(provenance_present)
							THEN COALESCE(to_json(provenance_source)::text, 'null') END),
						('sourceId', CASE WHEN 'sourceId' = ANY(provenance_present)
							THEN COALESCE(to_json(provenance_source_id)::text, 'null') END),
						('observedAt', CASE WHEN 'observedAt' = ANY(provenance_present)
							THEN COALESCE(to_json(%s)::text, 'null') END),
						('sourceRevision', CASE WHEN 'sourceRevision' = ANY(provenance_present)
							THEN COALESCE(to_json(provenance_source_revision)::text, 'null') END)
					) AS parts(key, value) WHERE value IS NOT NULL)
				END END`, len(args), timestampReadExpression("provenance_observed_at"))
			continue
		}
		if column != "" {
			if link {
				plain := "FALSE"
				if field.Field == "runLink" {
					plain = "run_href_kind = 'string'"
				}
				expressions[i] = fmt.Sprintf(`CASE WHEN $%d = ANY(present) THEN
					CASE WHEN %s IS NULL THEN 'null'
					WHEN %s THEN to_json(%s)::text
					ELSE (SELECT json_object_agg(key, value::json)::text FROM
						(VALUES ('href', to_json(%s)::text),
							('relation', CASE WHEN 'relation' = ANY(%s_present)
								THEN COALESCE(to_json(%s_relation)::text, 'null') END),
							('label', CASE WHEN 'label' = ANY(%s_present)
								THEN COALESCE(to_json(%s_label)::text, 'null') END))
						AS parts(key, value) WHERE value IS NOT NULL) END END`,
					len(args), column, plain, column, column, column, column, column, column)
			} else if field.Field == "id" {
				expressions[i] = fmt.Sprintf(`CASE WHEN $%d = ANY(present) THEN
					CASE WHEN id_kind = 'number' THEN COALESCE(id, 'null')
					ELSE COALESCE(to_json(id)::text, 'null') END END`, len(args))
			} else if _, native := nativeNestedFields[field.Field]; native {
				expressions[i] = fmt.Sprintf(`CASE WHEN $%d = ANY(present) THEN %s END`,
					len(args), nestedReadExpression(field.Field, column))
			} else if array || object {
				expressions[i] = fmt.Sprintf(`CASE WHEN $%d = ANY(present) THEN COALESCE(to_json(%s)::text, 'null') END`,
					len(args), column)
			} else if isCanonicalFlexibleText(field.Field) {
				expressions[i] = fmt.Sprintf(`CASE WHEN $%d = ANY(present) THEN COALESCE(%s_json::text,
					to_json(%s)::text, 'null') END`, len(args), column, column)
			} else if identifier {
				expressions[i] = fmt.Sprintf(`CASE WHEN $%d = ANY(present) THEN
					CASE WHEN %s_kind = 'number' THEN COALESCE(%s, %s_numeric::text, 'null')
					ELSE COALESCE(to_json(%s)::text, 'null') END END`,
					len(args), column, column, column, column)
			} else if numeric := isCanonicalNumber(field.Field); numeric {
				native := strings.TrimSuffix(column, "_raw")
				if field.Field == "value" {
					expressions[i] = fmt.Sprintf(`CASE WHEN $%d = ANY(present) THEN
						CASE WHEN value_kind = 'string' THEN to_json(value_text)::text
						ELSE COALESCE(%s, %s::text, 'null') END END`, len(args), column, native)
				} else {
					expressions[i] = fmt.Sprintf(`CASE WHEN $%d = ANY(present) THEN
						COALESCE(%s, %s::text, 'null') END`, len(args), column, native)
				}
			} else {
				expressions[i] = fmt.Sprintf(`CASE WHEN $%d = ANY(present) THEN COALESCE(to_json(%s)::text, 'null') END`, len(args), column)
			}
		} else {
			expressions[i] = fmt.Sprintf(`(extension -> $%d)::text`, len(args))
		}
	}
	args = append(args, count+1)
	// #nosec G202 -- expressions and predicates are built from static native field definitions.
	rows, err := r.tx.QueryContext(ctx, `SELECT `+strings.Join(expressions, ",")+`
					FROM cao_canonical_rows WHERE `+where+` ORDER BY ordinal LIMIT $`+fmt.Sprint(len(args)), args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	result := make([]model.Row, 0, count)
	var size int64
	for rows.Next() {
		if len(result) == count {
			return nil, fmt.Errorf("postgres plan row count changed")
		}
		values := make([]sql.NullString, len(selected))
		dest := make([]any, len(selected))
		for i := range dest {
			dest[i] = &values[i]
		}
		if err := rows.Scan(dest...); err != nil {
			return nil, err
		}
		row := make(model.Row)
		for i, field := range selected {
			if !values[i].Valid {
				continue
			}
			var value any
			if err := decodeJSON([]byte(values[i].String), &value); err != nil {
				return nil, err
			}
			key := field.Field
			if field.As != "" {
				key = field.As
			}
			row[key] = value
		}
		size += query.EstimateRowsBytes([]model.Row{row})
		if size > remaining {
			return nil, &query.PlanLimitError{QueryID: queryID, Boundary: query.BoundaryRetainedBytes}
		}
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(result) != count {
		return nil, fmt.Errorf("postgres plan row count changed")
	}
	return result, nil
}

func isCanonicalNumber(field string) bool {
	for _, known := range canonicalNumbers {
		if known.key == field {
			return true
		}
	}
	return false
}

// Backfill complete document-backed and older EAV-only canonical sources.
// An unsupported historical row aborts the enclosing schema transaction,
// preserving all legacy data for repair or a subsequent authoritative rebuild.
func backfillCanonical(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, `SELECT s.namespace, s.source_name
			FROM cao_sources s JOIN cao_counts c
			ON c.namespace = s.namespace AND c.source_name = s.source_name
			WHERE s.source_name LIKE '$%' AND c.count >= 0 AND s.is_canonical = FALSE
			AND (EXISTS (SELECT 1 FROM cao_source_documents m
				WHERE m.namespace = s.namespace AND m.source_name = s.source_name AND m.ordinal = -1)
				OR EXISTS (SELECT 1 FROM cao_values v
					WHERE v.namespace = s.namespace AND v.source_name = s.source_name AND v.ordinal = -1))
			AND NOT EXISTS (SELECT 1 FROM cao_canonical_rows r
				WHERE r.namespace = s.namespace AND r.source_name = s.source_name)`)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	var sources [][2]string
	for rows.Next() {
		var pair [2]string
		if err = rows.Scan(&pair[0], &pair[1]); err != nil {
			break
		}
		sources = append(sources, pair)
	}
	if err == nil {
		err = rows.Err()
	}
	_ = rows.Close()
	if err != nil {
		return err
	}
	for _, source := range sources {
		namespace, name := source[0], source[1]
		if !isCanonicalSource(name) {
			continue
		}
		var documentCount int
		var hasMetadata bool
		if err = tx.QueryRowContext(ctx, `SELECT
			EXISTS (SELECT 1 FROM cao_source_documents WHERE namespace = $1 AND source_name = $2 AND ordinal = -1),
			(SELECT count(*) FROM cao_source_documents WHERE namespace = $1 AND source_name = $2 AND ordinal >= 0)`,
			namespace, name).Scan(&hasMetadata, &documentCount); err != nil {
			return err
		}
		var expected int
		if err = tx.QueryRowContext(ctx, `SELECT count FROM cao_counts WHERE namespace = $1 AND source_name = $2`,
			namespace, name).Scan(&expected); err != nil {
			return err
		}
		if !hasMetadata || documentCount != expected {
			metadata, readErr := readLegacyTree(ctx, tx, namespace, name, -1)
			if readErr != nil {
				return fmt.Errorf("cannot migrate incomplete legacy canonical source %q: %w", name, readErr)
			}
			if metadata != nil {
				if _, ok := metadata.(map[string]any); !ok {
					return fmt.Errorf("invalid legacy canonical metadata in %q", name)
				}
			}
			if _, err = tx.ExecContext(ctx, `DELETE FROM cao_source_documents WHERE namespace = $1 AND source_name = $2`,
				namespace, name); err != nil {
				return err
			}
			documents := documentBatch{ctx: ctx, tx: tx, namespace: namespace, name: name}
			if err = documents.add(-1, metadata); err != nil {
				return err
			}
			var lastOrdinal int64 = -1
			for {
				ordinals, readErr := func() ([]int64, error) {
					batch, queryErr := tx.QueryContext(ctx, `SELECT ordinal FROM cao_source_rows
						WHERE namespace = $1 AND source_name = $2 AND ordinal > $3
						ORDER BY ordinal LIMIT 256`, namespace, name, lastOrdinal)
					if queryErr != nil {
						return nil, queryErr
					}
					defer func() { _ = batch.Close() }()
					var ordinals []int64
					for batch.Next() {
						var ordinal int64
						if scanErr := batch.Scan(&ordinal); scanErr != nil {
							return nil, scanErr
						}
						ordinals = append(ordinals, ordinal)
					}
					return ordinals, batch.Err()
				}()
				if readErr != nil {
					return readErr
				}
				if len(ordinals) == 0 {
					break
				}
				legacyRows, readErr := readLegacyRowsBatch(ctx, tx, namespace, name, ordinals)
				if readErr != nil {
					return readErr
				}
				for i, ordinal := range ordinals {
					if ordinal != lastOrdinal+1 {
						return fmt.Errorf("noncontiguous legacy canonical ordinals in %q", name)
					}
					var ok bool
					if ok, err = insertCanonical(ctx, tx, namespace, name, ordinal, legacyRows[i]); err != nil {
						return err
					}
					if !ok {
						return fmt.Errorf("cannot migrate canonical source %q at ordinal %d: %s",
							name, ordinal, canonicalFallbackReason(legacyRows[i]))
					}
					lastOrdinal = ordinal
				}
			}
			if lastOrdinal+1 != int64(expected) {
				return fmt.Errorf("incomplete legacy canonical source %q: expected %d rows, got %d",
					name, expected, lastOrdinal+1)
			}
			if err = documents.flush(); err != nil {
				return err
			}
			if err = finalizeCanonicalBackfill(ctx, tx, namespace, name); err != nil {
				return err
			}
			continue
		}
		// A source-specific cursor keeps migration memory bounded and allows
		// inserts after closing each fetched batch of rows.
		if _, err = tx.ExecContext(ctx, `DECLARE canonical_backfill_cursor NO SCROLL CURSOR FOR
				SELECT ordinal, payload FROM cao_source_documents
				WHERE namespace = $1 AND source_name = $2 AND ordinal >= 0 ORDER BY ordinal`, namespace, name); err != nil {
			return err
		}
		for {
			type item struct {
				ordinal int64
				row     model.Row
			}
			items, readErr := func() ([]item, error) {
				batch, fetchErr := tx.QueryContext(ctx, "FETCH FORWARD 256 FROM canonical_backfill_cursor")
				if fetchErr != nil {
					return nil, fetchErr
				}
				defer func() { _ = batch.Close() }()
				var items []item
				for batch.Next() {
					var ordinal int64
					var payload string
					if scanErr := batch.Scan(&ordinal, &payload); scanErr != nil {
						return nil, scanErr
					}
					var row model.Row
					if decodeErr := decodeJSON([]byte(payload), &row); decodeErr != nil {
						return nil, decodeErr
					}
					items = append(items, item{ordinal, row})
				}
				return items, batch.Err()
			}()
			if readErr != nil {
				return readErr
			}
			if len(items) == 0 {
				break
			}
			for _, item := range items {
				var ok bool
				if ok, err = insertCanonical(ctx, tx, namespace, name, item.ordinal, item.row); err != nil {
					return err
				}
				if !ok {
					return fmt.Errorf("cannot migrate canonical source %q at ordinal %d: %s",
						name, item.ordinal, canonicalFallbackReason(item.row))
				}
			}
		}
		if _, err = tx.ExecContext(ctx, "CLOSE canonical_backfill_cursor"); err != nil {
			return err
		}
		if err = finalizeCanonicalBackfill(ctx, tx, namespace, name); err != nil {
			return err
		}
	}
	return nil
}

func migrateLegacyCanonicalProvenance(ctx context.Context, tx *sql.Tx) error {
	if _, err := tx.ExecContext(ctx, `DECLARE canonical_provenance_cursor NO SCROLL CURSOR FOR
		SELECT r.namespace, r.source_name, r.ordinal, r.provenance::text,
			r.present, r.extension::text
		FROM cao_canonical_rows r
		JOIN cao_sources s ON s.namespace = r.namespace AND s.source_name = r.source_name
		WHERE s.is_canonical AND 'provenance' = ANY(r.present)
		ORDER BY r.namespace, r.source_name, r.ordinal`); err != nil {
		return err
	}
	defer func() { _, _ = tx.ExecContext(ctx, "CLOSE canonical_provenance_cursor") }()
	type legacyRow struct {
		namespace, name string
		ordinal         int64
		provenance      sql.NullString
		present         []string
		extension       sql.NullString
	}
	for {
		batch, err := func() ([]legacyRow, error) {
			rows, err := tx.QueryContext(ctx, "FETCH FORWARD 256 FROM canonical_provenance_cursor")
			if err != nil {
				return nil, err
			}
			defer func() { _ = rows.Close() }()
			batch := make([]legacyRow, 0, 256)
			for rows.Next() {
				var row legacyRow
				if err := rows.Scan(&row.namespace, &row.name, &row.ordinal, &row.provenance,
					&row.present, &row.extension); err != nil {
					return nil, err
				}
				batch = append(batch, row)
			}
			return batch, rows.Err()
		}()
		if err != nil || len(batch) == 0 {
			return err
		}
		for start := 0; start < len(batch); {
			end := start + 1
			namespace, name := batch[start].namespace, batch[start].name
			for end < len(batch) && batch[end].namespace == namespace && batch[end].name == name {
				end++
			}
			ordinals := make([]int64, 0, end-start)
			for _, item := range batch[start:end] {
				extension, err := decodeCanonicalExtension(item.extension)
				if err != nil {
					return err
				}
				for _, key := range item.present {
					if _, duplicated := extension[key]; duplicated {
						return fmt.Errorf("canonical field %q duplicated in legacy extension in %q",
							key, name)
					}
				}
				ordinals = append(ordinals, item.ordinal)
			}
			original, _, err := readCanonicalOrdinals(ctx, tx, namespace, name, len(ordinals), ordinals)
			if err != nil {
				return err
			}
			for i, item := range batch[start:end] {
				var provenance any
				if item.provenance.Valid {
					if err := decodeJSON([]byte(item.provenance.String), &provenance); err != nil {
						return err
					}
				}
				original[i]["provenance"] = provenance
				if _, err := tx.ExecContext(ctx, `DELETE FROM cao_canonical_rows
					WHERE namespace = $1 AND source_name = $2 AND ordinal = $3`,
					namespace, name, item.ordinal); err != nil {
					return err
				}
				if ok, err := insertCanonical(ctx, tx, namespace, name, item.ordinal, original[i]); err != nil {
					return err
				} else if !ok {
					return fmt.Errorf("unsupported legacy provenance in %q at ordinal %d", name, item.ordinal)
				}
			}
			updated, _, err := readCanonicalOrdinals(ctx, tx, namespace, name, len(ordinals), ordinals)
			if err != nil {
				return err
			}
			if !reflect.DeepEqual(updated, original) {
				return fmt.Errorf("legacy provenance migration changed source %q", name)
			}
			start = end
		}
	}
}

func migrateCanonicalExtensions(ctx context.Context, tx *sql.Tx) error {
	known := make(map[string]bool)
	for _, fields := range [][]struct{ key, column string }{
		canonicalFields, canonicalTimes, canonicalNumbers, canonicalBooleans,
		canonicalIdentifiers, canonicalLinks, canonicalArrays, canonicalObjects,
	} {
		for _, field := range fields {
			known[field.key] = true
		}
	}
	known["provenance"] = true
	keys := make([]string, 0, len(known))
	for key := range known {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	if _, err := tx.ExecContext(ctx, `DECLARE canonical_extension_cursor NO SCROLL CURSOR FOR
		SELECT r.namespace, r.source_name, r.ordinal, r.present, r.extension::text
		FROM cao_canonical_rows r
		JOIN cao_sources s ON s.namespace = r.namespace AND s.source_name = r.source_name
		WHERE s.is_canonical AND EXISTS (
			SELECT 1 FROM json_object_keys(r.extension) AS key
			WHERE key = ANY($1::text[]))
		ORDER BY r.namespace, r.source_name, r.ordinal`, keys); err != nil {
		return err
	}
	defer func() { _, _ = tx.ExecContext(ctx, "CLOSE canonical_extension_cursor") }()
	type candidate struct {
		namespace, name string
		ordinal         int64
		present         []string
		extension       string
	}
	checked := make(map[[2]string]bool)
	for {
		batch, err := func() ([]candidate, error) {
			rows, err := tx.QueryContext(ctx, "FETCH FORWARD 256 FROM canonical_extension_cursor")
			if err != nil {
				return nil, err
			}
			defer func() { _ = rows.Close() }()
			batch := make([]candidate, 0, 256)
			for rows.Next() {
				var item candidate
				if err := rows.Scan(&item.namespace, &item.name, &item.ordinal,
					&item.present, &item.extension); err != nil {
					return nil, err
				}
				batch = append(batch, item)
			}
			return batch, rows.Err()
		}()
		if err != nil {
			return err
		}
		if len(batch) == 0 {
			break
		}
		for start := 0; start < len(batch); {
			end := start + 1
			namespace, name := batch[start].namespace, batch[start].name
			for end < len(batch) && batch[end].namespace == namespace && batch[end].name == name {
				end++
			}
			identity := [2]string{namespace, name}
			if !checked[identity] {
				var expected, actual int64
				var first, last sql.NullInt64
				if err := tx.QueryRowContext(ctx, `SELECT c.count, count(r.ordinal),
					min(r.ordinal), max(r.ordinal)
					FROM cao_counts c LEFT JOIN cao_canonical_rows r
					ON r.namespace = c.namespace AND r.source_name = c.source_name
					WHERE c.namespace = $1 AND c.source_name = $2
					GROUP BY c.count`, namespace, name).Scan(&expected, &actual, &first, &last); err != nil {
					return fmt.Errorf("verify canonical source %q: %w", name, err)
				}
				if expected != actual || !first.Valid || first.Int64 != 0 || last.Int64 != expected-1 {
					return fmt.Errorf("incomplete canonical source %q before extension migration", name)
				}
				checked[identity] = true
			}
			ordinals := make([]int64, 0, end-start)
			for _, item := range batch[start:end] {
				var extension model.Row
				if err := decodeJSON([]byte(item.extension), &extension); err != nil || extension == nil {
					return fmt.Errorf("invalid canonical extension in %q at ordinal %d", name, item.ordinal)
				}
				for _, key := range item.present {
					if _, duplicated := extension[key]; duplicated && known[key] {
						return fmt.Errorf("canonical field %q duplicated in extension in %q at ordinal %d",
							key, name, item.ordinal)
					}
				}
				ordinals = append(ordinals, item.ordinal)
			}
			original, _, err := readCanonicalOrdinals(ctx, tx, namespace, name, len(ordinals), ordinals)
			if err != nil {
				return fmt.Errorf("read canonical extension batch in %q: %w", name, err)
			}
			for i, item := range batch[start:end] {
				if _, err := tx.ExecContext(ctx, `DELETE FROM cao_canonical_rows
					WHERE namespace = $1 AND source_name = $2 AND ordinal = $3`,
					namespace, name, item.ordinal); err != nil {
					return err
				}
				if ok, err := insertCanonical(ctx, tx, namespace, name, item.ordinal, original[i]); err != nil {
					return err
				} else if !ok {
					return fmt.Errorf("unsupported canonical extension in %q at ordinal %d", name, item.ordinal)
				}
			}
			updated, _, err := readCanonicalOrdinals(ctx, tx, namespace, name, len(ordinals), ordinals)
			if err != nil {
				return fmt.Errorf("verify canonical extension migration in %q: %w", name, err)
			}
			if !reflect.DeepEqual(updated, original) {
				return fmt.Errorf("canonical extension migration changed source %q", name)
			}
			start = end
		}
	}
	return nil
}

func readLegacyTree(ctx context.Context, tx *sql.Tx, namespace, name string, ordinal int64) (any, error) {
	rows, err := tx.QueryContext(ctx, `SELECT node_id, parent_id, object_key, array_index,
		kind, text_value, bool_value FROM cao_values
		WHERE namespace = $1 AND source_name = $2 AND ordinal = $3 ORDER BY node_id`,
		namespace, name, ordinal)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var nodes []*valueNode
	for rows.Next() {
		n := new(valueNode)
		if err := rows.Scan(&n.id, &n.parent, &n.key, &n.index, &n.kind, &n.text, &n.boolean); err != nil {
			return nil, err
		}
		if err := n.decode(); err != nil {
			return nil, err
		}
		nodes = append(nodes, n)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return decodeTree(nodes)
}

func readLegacyRowsBatch(ctx context.Context, tx *sql.Tx, namespace, name string, ordinals []int64) ([]model.Row, error) {
	rows, err := tx.QueryContext(ctx, `SELECT ordinal, node_id, parent_id, object_key, array_index,
		kind, text_value, bool_value FROM cao_values
		WHERE namespace = $1 AND source_name = $2 AND ordinal = ANY($3)
		ORDER BY ordinal, node_id`, namespace, name, ordinals)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	nodesByOrdinal := make(map[int64][]*valueNode, len(ordinals))
	for rows.Next() {
		n := new(valueNode)
		var ordinal int64
		if err := rows.Scan(&ordinal, &n.id, &n.parent, &n.key, &n.index,
			&n.kind, &n.text, &n.boolean); err != nil {
			return nil, err
		}
		if err := n.decode(); err != nil {
			return nil, err
		}
		nodesByOrdinal[ordinal] = append(nodesByOrdinal[ordinal], n)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]model.Row, len(ordinals))
	for i, ordinal := range ordinals {
		value, err := decodeTree(nodesByOrdinal[ordinal])
		if err != nil {
			return nil, err
		}
		row, ok := value.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("invalid legacy canonical row in %q", name)
		}
		out[i] = row
	}
	return out, nil
}

func finalizeCanonicalBackfill(ctx context.Context, tx *sql.Tx, namespace, name string) error {
	for _, statement := range []string{
		`DELETE FROM cao_source_rows WHERE namespace = $1 AND source_name = $2`,
		`DELETE FROM cao_values WHERE namespace = $1 AND source_name = $2`,
		`DELETE FROM cao_source_documents WHERE namespace = $1 AND source_name = $2 AND ordinal >= 0`,
	} {
		if _, err := tx.ExecContext(ctx, statement, namespace, name); err != nil {
			return err
		}
	}
	_, err := tx.ExecContext(ctx, `UPDATE cao_sources SET is_canonical = TRUE, storage_fallback_reason = NULL
		WHERE namespace = $1 AND source_name = $2`, namespace, name)
	return err
}

func decodeCanonicalIdentifier(value, kind sql.NullString) any {
	if !value.Valid {
		return nil
	}
	if kind.String == "number" {
		return json.Number(value.String)
	}
	return value.String
}

func decodeCanonicalLinkValue(href, relation, label sql.NullString, present []string, plain bool) (any, error) {
	if plain && href.Valid {
		return href.String, nil
	}
	if !href.Valid {
		return nil, nil
	}
	link := map[string]any{"href": href.String}
	for _, part := range present {
		switch part {
		case "href":
		case "relation":
			if relation.Valid {
				link[part] = relation.String
			} else {
				link[part] = nil
			}
		case "label":
			if label.Valid {
				link[part] = label.String
			} else {
				link[part] = nil
			}
		default:
			return nil, fmt.Errorf("invalid native link property %q", part)
		}
	}
	return link, nil
}

func decodeCanonicalExtension(extension sql.NullString) (model.Row, error) {
	if !extension.Valid {
		return make(model.Row), nil
	}
	var row model.Row
	if err := decodeJSON([]byte(extension.String), &row); err != nil || row == nil {
		return nil, errors.New("invalid postgres canonical extension")
	}
	return row, nil
}

func readCanonicalData(ctx context.Context, tx *sql.Tx, namespace, name string, count int) ([]model.Row, bool, error) {
	return readCanonicalOrdinals(ctx, tx, namespace, name, count, nil)
}

func readCanonicalOrdinals(ctx context.Context, tx *sql.Tx, namespace, name string, count int, ordinals []int64) ([]model.Row, bool, error) {
	columns := []string{"present", "extension"}
	for _, field := range canonicalFields {
		columns = append(columns, field.column)
	}
	for _, field := range canonicalTimes {
		columns = append(columns, timestampReadExpression(field.column))
	}
	for _, field := range canonicalNumbers {
		columns = append(columns, `COALESCE(`+field.column+`_raw, `+field.column+`::text)`)
	}
	for _, field := range canonicalBooleans {
		columns = append(columns, field.column)
	}
	for _, field := range canonicalIdentifiers {
		columns = append(columns, `COALESCE(`+field.column+`, `+field.column+`_numeric::text)`, field.column+"_kind")
	}
	for _, field := range canonicalLinks {
		columns = append(columns, field.column, field.column+"_relation",
			field.column+"_label", field.column+"_present")
		if field.key == "runLink" {
			columns = append(columns, "run_href_kind")
		}
	}
	for _, field := range canonicalArrays {
		columns = append(columns, field.column)
	}
	for _, field := range canonicalObjects {
		columns = append(columns, nestedReadExpression(field.key, field.column))
	}
	for _, field := range canonicalFlexibleText {
		columns = append(columns, field.column+"::text")
	}
	columns = append(columns, "value_text", "value_kind", "id_kind")
	columns = append(columns, "provenance_source", "provenance_source_id",
		timestampReadExpression("provenance_observed_at"),
		"provenance_source_revision", "provenance_present", "provenance_null")
	where := "namespace = $1 AND source_name = $2"
	args := []any{namespace, name}
	if ordinals != nil {
		where += " AND ordinal = ANY($3)"
		args = append(args, ordinals)
	}
	// #nosec G202 -- columns are derived exclusively from the static native field catalogue.
	rows, err := tx.QueryContext(ctx, `SELECT `+strings.Join(columns, ",")+`
		FROM cao_canonical_rows WHERE `+where+` ORDER BY ordinal`, args...)
	if err != nil {
		return nil, true, err
	}
	defer func() { _ = rows.Close() }()
	out := make([]model.Row, 0, count)
	for rows.Next() {
		var present []string
		var extension sql.NullString
		values := make([]sql.NullString, len(canonicalFields)+len(canonicalTimes)+len(canonicalNumbers))
		booleanValues := make([]sql.NullBool, len(canonicalBooleans))
		identifierValues := make([]sql.NullString, 2*len(canonicalIdentifiers))
		linkValues := make([]sql.NullString, 3*len(canonicalLinks))
		linkPresent := make([][]string, len(canonicalLinks))
		arrayValues := make([][]string, len(canonicalArrays))
		objectValues := make([]sql.NullString, len(canonicalObjects))
		flexibleValues := make([]sql.NullString, len(canonicalFlexibleText))
		var valueText, valueKind, idKind sql.NullString
		var provenanceSource, provenanceID, provenanceObservedAt, provenanceRevision sql.NullString
		var provenancePresent []string
		var provenanceNull bool
		var runLinkKind sql.NullString
		dest := []any{&present, &extension}
		for i := range values {
			dest = append(dest, &values[i])
		}
		for i := range booleanValues {
			dest = append(dest, &booleanValues[i])
		}
		for i := range identifierValues {
			dest = append(dest, &identifierValues[i])
		}
		for i := range canonicalLinks {
			dest = append(dest, &linkValues[3*i], &linkValues[3*i+1],
				&linkValues[3*i+2], &linkPresent[i])
			if canonicalLinks[i].key == "runLink" {
				dest = append(dest, &runLinkKind)
			}
		}
		for i := range arrayValues {
			dest = append(dest, &arrayValues[i])
		}
		for i := range objectValues {
			dest = append(dest, &objectValues[i])
		}
		for i := range flexibleValues {
			dest = append(dest, &flexibleValues[i])
		}
		dest = append(dest, &valueText, &valueKind, &idKind)
		dest = append(dest, &provenanceSource, &provenanceID, &provenanceObservedAt,
			&provenanceRevision, &provenancePresent, &provenanceNull)
		if err := rows.Scan(dest...); err != nil {
			return nil, true, err
		}
		row, err := decodeCanonicalExtension(extension)
		if err != nil {
			return nil, true, err
		}
		known := make(map[string]bool, len(present))
		for _, key := range present {
			known[key] = true
		}
		if known["provenance"] {
			row["provenance"], err = decodeCanonicalProvenance(provenanceSource, provenanceID,
				provenanceObservedAt, provenanceRevision, provenancePresent, provenanceNull)
			if err != nil {
				return nil, true, err
			}
		}
		for i, field := range canonicalFields {
			if known[field.key] {
				if values[i].Valid {
					row[field.key] = values[i].String
				} else {
					row[field.key] = nil
				}
				if field.key == "id" && values[i].Valid && idKind.String == "number" {
					row[field.key] = json.Number(values[i].String)
				}
				for j, flexible := range canonicalFlexibleText {
					if field.key == flexible.key && flexibleValues[j].Valid {
						var decoded any
						if err := decodeJSON([]byte(flexibleValues[j].String), &decoded); err != nil {
							return nil, true, err
						}
						row[field.key] = decoded
					}
				}
			}
		}
		for i, field := range canonicalTimes {
			if known[field.key] {
				if values[len(canonicalFields)+i].Valid {
					row[field.key] = values[len(canonicalFields)+i].String
				} else {
					row[field.key] = nil
				}
			}
		}
		for i, field := range canonicalNumbers {
			if known[field.key] {
				raw := values[len(canonicalFields)+len(canonicalTimes)+i]
				if raw.Valid {
					row[field.key] = json.Number(raw.String)
				} else {
					row[field.key] = nil
				}
				if field.key == "value" && valueKind.String == "string" {
					row[field.key] = valueText.String
				}
			}
		}
		for i, field := range canonicalBooleans {
			if known[field.key] {
				if booleanValues[i].Valid {
					row[field.key] = booleanValues[i].Bool
				} else {
					row[field.key] = nil
				}
			}
		}
		for i, field := range canonicalIdentifiers {
			if known[field.key] {
				row[field.key] = decodeCanonicalIdentifier(identifierValues[2*i], identifierValues[2*i+1])
			}
		}
		for i, field := range canonicalLinks {
			if known[field.key] {
				value, err := decodeCanonicalLinkValue(linkValues[3*i], linkValues[3*i+1],
					linkValues[3*i+2], linkPresent[i],
					field.key == "runLink" && runLinkKind.String == "string")
				if err != nil {
					return nil, true, err
				}
				row[field.key] = value
			}
		}
		for i, field := range canonicalArrays {
			if known[field.key] {
				if arrayValues[i] == nil {
					row[field.key] = nil
				} else {
					items := make([]any, len(arrayValues[i]))
					for j, value := range arrayValues[i] {
						items[j] = value
					}
					row[field.key] = items
				}
			}
		}
		for i, field := range canonicalObjects {
			if known[field.key] {
				if objectValues[i].Valid {
					var value any
					if err := decodeJSON([]byte(objectValues[i].String), &value); err != nil {
						return nil, true, err
					}
					row[field.key] = value
				} else {
					row[field.key] = nil
				}
			}
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, true, err
	}
	if ordinals != nil && len(out) != count {
		return nil, true, fmt.Errorf("incomplete postgres canonical ordinal batch in %q: got %d, expected %d", name, len(out), count)
	}
	return out, true, nil
}
