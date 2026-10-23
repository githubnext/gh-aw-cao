package postgresx

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/githubnext/gh-cao/server/internal/model"
)

func (w *Writer) preserveCollectionDecisions(ctx context.Context) error {
	_, err := w.tx.Exec(ctx, `CREATE TEMP TABLE workflow_value_collections_previous ON COMMIT DROP AS
		SELECT id, present_fields, observed_at, registration, collector, state, reason_code, reason, policy_digest,
			last_attempt_at, last_attempt_outcome
		FROM workflow_value_collections WHERE namespace=$1`, w.store.namespace)
	return err
}

func (w *Writer) reconcileCollectionDecisions(ctx context.Context) error {
	var invalid bool
	err := w.tx.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM workflow_value_collections incoming
		JOIN workflow_value_collections_previous previous USING (id)
		WHERE incoming.namespace=$1 AND (
			(incoming.observed_at = previous.observed_at AND
				ROW(incoming.registration, incoming.collector, incoming.state, incoming.reason_code,
					incoming.policy_digest)
				IS DISTINCT FROM
				ROW(previous.registration, previous.collector, previous.state, previous.reason_code,
					previous.policy_digest)) OR
			(incoming.last_attempt_at = previous.last_attempt_at AND
				incoming.last_attempt_outcome IS DISTINCT FROM previous.last_attempt_outcome)
		))`, w.store.namespace).Scan(&invalid)
	if err != nil {
		return err
	}
	if invalid {
		return errors.New("workflow Value collection decision or attempt conflicts with accepted history")
	}
	decisionPresence, attemptPresence := "incoming.present_fields", "incoming.present_fields"
	for index, column := range entityTables["$workflowValueCollections"].columns {
		if column.field == "collector" {
			decisionPresence = fmt.Sprintf("set_bit(%s,%d,get_bit(previous.present_fields,%d))", decisionPresence, index, index)
		}
		if column.field == "lastAttemptAt" || column.field == "lastAttemptOutcome" {
			attemptPresence = fmt.Sprintf("set_bit(%s,%d,1)", attemptPresence, index)
		}
	}
	if _, err := w.tx.Exec(ctx, `UPDATE workflow_value_collections incoming SET
		observed_at=previous.observed_at, registration=previous.registration, collector=previous.collector,
		state=previous.state, reason_code=previous.reason_code, reason=previous.reason, policy_digest=previous.policy_digest,
		present_fields=`+decisionPresence+` FROM workflow_value_collections_previous previous
		WHERE incoming.namespace=$1 AND incoming.id=previous.id
		AND incoming.observed_at<previous.observed_at`, w.store.namespace); err != nil {
		return err
	}
	_, err = w.tx.Exec(ctx, `UPDATE workflow_value_collections incoming SET
		last_attempt_at=previous.last_attempt_at, last_attempt_outcome=previous.last_attempt_outcome,
		present_fields=`+attemptPresence+` FROM workflow_value_collections_previous previous
		WHERE incoming.namespace=$1 AND incoming.id=previous.id
		AND previous.last_attempt_at IS NOT NULL
		AND (incoming.last_attempt_at IS NULL OR incoming.last_attempt_at<previous.last_attempt_at)`, w.store.namespace)
	return err
}

var valueCollectorPath = regexp.MustCompile(`^[A-Za-z0-9._/-]+\.mjs$`)
var valueCollectionReasons = map[string]string{
	"unconfigured":              "No collector is registered for this workflow in the reviewed policy.",
	"disabled":                  "The reviewed registration explicitly disables future collection; retained evidence is unchanged.",
	"activity-disabled":         "Activity collection is disabled in the reviewed policy.",
	"never-captured":            "No accepted capture is present in retained collection history.",
	"api-budget":                "GitHub API capacity is exhausted or reserved for ordinary Activity collection.",
	"budget-unavailable":        "GitHub API capacity could not be verified; retained evidence is unchanged.",
	"shared-budget-unavailable": "Automatic remote acquisition is deferred until shared API request budgets can be enforced. Activity retains priority.",
	"fast-mode":                 "Fast mode retains Value history without acquiring new evidence.",
	"public-only":               "Public-only collection retains Value history without acquiring new evidence.",
	"timeout":                   "The collector exceeded its time budget; previous accepted evidence is retained.",
	"collector-failed":          "The collector failed; previous accepted evidence is retained.",
	"invalid-evidence":          "The collector returned invalid or incomplete evidence; previous accepted evidence is retained.",
	"batch-budget":              "The collection batch exhausted its bounded time or output budget.",
	"captured":                  "Accepted evidence is available at its original capture and cutoff dates.",
	"not-due":                   "The frozen cadence is already covered by retained evidence; no new evidence was acquired.",
}
var valueCollectionStateReasons = map[string][]string{
	"unconfigured": {"unconfigured"}, "disabled": {"disabled", "activity-disabled"},
	"never-captured": {"never-captured"},
	"deferred":       {"api-budget", "budget-unavailable", "shared-budget-unavailable", "fast-mode", "public-only", "batch-budget"},
	"failed":         {"timeout", "collector-failed", "invalid-evidence", "batch-budget"},
	"available":      {"captured", "not-due"},
}

func validateWorkflowValueCollection(row model.Row) error {
	fail := errors.New("invalid workflow Value collection record")
	repository, workflow := evidenceText(row["repository"]), evidenceText(row["workflow"])
	observed, err := evidenceTime(row["observedAt"])
	registration, state := evidenceText(row["registration"]), evidenceText(row["state"])
	reason := evidenceText(row["reasonCode"])
	if err != nil || observed.Nanosecond()%int(time.Millisecond) != 0 ||
		fmt.Sprint(row["schemaVersion"]) != "1" || evidenceText(row["schemaVersion"]) != "" ||
		!targetCoordinate.MatchString(repository) || !evidenceSlug.MatchString(workflow) ||
		row["sourcePath"] != ".github/workflows/"+workflow+".md" ||
		row["id"] != "workflow-value-collection:"+evidenceComponent(strings.ToLower(repository)+":"+workflow) ||
		!evidenceDigest.MatchString(evidenceText(row["policyDigest"])) ||
		!slices.Contains([]string{"enabled", "disabled", "unconfigured"}, registration) ||
		!slices.Contains(valueCollectionStateReasons[state], reason) ||
		evidenceText(row["reason"]) != valueCollectionReasons[reason] {
		return fail
	}
	collector, hasCollector := row["collector"]
	if registration == "unconfigured" {
		if hasCollector || state != "unconfigured" {
			return fail
		}
	} else {
		if registration == "enabled" && (!hasCollector || state == "unconfigured") ||
			registration == "disabled" && state != "disabled" {
			return fail
		}
		if hasCollector {
			if !valueCollectorPath.MatchString(evidenceText(collector)) {
				return fail
			}
			for _, part := range strings.Split(evidenceText(collector), "/") {
				if part == "" || part == "." || part == ".." {
					return fail
				}
			}
		}
	}
	attempt, hasAttempt := row["lastAttemptAt"]
	outcome, hasOutcome := row["lastAttemptOutcome"]
	if hasAttempt || hasOutcome {
		started, err := evidenceTime(attempt)
		if err != nil || started.Nanosecond()%int(time.Millisecond) != 0 ||
			started.After(observed) || !slices.Contains([]string{"available", "failed"}, evidenceText(outcome)) {
			return fail
		}
	}
	for key := range row {
		if !slices.Contains([]string{"schemaVersion", "id", "repository", "workflow", "sourcePath", "observedAt",
			"registration", "collector", "state", "reasonCode", "reason", "policyDigest", "lastAttemptAt",
			"lastAttemptOutcome", "repositoryId", "workflowId", "provenance"}, key) {
			return fail
		}
	}
	for field, expected := range map[string]string{
		"repositoryId": "repository:" + evidenceComponent(strings.ToLower(repository)),
		"workflowId":   "workflow:" + evidenceComponent(strings.ToLower(repository)+":"+evidenceText(row["sourcePath"])),
	} {
		if row[field] != expected {
			return fail
		}
	}
	return nil
}
