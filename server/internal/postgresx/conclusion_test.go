package postgresx

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/githubnext/gh-cao/server/internal/admission"
	"github.com/githubnext/gh-cao/server/internal/model"
	"github.com/githubnext/gh-cao/server/internal/query"
)

func canonicalConclusionInput(identity admission.Identity) admission.ConclusionRequest {
	return admission.ConclusionRequest{
		Session: strings.Join([]string{
			`{"type":"session.format","data":{"version":1}}`,
			`{"type":"workflow.info","data":{"engineId":"copilot","model":"model-1","agentVersion":"1.2","runId":"9007199254740993","runAttempt":2}}`,
			`{"type":"session.result","data":{"status":"success","usage":{"inputTokens":999,"outputTokens":999}}}`,
			`{"type":"firewall.token_usage","data":{"aic":100,"usage":{"inputTokens":800,"outputTokens":800}}}`,
			`{"type":"usage.report","data":{"aic":0.5,"totalAic":1.5,"usage":{"inputTokens":10,"outputTokens":2}},"provenance":{"phase":"agent"}}`,
			`{"type":"usage.report","data":{"aic":0.25,"totalAic":2,"usage":{"inputTokens":20,"outputTokens":3}},"provenance":{"phase":"agent"}}`,
			`{"type":"usage.report","data":{"aic":0,"usage":{"inputTokens":0,"reasoningOutputTokens":5}},"provenance":{"phase":"evals"}}`,
			`{"type":"execution.result","data":{"outcome":"success","finishedAt":"2026-01-01T00:00:00Z"}}`,
			`{"type":"grader.result","data":{"id":"accuracy","value":0.75,"unit":"ratio","passed":true}}`,
		}, "\n") + "\n",
		SessionCompaction: admission.SessionCompaction{Version: 1, IncludedEvents: 9, OmittedEvents: 3, Truncated: true},
		UsageArtifactIDs:  []string{"99999999999999999999"},
		Request: admission.Request{Repo: identity.Repository, RunID: identity.RunID, RunAttempt: identity.RunAttempt,
			WorkflowID: identity.WorkflowRef, WorkflowCallID: identity.RunID + "-" + identity.RunAttempt + ":" + identity.WorkflowRef},
	}
}

func conclusionRows(t *testing.T, store *Store, source string, fields ...string) []model.Row {
	t.Helper()
	selected := make([]query.SelectedField, len(fields))
	for n, field := range fields {
		selected[n] = query.SelectedField{Field: field}
	}
	results, metadata, err := store.ExecuteSQLPlan(t.Context(), []query.Definition{{
		Name: "conclusion-facts", From: source, Select: selected,
	}}, []string{"conclusion-facts"})
	if err != nil {
		t.Fatal(err)
	}
	if results["conclusion-facts"].Metadata["completeness"] != "partial" {
		t.Fatalf("compact evidence claimed complete: %+v %+v", results["conclusion-facts"].Metadata, metadata)
	}
	return results["conclusion-facts"].Rows
}

func TestConclusionPopulatesCanonicalQuerySourcesIdempotently(t *testing.T) {
	store, _ := nativeTestStore(t)
	identity := admissionIdentity()
	input := canonicalConclusionInput(identity)
	at := time.Now().UTC().Truncate(time.Microsecond)
	if err := store.RecordConcludedRun(t.Context(), identity, input, at); err != nil {
		t.Fatal(err)
	}
	runs := conclusionRows(t, store, "$runs", "id", "githubRunId", "attempt", "engineId", "modelId",
		"inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "aicTotal", "status", "conclusion",
		"startedAt", "completedAt", "admissionStatus", "updatedAt")
	if len(runs) != 1 || runs[0]["githubRunId"] != identity.RunID ||
		runs[0]["engineId"] != "copilot" || runs[0]["modelId"] != "model-1" ||
		fmt.Sprint(runs[0]["inputTokens"]) != "30" || fmt.Sprint(runs[0]["outputTokens"]) != "5" ||
		fmt.Sprint(runs[0]["reasoningTokens"]) != "5" || fmt.Sprint(runs[0]["aicTotal"]) != "2" {
		t.Fatalf("callback facts missing from canonical query result: %+v", runs)
	}
	for _, field := range []string{"cacheReadTokens", "status", "conclusion", "startedAt", "completedAt", "admissionStatus"} {
		if _, exists := runs[0][field]; exists {
			t.Fatalf("callback invented API status, admission or unavailable usage: %s", field)
		}
	}
	audits := conclusionRows(t, store, "$audits", "id", "type", "runId", "timestamp", "observedAt", "sourceSequence", "totalEvents", "eventsTruncated", "value", "code")
	if len(audits) != 12 {
		t.Fatalf("compact timeline/coverage not materialized: %+v", audits)
	}
	for _, audit := range audits {
		if _, exists := audit["timestamp"]; exists || audit["observedAt"] == nil {
			t.Fatal("untimed evidence lost observation provenance or gained an invented event clock")
		}
	}
	graders := conclusionRows(t, store, "$graders", "id", "workflowId", "name", "unit")
	observations := conclusionRows(t, store, "$graderObservations", "id", "graderId", "runId", "value", "status", "auditId", "timestamp", "provenance")
	if len(graders) != 1 || graders[0]["name"] != "accuracy" || len(observations) != 1 ||
		observations[0]["graderId"] != graders[0]["id"] || fmt.Sprint(observations[0]["value"]) != "0.75" ||
		observations[0]["status"] != "passed" || observations[0]["auditId"] == nil {
		t.Fatalf("grader facts not linked: %+v %+v", graders, observations)
	}
	before, err := store.State(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	var group sync.WaitGroup
	for n := 0; n < 6; n++ {
		group.Go(func() {
			if err := store.RecordConcludedRun(t.Context(), identity, input, at); err != nil {
				t.Error(err)
			}
		})
	}
	group.Wait()
	after, err := store.State(t.Context())
	if err != nil || before.Revision != after.Revision {
		t.Fatal("identical retry published another canonical revision")
	}
	changed := input
	changed.SessionCompaction.OmittedEvents++
	if err := store.RecordConcludedRun(t.Context(), identity, changed, at); !errors.Is(err, admission.ErrDenied) {
		t.Fatal("conflicting conclusion mutated accepted canonical facts")
	}
	for n := 0; n < 2; n++ {
		writer, err := store.BeginIngestion(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Publish(t.Context(), "unrelated"); err != nil {
			writer.Abort(t.Context())
			t.Fatal(err)
		}
		writer.Abort(t.Context())
		if actual := conclusionRows(t, store, "$graderObservations", "id", "graderId", "runId", "value", "status", "auditId", "timestamp", "provenance"); !reflect.DeepEqual(actual, observations) {
			t.Fatalf("unrelated ingestion erased callback facts: %+v", actual)
		}
		if actual := conclusionRows(t, store, "$runs", "id", "githubRunId", "attempt", "engineId", "modelId",
			"inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "aicTotal", "status", "conclusion",
			"startedAt", "completedAt", "admissionStatus", "updatedAt"); !reflect.DeepEqual(actual, runs) {
			t.Fatal("unrelated ingestion changed callback run")
		}
	}
}

func TestConclusionAttemptAndCollectedEvidencePrecedence(t *testing.T) {
	store, _ := nativeTestStore(t)
	identity := admissionIdentity()
	if err := store.RecordAdmittedRun(t.Context(), identity); err != nil {
		t.Fatal(err)
	}
	input := canonicalConclusionInput(identity)
	at := time.Now().UTC()
	if err := store.RecordConcludedRun(t.Context(), identity, input, at); err != nil {
		t.Fatal(err)
	}
	rows := admissionRunRows(t, store)
	if len(rows) != 1 || rows[0]["admissionStatus"] != "admitted" {
		t.Fatal("actual activation evidence lost")
	}
	seed := func(attempt int) {
		t.Helper()
		writer, err := store.BeginIngestion(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		defer writer.Abort(t.Context())
		for _, record := range []struct {
			source string
			row    model.Row
		}{
			{"$repositories", model.Row{"id": rows[0]["repositoryId"], "owner": "acme", "name": "project"}},
			{"$workflows", model.Row{"id": rows[0]["workflowId"], "repositoryId": rows[0]["repositoryId"], "path": ".github/workflows/triage.md"}},
			{"$runs", model.Row{"id": rows[0]["id"], "repositoryId": rows[0]["repositoryId"], "workflowId": rows[0]["workflowId"],
				"attempt": attempt, "status": "completed", "conclusion": "failure", "aicTotal": 8}},
			{"$audits", model.Row{"id": "collected", "runId": rows[0]["id"], "source": "session", "type": "execution.result", "status": "failure"}},
		} {
			if err := writer.Append(t.Context(), record.source, record.row); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := writer.Publish(t.Context(), "collected"); err != nil {
			t.Fatal(err)
		}
	}
	seed(1)
	if current := admissionRunRows(t, store); !reflect.DeepEqual(current, rows) {
		t.Fatal("stale collected attempt downgraded newer callback")
	}
	seed(2)
	current := admissionRunRows(t, store)
	if len(current) != 1 || current[0]["conclusion"] != "failure" || fmt.Sprint(current[0]["aicTotal"]) != "8" {
		t.Fatalf("collected run did not supersede partial callback: %+v", current)
	}
	before, _ := store.State(t.Context())
	if err := store.RecordConcludedRun(t.Context(), identity, input, at); err != nil {
		t.Fatal(err)
	}
	after, _ := store.State(t.Context())
	if before.Revision != after.Revision || !reflect.DeepEqual(current, admissionRunRows(t, store)) {
		t.Fatal("late conclusion retry downgraded collected evidence")
	}
	identity.RunAttempt = "3"
	input = canonicalConclusionInput(identity)
	if err := store.RecordConcludedRun(t.Context(), identity, input, at); err != nil {
		t.Fatal(err)
	}
	current = admissionRunRows(t, store)
	if len(current) != 1 || fmt.Sprint(current[0]["attempt"]) != "3" || current[0]["admissionStatus"] != nil ||
		current[0]["conclusion"] != nil {
		t.Fatal("rerun mixed previous attempt's facts")
	}
	var old int
	if err := store.db.QueryRowContext(t.Context(), `SELECT count(*) FROM audits WHERE namespace=$1 AND id='collected'`, store.namespace).Scan(&old); err != nil || old != 0 {
		t.Fatal("new attempt retained older attempt's timeline")
	}
}

func TestConclusionPublicationRollsBackAndRecovers(t *testing.T) {
	store, _ := nativeTestStore(t)
	identity := admissionIdentity()
	input := canonicalConclusionInput(identity)
	at := time.Now().UTC()
	if _, err := store.db.ExecContext(t.Context(), `ALTER TABLE audits ADD CONSTRAINT reject_conclusion CHECK (source<>'conclusion-admission') NOT VALID`); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordConcludedRun(t.Context(), identity, input, at); err == nil {
		t.Fatal("partial canonical population acknowledged")
	}
	var count int
	if err := store.db.QueryRowContext(t.Context(), `SELECT count(*) FROM runs WHERE namespace=$1`, store.namespace).Scan(&count); err != nil || count != 0 {
		t.Fatal("failed publication leaked a run")
	}
	if _, err := store.db.ExecContext(t.Context(), `ALTER TABLE audits DROP CONSTRAINT reject_conclusion`); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordConcludedRun(t.Context(), identity, input, at); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := store.RecordConcludedRun(ctx, identity, input, at); err == nil {
		t.Fatal("database outage acknowledged")
	}
}

func TestConclusionEnrichesAPIOnlyRunsAndReplacement(t *testing.T) {
	store, _ := nativeTestStore(t)
	identity := admissionIdentity()
	runID := "github:run:acme/project:" + identity.RunID
	seed := func(status, conclusion string, aic int) {
		t.Helper()
		writer, err := store.BeginIngestion(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		defer writer.Abort(t.Context())
		for source, rows := range map[string][]model.Row{
			"$repositories": {{"id": "github:repository:1001", "owner": "acme", "name": "project"}},
			"$workflows":    {{"id": "github:workflow:2002", "repositoryId": "github:repository:1001", "path": ".github/workflows/triage.md"}},
			"$runs": {{"id": runID, "repositoryId": "github:repository:1001", "workflowId": "github:workflow:2002",
				"attempt": 2, "status": status, "conclusion": conclusion, "aicTotal": aic}},
			"$audits": {{"id": "api-only-audit", "runId": runID, "source": "gh-aw-logs", "type": "workflow_run_started", "status": status}},
		} {
			for _, row := range rows {
				if err := writer.Append(t.Context(), source, row); err != nil {
					t.Fatal(err)
				}
			}
		}
		if _, err := writer.Publish(t.Context(), "api-only"); err != nil {
			t.Fatal(err)
		}
	}
	seed("in_progress", "", 9)
	at := time.Now().UTC()
	if err := store.RecordConcludedRun(t.Context(), identity, canonicalConclusionInput(identity), at); err != nil {
		t.Fatal(err)
	}
	for _, expected := range []struct {
		status, conclusion, aic string
	}{{"in_progress", "", "9"}, {"completed", "failure", "10"}} {
		runs := conclusionRows(t, store, "$runs", "id", "status", "conclusion", "aicTotal", "inputTokens", "repositoryId", "workflowId")
		if len(runs) != 1 || runs[0]["status"] != expected.status || runs[0]["conclusion"] != expected.conclusion ||
			fmt.Sprint(runs[0]["aicTotal"]) != expected.aic || fmt.Sprint(runs[0]["inputTokens"]) != "30" ||
			runs[0]["workflowId"] != "github:workflow:2002" || runs[0]["repositoryId"] != "github:repository:1001" {
			t.Fatalf("API-only enrichment lost collected facts or compact evidence: %+v", runs)
		}
		observations := conclusionRows(t, store, "$graderObservations", "graderId", "value")
		if len(observations) != 1 || fmt.Sprint(observations[0]["value"]) != "0.75" {
			t.Fatal("API-only replacement erased compact grader evidence")
		}
		var duplicates int
		if err := store.db.QueryRowContext(t.Context(), `SELECT count(*) FROM (
			SELECT ordinal FROM audits WHERE namespace=$1 GROUP BY ordinal HAVING count(*)>1) d`,
			store.namespace).Scan(&duplicates); err != nil || duplicates != 0 {
			t.Fatal("restored and incoming records share unstable source ordering")
		}
		if expected.status == "in_progress" {
			seed("completed", "failure", 10)
		}
	}
}

func TestConclusionSharedGradersRebindAllRetainedRuns(t *testing.T) {
	store, _ := nativeTestStore(t)
	identity := admissionIdentity()
	at := time.Now().UTC()
	ids := []string{identity.RunID, "9007199254740994"}
	for _, id := range ids {
		identity.RunID = id
		if err := store.RecordConcludedRun(t.Context(), identity, canonicalConclusionInput(identity), at); err != nil {
			t.Fatal(err)
		}
	}
	writer, err := store.BeginIngestion(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Abort(t.Context())
	for _, record := range []struct {
		source string
		row    model.Row
	}{
		{"$repositories", model.Row{"id": "github:repository:1001", "owner": "acme", "name": "project"}},
		{"$workflows", model.Row{"id": "github:workflow:2002", "repositoryId": "github:repository:1001", "path": ".github/workflows/triage.md"}},
		{"$runs", model.Row{"id": "github:run:acme/project:" + ids[0], "attempt": 2, "repositoryId": "github:repository:1001",
			"workflowId": "github:workflow:2002", "owner": "acme", "repository": "project", "workflowPath": ".github/workflows/triage.md", "status": "completed"}},
		{"$graders", model.Row{"id": "collected-grader", "workflowId": "github:workflow:2002", "name": "accuracy", "sourceGraderId": "accuracy"}},
	} {
		if err := writer.Append(t.Context(), record.source, record.row); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := writer.Publish(t.Context(), "partial-inventory-rebind"); err != nil {
		t.Fatal(err)
	}
	graders := conclusionRows(t, store, "$graders", "id", "workflowId")
	observations := conclusionRows(t, store, "$graderObservations", "graderId", "runId")
	runs := conclusionRows(t, store, "$runs", "workflowId", "repositoryId")
	if len(graders) != 1 || graders[0]["id"] != "collected-grader" || len(observations) != 2 || len(runs) != 2 {
		t.Fatalf("shared identities duplicated during partial snapshot: %+v %+v %+v", graders, observations, runs)
	}
	for _, row := range observations {
		if row["graderId"] != "collected-grader" {
			t.Fatal("retained observation did not reuse the canonical grader definition")
		}
	}
	for _, row := range runs {
		if row["workflowId"] != "github:workflow:2002" || row["repositoryId"] != "github:repository:1001" {
			t.Fatal("only the incoming run rebound canonical inventory identities")
		}
	}
}
