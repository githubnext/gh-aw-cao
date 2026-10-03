package postgresx

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
)

func TestAuditProjectionProtectsUnsupportedEvidence(t *testing.T) {
	for _, field := range []string{"runAttempt", "attempt", "unexpected"} {
		row := model.Row{"source": "gh-aw-logs", "type": "workflow_run_usage", "status": "observed", "timestamp": "2026-01-01T00:00:00Z", field: false}
		if err := validateAuditProjection(row); err == nil || !strings.Contains(err.Error(), field) {
			t.Fatalf("unsupported nonnull %s was silently projected: %v", field, err)
		}
		row[field] = nil
		if err := validateAuditProjection(row); err != nil {
			t.Fatal(err)
		}
	}
	for _, field := range []string{"opportunityId", "correlationId", "claimRunAttempt", "code", "provenance", "sequence"} {
		row := model.Row{"source": "gh-aw-logs", "type": "workflow_run_usage", field: "evidence"}
		if err := validateAuditProjection(row); err != nil {
			t.Fatal(err)
		}
	}
	if err := validateAuditProjection(model.Row{"source": "gh-aw-logs", "type": "workflow_run_behavior", "comparison": true}); err != nil {
		t.Fatal("behavior is outside first-pass curation", err)
	}
	if err := validateAuditProjection(model.Row{"source": "audit", "type": "audit.finding", "status": "critical", "summary": "Specific diagnostic", "details": true}); err != nil {
		t.Fatal("specific diagnostics are outside first-pass curation", err)
	}
	if err := validateAuditProjection(model.Row{"source": "gh-aw-logs", "type": "workflow_run_usage", "status": "observed", "inputTokens": 0, "attempt": 2}); err != nil {
		t.Fatal("stored additional evidence already prevents curation", err)
	}
	if err := validateAuditProjection(model.Row{"source": "gh-aw-logs", "type": "workflow_run_usage", "status": "observed", "timestamp": "2026-01-01T00:00:00Z", "inputTokens": (*int)(nil), "attempt": 2}); err == nil {
		t.Fatal("a typed null cannot protect unsupported nonnull evidence")
	}
}

func TestAuditCurationRequiresEveryStoredEvidenceFieldToBeNull(t *testing.T) {
	statement := auditCurationStatement()
	for _, column := range entityTables["$audits"].columns {
		if auditMetadataField(column.field) || column.field == "code" {
			continue
		}
		if !strings.Contains(statement, `a."`+column.name+`" IS NULL`) {
			t.Fatalf("additional evidence field %s is not protected", column.field)
		}
	}
}

func TestAuditReferenceProjectionFailsClosedWithoutNativeField(t *testing.T) {
	for _, source := range []string{"$experimentAssignments", "$graderObservations", "$evalObservations"} {
		t.Run(source, func(t *testing.T) {
			stored := false
			for _, column := range entityTables[source].columns {
				stored = stored || column.field == "auditId"
			}
			err := validateAuditReferenceProjection(source, model.Row{"auditId": "otherwise-eligible-audit"})
			if (err == nil) != stored {
				t.Fatalf("native audit reference stored=%t, error=%v", stored, err)
			}
			if err := validateAuditReferenceProjection(source, model.Row{"auditId": nil}); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestAuditCurationRejectsInvalidNativeInstants(t *testing.T) {
	column := entityColumn{field: "timestamp", kind: "timestamp", sql: "TIMESTAMPTZ"}
	for _, timestamp := range []string{"invalid", "2026-02-30T00:00:00Z", "2026-01-01T00:00:00+24:00",
		"2026-01-01T00:00:00+00:60", "2026-01-01T00:00:00,123Z"} {
		if _, err := column.bind(timestamp); err == nil {
			t.Fatalf("invalid timestamp %q was normalized into a valid native comparison fact", timestamp)
		}
	}
	if _, err := column.bind("2026-01-01T00:00:00.123+01:30"); err != nil {
		t.Fatal(err)
	}
}

func TestAuditCurationNumericalParsingIsBounded(t *testing.T) {
	for _, summary := range []string{"AIC 0e9999", "AIC 0e-9999", "AIC 1e-9999",
		"AIC 0." + strings.Repeat("0", 2*auditSummaryLimit), "AIC 1e" + strings.Repeat("9", 2*auditSummaryLimit)} {
		row := auditRow("bounded", "gh-aw-logs", "workflow_run_usage", "observed", summary, nil)
		if discardAuditCopy(row, model.Row{"id": "run", "aicTotal": 0}) {
			t.Fatalf("unsafe or oversized summary was eligible: length=%d", len(summary))
		}
	}
}

func auditCurationParents(t *testing.T, writer *Writer) {
	t.Helper()
	for _, record := range []struct {
		source string
		row    model.Row
	}{
		{"$repositories", model.Row{"id": "repository", "owner": "octo", "name": "api"}},
		{"$workflows", model.Row{"id": "workflow", "repositoryId": "repository", "path": ".github/workflows/test.md"}},
		{"$runs", model.Row{"id": "run", "workflowId": "workflow", "repositoryId": "repository", "status": "completed",
			"conclusion": "failure", "failureKind": "compiler", "classification": "failed", "aicTotal": json.Number("4.5"), "safeItemsCount": 2,
			"startedAt": "2026-01-01T00:01:00Z", "createdAt": "2026-01-01T00:00:00Z", "completedAt": "2026-01-01T00:02:00Z"}},
		{"$runs", model.Row{"id": "missing-facts", "workflowId": "workflow", "repositoryId": "repository", "aicTotal": nil, "safeItemsCount": nil}},
		{"$runs", model.Row{"id": "zero", "workflowId": "workflow", "repositoryId": "repository", "aicTotal": 0, "safeItemsCount": 0}},
		{"$runs", model.Row{"id": "fallback", "workflowId": "workflow", "repositoryId": "repository", "status": "queued",
			"conclusion": "failure", "classification": "", "failureKind": "", "createdAt": "2026-01-01T00:00:00Z", "completedAt": "2026-01-01T00:02:00Z"}},
		{"$graders", model.Row{"id": "grader", "workflowId": "workflow"}},
	} {
		if err := writer.Append(t.Context(), record.source, record.row); err != nil {
			t.Fatal(err)
		}
	}
}

func auditRow(id, source, kind, status, summary string, extra model.Row) model.Row {
	row := model.Row{"id": id, "runId": "run", "source": source, "type": kind, "status": status, "summary": summary, "timestamp": "2026-01-01T00:00:00Z"}
	for field, value := range extra {
		row[field] = value
	}
	return row
}

func TestAuditCurationPublish(t *testing.T) {
	store, _ := nativeTestStore(t)
	writer, err := store.BeginIngestion(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Abort(t.Context())
	auditCurationParents(t, writer)
	var retained []string
	var transported int
	appendAudit := func(id, source, kind, status, summary string, extra model.Row, keep bool) {
		t.Helper()
		if err := writer.Append(t.Context(), "$audits", auditRow(id, source, kind, status, summary, extra)); err != nil {
			t.Fatal(err)
		}
		transported++
		if keep {
			retained = append(retained, id)
		}
	}
	appendAudit("comparison", "gh-aw-logs", "workflow_run_comparison", "unavailable", "No baseline comparison", nil, false)
	appendAudit("working-set", "gh-aw-logs", "workflow_run_working_set", "observed", "Working set measured", nil, false)
	appendAudit("session", "agent", "agent.session", "completed", "", nil, false)
	appendAudit("observability", "audit", "audit.observability", "low", "1 anomalous event pattern(s) detected", nil, false)
	appendAudit("recommendation", "audit", "audit.recommendation", "low", "Monitor workflow performance over time", nil, false)
	appendAudit("started", "gh-aw-logs", "workflow_run_started", "completed", "", model.Row{"timestamp": "2026-01-01T00:01:00Z"}, false)
	appendAudit("started-fallback", "gh-aw-logs", "workflow_run_started", "queued", "", model.Row{"runId": "fallback", "timestamp": "2026-01-01T00:00:00Z"}, false)
	appendAudit("completed", "gh-aw-logs", "workflow_run_completed", "failure", "failed", model.Row{"timestamp": "2026-01-01T00:02:00Z"}, false)
	appendAudit("completed-fallback", "gh-aw-logs", "workflow_run_completed", "failure", "failure", model.Row{"runId": "fallback", "timestamp": "2026-01-01T00:02:00Z"}, false)
	appendAudit("failed", "gh-aw-logs", "workflow_run_failed", "failure", "compiler", nil, false)
	appendAudit("failed-fallback", "gh-aw-logs", "workflow_run_failed", "failure", "workflow run failed", model.Row{"runId": "fallback"}, false)
	appendAudit("usage", "gh-aw-logs", "workflow_run_usage", "observed", "AIC 4.5", model.Row{"correlationId": nil, "sequence": 1, "payloadRef": "logs", "observedAt": "2026-01-02T00:00:00Z"}, false)
	appendAudit("usage-exponent", "gh-aw-logs", "workflow_run_usage", "observed", "AIC 45e-1", nil, false)
	appendAudit("usage-zero", "gh-aw-logs", "workflow_run_usage", "observed", "AIC 0", model.Row{"runId": "zero"}, false)
	appendAudit("outputs", "gh-aw-logs", "workflow_run_safe_outputs", "observed", "2 safe output items", nil, false)
	appendAudit("outputs-exponent", "gh-aw-logs", "workflow_run_safe_outputs", "observed", "2e0 safe output items", nil, true)
	appendAudit("outputs-zero", "gh-aw-logs", "workflow_run_safe_outputs", "observed", "0 safe output items", model.Row{"runId": "zero"}, false)
	appendAudit("finding", "audit", "audit.finding", "critical", "Workflow Failed", model.Row{"code": "workflow_failed"}, false)
	appendAudit("wrong-source", "agent", "workflow_run_comparison", "unavailable", "No baseline comparison", nil, true)
	appendAudit("wrong-status", "gh-aw-logs", "workflow_run_comparison", "observed", "No baseline comparison", nil, true)
	appendAudit("wrong-summary", "gh-aw-logs", "workflow_run_comparison", "unavailable", "No baseline comparison ", nil, true)
	appendAudit("comparison-evidence", "gh-aw-logs", "workflow_run_comparison", "unavailable", "No baseline comparison", model.Row{"opportunityId": "opportunity"}, true)
	appendAudit("session-evidence", "agent", "agent.session", "completed", "", model.Row{"correlationId": ""}, true)
	appendAudit("false-evidence", "gh-aw-logs", "workflow_run_comparison", "unavailable", "No baseline comparison", model.Row{"eventsTruncated": false}, true)
	appendAudit("zero-evidence", "gh-aw-logs", "workflow_run_usage", "observed", "AIC 4.5", model.Row{"inputTokens": 0}, true)
	appendAudit("unrelated-code", "gh-aw-logs", "workflow_run_usage", "observed", "AIC 4.5", model.Row{"code": "workflow_failed"}, true)
	appendAudit("attempt-evidence", "gh-aw-logs", "workflow_run_usage", "observed", "AIC 4.5", model.Row{"claimRunAttempt": 2}, true)
	appendAudit("started-conflict", "gh-aw-logs", "workflow_run_started", "completed", "", model.Row{"timestamp": "2026-01-01T00:00:00Z"}, true)
	appendAudit("started-status", "gh-aw-logs", "workflow_run_started", "queued", "", model.Row{"timestamp": "2026-01-01T00:01:00Z"}, true)
	appendAudit("started-null", "gh-aw-logs", "workflow_run_started", "completed", "", model.Row{"timestamp": nil}, true)
	appendAudit("completed-summary", "gh-aw-logs", "workflow_run_completed", "failure", "failure", model.Row{"timestamp": "2026-01-01T00:02:00Z"}, true)
	appendAudit("failed-summary", "gh-aw-logs", "workflow_run_failed", "failure", "workflow run failed", nil, true)
	appendAudit("null-aic", "gh-aw-logs", "workflow_run_usage", "observed", "AIC 0", model.Row{"runId": "missing-facts"}, true)
	appendAudit("null-outputs", "gh-aw-logs", "workflow_run_safe_outputs", "observed", "0 safe output items", model.Row{"runId": "missing-facts"}, true)
	appendAudit("missing-failure", "gh-aw-logs", "workflow_run_failed", "failure", "workflow run failed", model.Row{"runId": "missing-facts"}, true)
	appendAudit("missing-finding", "audit", "audit.finding", "critical", "Workflow Failed", model.Row{"runId": "missing-facts", "code": "workflow_failed"}, true)
	appendAudit("specific-finding", "audit", "audit.finding", "critical", "Firewall violation", model.Row{"code": "workflow_failed"}, true)
	appendAudit("grader", "audit", "audit.grader", "critical", "Workflow Failed", nil, true)
	appendAudit("eval", "audit", "audit.eval", "critical", "Workflow Failed", nil, true)
	appendAudit("safe-output", "safe-outputs", "safe_output.created", "observed", "2 safe output items", nil, true)
	appendAudit("behavior", "gh-aw-logs", "workflow_run_behavior", "observed", "Workflow behavior measured", nil, true)
	appendAudit("assessment", "gh-aw-logs", "workflow_run_assessment", "observed", "Workflow assessed", nil, true)
	appendAudit("security", "security", "audit.finding", "critical", "Workflow Failed", model.Row{"code": "workflow_failed"}, true)
	appendAudit("referenced", "agent", "agent.session", "completed", "", nil, true)
	if err := writer.Append(t.Context(), "$graderObservations", model.Row{"id": "observation", "runId": "run", "graderId": "grader", "auditId": "referenced"}); err != nil {
		t.Fatal(err)
	}
	for index, summary := range []string{"AIC NaN", "AIC Infinity", "AIC -1", "AIC -0", "AIC +4.5", "AIC 04.5", "AIC 4.6", "AIC 1e999", "AIC 1e9999999",
		"AIC 0x4", "AIC ", "AIC 4.5 trailing", "AIC " + strings.Repeat("9", 2048), "AIC 4.5\n"} {
		appendAudit(fmt.Sprintf("bad-usage-%d", index), "gh-aw-logs", "workflow_run_usage", "observed", summary, nil, true)
	}
	for index, summary := range []string{"-1 safe output items", "2.0 safe output items", "02 safe output items", "2.5 safe output items", "3 safe output items",
		"9007199254740992 safe output items", "NaN safe output items", "1e999999 safe output items", "2 safe output items\n"} {
		appendAudit(fmt.Sprintf("bad-outputs-%d", index), "gh-aw-logs", "workflow_run_safe_outputs", "observed", summary, nil, true)
	}
	if err := writer.Append(t.Context(), "$transactions", model.Row{"id": "transport", "records": transported, "committedRecords": transported}); err != nil {
		t.Fatal(err)
	}
	state, err := writer.Publish(t.Context(), "curated")
	if err != nil {
		t.Fatal(err)
	}
	if state.Counts["$audits"] != len(retained) {
		t.Fatalf("retained count=%d, expected %d", state.Counts["$audits"], len(retained))
	}
	if !state.EvaluatedAt.Equal(time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("curation lost the transported evidence clock: %v", state.EvaluatedAt)
	}
	var actual []string
	rows, err := store.db.QueryContext(t.Context(), "SELECT id FROM audits WHERE namespace=$1 ORDER BY id", store.namespace)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		actual = append(actual, id)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	slices.Sort(retained)
	if !reflect.DeepEqual(actual, retained) {
		t.Fatalf("retained IDs=%v, expected %v", actual, retained)
	}
	var records, committed int
	if err := store.db.QueryRowContext(t.Context(), "SELECT records,committed_records FROM transactions WHERE namespace=$1", store.namespace).Scan(&records, &committed); err != nil {
		t.Fatal(err)
	}
	if records != transported || committed != transported {
		t.Fatal("curation changed transported counts")
	}
}

func seedUncuratedAudits(t *testing.T, store *Store) State {
	t.Helper()
	writer, err := store.BeginIngestion(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Abort(t.Context())
	auditCurationParents(t, writer)
	if err := writer.Append(t.Context(), "$audits", auditRow("old", "agent", "agent.session", "pending", "", nil)); err != nil {
		t.Fatal(err)
	}
	_, err = writer.Publish(t.Context(), "unchanged")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(t.Context(), "UPDATE audits SET status='completed' WHERE namespace=$1", store.namespace); err != nil {
		t.Fatal(err)
	}
	state, err := store.State(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	return state
}

func TestAuditCurationExistingNamespaceAndIdempotence(t *testing.T) {
	store, config := nativeTestStore(t)
	before := seedUncuratedAudits(t, store)
	other, err := NewConfig(t.Context(), config, "other")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = other.Close() }()
	otherBefore := seedUncuratedAudits(t, other)
	after, err := store.CurateAudits(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if after.Revision != before.Revision+1 || after.Counts["$audits"] != 0 || after.DataRevision != before.DataRevision || !after.EvaluatedAt.Equal(before.EvaluatedAt) {
		t.Fatalf("cleanup publication=%+v, before=%+v", after, before)
	}
	var availability string
	if err := store.db.QueryRowContext(t.Context(), "SELECT availability FROM cao_quality WHERE namespace=$1 AND collection='$audits'", store.namespace).Scan(&availability); err != nil {
		t.Fatal(err)
	}
	if availability != "empty" {
		t.Fatalf("quality does not reflect cleanup: %s", availability)
	}
	otherAfter, err := other.State(t.Context())
	if err != nil || !reflect.DeepEqual(otherAfter, otherBefore) {
		t.Fatalf("other namespace changed: %+v %v", otherAfter, err)
	}
	again, err := store.CurateAudits(t.Context())
	if err != nil || !reflect.DeepEqual(again, after) {
		t.Fatalf("idempotent cleanup changed state: %+v %v", again, err)
	}
	reopened, err := NewConfig(t.Context(), config, "other")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reopened.Close() }()
	bootstrapped, err := reopened.State(t.Context())
	if err != nil || bootstrapped.Counts["$audits"] != 0 || bootstrapped.Revision != otherBefore.Revision+1 {
		t.Fatalf("existing-data bootstrap skipped cleanup: %+v %v", bootstrapped, err)
	}
}

func TestAuditCurationCancellationUsesNamespaceWriterLock(t *testing.T) {
	store, _ := nativeTestStore(t)
	before := seedUncuratedAudits(t, store)
	writer, err := store.BeginIngestion(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Abort(t.Context())
	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel()
	if _, err := store.CurateAudits(ctx); err == nil || ctx.Err() == nil {
		t.Fatalf("cleanup bypassed the writer lock or ignored cancellation: %v", err)
	}
	writer.Abort(t.Context())
	after, err := store.State(t.Context())
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatalf("cancelled cleanup changed state: %+v %v", after, err)
	}
}

func TestAuditCurationFailureIsAtomic(t *testing.T) {
	store, _ := nativeTestStore(t)
	seedUncuratedAudits(t, store)
	if _, err := store.db.ExecContext(t.Context(), "DELETE FROM cao_quality WHERE namespace=$1 AND collection='$audits'", store.namespace); err != nil {
		t.Fatal(err)
	}
	before, err := store.State(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CurateAudits(t.Context()); err == nil {
		t.Fatal("cleanup published without retained-count quality metadata")
	}
	after, err := store.State(t.Context())
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatalf("failed cleanup advanced state: %+v %v", after, err)
	}
	var count int
	if err := store.db.QueryRowContext(t.Context(), "SELECT count(*) FROM audits WHERE namespace=$1 AND id='old'", store.namespace).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatal("failed cleanup exposed its deletion")
	}
}

func TestAuditCurationExistingMaliciousNumericsDoNotAbortCleanup(t *testing.T) {
	store, _ := nativeTestStore(t)
	writer, err := store.BeginIngestion(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Abort(t.Context())
	auditCurationParents(t, writer)
	summaries := []string{"AIC 1e999", "AIC 1e999999999999999999999999",
		"AIC 0e9999", "AIC 1e-9999", "AIC 0." + strings.Repeat("0", 65536),
		"AIC 1e" + strings.Repeat("9", 65536), "AIC " + strings.Repeat("9", 65536)}
	for index, summary := range summaries {
		row := auditRow(fmt.Sprintf("malicious-%d", index), "gh-aw-logs", "workflow_run_usage", "observed", summary,
			model.Row{"runId": "zero", "name": "legacy seed guard"})
		if err := writer.Append(t.Context(), "$audits", row); err != nil {
			t.Fatal(err)
		}
	}
	for _, row := range []model.Row{
		auditRow("delete-copy", "gh-aw-logs", "workflow_run_usage", "observed", "AIC 4.5", model.Row{"name": "legacy seed guard"}),
		auditRow("null-aic", "gh-aw-logs", "workflow_run_usage", "observed", "AIC 0", model.Row{"runId": "missing-facts"}),
	} {
		if err := writer.Append(t.Context(), "$audits", row); err != nil {
			t.Fatal(err)
		}
	}
	before, err := writer.Publish(t.Context(), "malicious-existing")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(t.Context(), "UPDATE audits SET name=NULL WHERE namespace=$1", store.namespace); err != nil {
		t.Fatal(err)
	}
	after, err := store.CurateAudits(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if after.Counts["$audits"] != len(summaries)+1 || after.Revision != before.Revision+1 ||
		after.DataRevision != before.DataRevision || !after.EvaluatedAt.Equal(before.EvaluatedAt) {
		t.Fatalf("malicious summaries aborted or corrupted cleanup: before=%+v after=%+v", before, after)
	}
	var nullAIC, malicious int
	if err := store.db.QueryRowContext(t.Context(), `SELECT count(*) FILTER (WHERE id='null-aic'),
		count(*) FILTER (WHERE id LIKE 'malicious-%') FROM audits WHERE namespace=$1`, store.namespace).Scan(&nullAIC, &malicious); err != nil {
		t.Fatal(err)
	}
	if nullAIC != 1 || malicious != len(summaries) {
		t.Fatal("malicious or null-Run-AIC evidence was deleted")
	}
	again, err := store.CurateAudits(t.Context())
	if err != nil || !reflect.DeepEqual(after, again) {
		t.Fatalf("malicious-summary cleanup is not idempotent: %+v %v", again, err)
	}
}

type auditCurationFixtureCase struct {
	Name  string          `json:"name"`
	Run   json.RawMessage `json:"run"`
	Audit model.Row       `json:"audit"`
	Drop  bool            `json:"drop"`
}

type auditCurationFixture struct {
	Run   model.Row                  `json:"run"`
	Audit model.Row                  `json:"audit"`
	Cases []auditCurationFixtureCase `json:"cases"`
}

func readAuditCurationFixture(t *testing.T) auditCurationFixture {
	t.Helper()
	content, err := os.ReadFile("../../../tests/fixtures/audit-curation.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture auditCurationFixture
	if err := decodeJSON(content, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func (fixture auditCurationFixture) records(t *testing.T, test auditCurationFixtureCase) (model.Row, model.Row) {
	t.Helper()
	run := model.Row{"workflowId": "workflow", "repositoryId": "repository"}
	for field, value := range fixture.Run {
		run[field] = value
	}
	var override model.Row
	if len(test.Run) > 0 {
		if err := decodeJSON(test.Run, &override); err != nil {
			t.Fatal(err)
		}
		if override == nil {
			run = nil
		}
	}
	for field, value := range override {
		run[field] = value
	}
	audit := model.Row{"id": test.Name}
	for field, value := range fixture.Audit {
		audit[field] = value
	}
	for field, value := range test.Audit {
		audit[field] = value
	}
	return run, audit
}

func TestAuditCurationPolicySharedFixture(t *testing.T) {
	fixture := readAuditCurationFixture(t)
	for _, test := range fixture.Cases {
		t.Run(test.Name, func(t *testing.T) {
			run, audit := fixture.records(t, test)
			if actual := discardAuditCopy(audit, run); actual != test.Drop {
				t.Fatalf("Go policy drop=%t, shared fixture expects %t", actual, test.Drop)
			}
		})
	}
}

func TestAuditCurationSharedFixture(t *testing.T) {
	fixture := readAuditCurationFixture(t)
	store, _ := nativeTestStore(t)
	for _, test := range fixture.Cases {
		t.Run(test.Name, func(t *testing.T) {
			run, audit := fixture.records(t, test)
			if run == nil {
				t.Skip("native foreign keys require an owning Run; pure policy covers unavailable Run facts")
			}
			injectedGuard := audit["name"] == nil
			writer, err := store.BeginIngestion(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			defer writer.Abort(t.Context())
			for _, record := range []struct {
				source string
				row    model.Row
			}{
				{"$repositories", model.Row{"id": "repository"}},
				{"$workflows", model.Row{"id": "workflow", "repositoryId": "repository"}},
				{"$runs", run},
				{"$audits", audit},
			} {
				err = writer.Append(t.Context(), record.source, record.row)
				if err != nil {
					switch test.Name {
					case "started-invalid-time", "safe-count-fraction", "explicit-attempt":
						if test.Drop {
							t.Fatal("unsupported evidence fixture must be retained")
						}
						t.Logf("native contract fails closed before lossy projection: %v", err)
						return
					default:
						t.Fatal(err)
					}
				}
			}
			if injectedGuard {
				if err := writer.Flush(t.Context()); err != nil {
					t.Fatal(err)
				}
				if _, err := writer.tx.Exec(t.Context(), "UPDATE audits_stage SET name=$3 WHERE namespace=$1 AND id=$2", store.namespace, test.Name, "legacy seed guard"); err != nil {
					t.Fatal(err)
				}
			}
			before, err := writer.Publish(t.Context(), "shared-fixture")
			if err != nil {
				t.Fatal(err)
			}
			if before.Counts["$audits"] != 1 {
				t.Fatal("legacy fixture seed was prematurely pruned")
			}
			if injectedGuard {
				if _, err := store.db.ExecContext(t.Context(), "UPDATE audits SET name=NULL WHERE namespace=$1 AND id=$2", store.namespace, test.Name); err != nil {
					t.Fatal(err)
				}
			}
			state, err := store.CurateAudits(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			want := 1
			if test.Drop {
				want = 0
			}
			if state.Counts["$audits"] != want {
				t.Fatalf("Go retained %d audits, shared fixture expects %d", state.Counts["$audits"], want)
			}
			wantRevision := before.Revision
			if test.Drop {
				wantRevision++
			}
			if state.Revision != wantRevision || state.DataRevision != before.DataRevision || !state.EvaluatedAt.Equal(before.EvaluatedAt) {
				t.Fatalf("fixture cleanup publication=%+v, before=%+v", state, before)
			}
		})
	}
}
