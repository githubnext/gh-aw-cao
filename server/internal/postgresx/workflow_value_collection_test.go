package postgresx

import (
	"encoding/json"
	"fmt"
	"maps"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-cao/server/internal/model"
)

func collectionFixture(t *testing.T) model.Row {
	t.Helper()
	content, err := os.ReadFile("../../../dashboard/site/test/fixtures/workflow-value-collection.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	var envelope struct {
		Record model.Row `json:"workflow_value_collection"`
	}
	if err := json.Unmarshal(content, &envelope); err != nil {
		t.Fatal(err)
	}
	envelope.Record["repositoryId"] = "repository:octo%2Fexample"
	envelope.Record["workflowId"] = "workflow:octo%2Fexample%3A.github%2Fworkflows%2Fverify-bugs.md"
	return envelope.Record
}

func TestWorkflowValueCollectionValidation(t *testing.T) {
	if err := validateWorkflowValueCollection(collectionFixture(t)); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"observedAt", "lastAttemptAt"} {
		for _, clock := range []string{"2026-10-22T12:00:00.000001Z", "2026-10-22T12:00:00+00:00"} {
			record := collectionFixture(t)
			record[field] = clock
			if err := validateWorkflowValueCollection(record); err == nil {
				t.Fatalf("%s must preserve common UTC millisecond precision: %s", field, clock)
			}
		}
	}
	for field, value := range map[string]any{
		"id": "wrong", "sourcePath": ".github/workflows/other.md", "schemaVersion": "1",
		"registration": "disabled", "lastAttemptAt": "2026-10-25T00:00:00Z",
		"lastAttemptOutcome": "deferred", "capturedAt": "2026-10-23T14:00:00Z",
		"collector": "../escape.mjs", "workflowId": "workflow:other", "reason": "invented",
		"state": "available",
	} {
		record := collectionFixture(t)
		record[field] = value
		if err := validateWorkflowValueCollection(record); err == nil {
			t.Fatalf("invalid %s must fail before native storage", field)
		}
		disabled := collectionFixture(t)
		delete(disabled, "collector")
		disabled["registration"], disabled["state"], disabled["reasonCode"] = "disabled", "disabled", "disabled"
		disabled["reason"] = valueCollectionReasons["disabled"]
		if err := validateWorkflowValueCollection(disabled); err != nil {
			t.Fatal("a disabled registration need not retain an executable collector", err)
		}
	}
}

func TestWorkflowValueCollectionHostedStorage(t *testing.T) {
	store, _ := nativeTestStore(t)
	record := collectionFixture(t)
	writer, err := store.BeginIngestion(t.Context())
	if err != nil {
		t.Fatal(err)
	}

	defer writer.Abort(t.Context())
	for source, row := range map[string]model.Row{
		"$repositories":             {"id": record["repositoryId"], "owner": "octo", "name": "example"},
		"$workflows":                {"id": record["workflowId"], "repositoryId": record["repositoryId"], "path": record["sourcePath"], "state": "unknown"},
		"$workflowValueCollections": record,
	} {
		if err := writer.Append(t.Context(), source, row); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := writer.Publish(t.Context(), "collection-without-a-capture"); err != nil {
		t.Fatal(err)
	}
	sources, _, err := store.ExecuteSQLPlan(t.Context(), canonicalProjectionDefinitions(t), []string{"workflow-value-collections"})
	if err != nil {
		t.Fatal(err)
	}
	result := sources["workflow-value-collections"]
	if len(result.Rows) != 1 || result.Rows[0]["registration"] != "enabled" ||
		result.Rows[0]["collection-state"] != "deferred" || result.Rows[0]["reason-code"] != "api-budget" {
		t.Fatalf("collection facts were lost or required a report: %+v", result)
	}
	for field, original := range map[string]string{"checked-at": "observedAt", "last-attempt-at": "lastAttemptAt"} {
		got, err := evidenceTime(result.Rows[0][field])
		want, _ := evidenceTime(record[original])
		if err != nil || !got.Equal(want) {
			t.Fatalf("original %s changed: %v", field, result.Rows[0])
		}
	}
	if result.Metadata["freshness"] != "unknown" {
		t.Fatalf("a decision must not declare measurement freshness: %v", result.Metadata)
	}
}

func publishCollectionHealth(t *testing.T, store *Store, record model.Row, revision string) error {
	t.Helper()
	writer, err := store.BeginIngestion(t.Context())
	if err != nil {
		return err
	}
	defer writer.Abort(t.Context())
	if record != nil {
		for source, row := range map[string]model.Row{
			"$repositories":             {"id": record["repositoryId"], "owner": "octo", "name": "example"},
			"$workflows":                {"id": record["workflowId"], "repositoryId": record["repositoryId"], "path": record["sourcePath"], "state": "unknown"},
			"$workflowValueCollections": record,
		} {
			if err := writer.Append(t.Context(), source, row); err != nil {
				return err
			}
		}
	}
	_, err = writer.Publish(t.Context(), revision)
	return err
}

func TestWorkflowValueCollectionRetainsIndependentClocks(t *testing.T) {
	store, _ := nativeTestStore(t)
	original := collectionFixture(t)
	publish := func(record model.Row, revision string) error {
		return publishCollectionHealth(t, store, record, revision)
	}
	if err := publish(original, "original"); err != nil {
		t.Fatal(err)
	}
	clock, _ := evidenceTime(original["observedAt"])
	for _, scenario := range []string{"conflicting-decision", "conflicting-attempt"} {
		record := maps.Clone(original)
		switch scenario {
		case "conflicting-decision":
			record["reasonCode"] = "shared-budget-unavailable"
			record["reason"] = valueCollectionReasons["shared-budget-unavailable"]
		case "conflicting-attempt":
			record["observedAt"] = clock.Add(time.Hour).Format(time.RFC3339)
			record["lastAttemptOutcome"] = "available"
		}
		if err := publish(record, scenario); err == nil || !strings.Contains(err.Error(), "accepted history") {
			t.Fatalf("%s snapshot must not overwrite accepted decisions: %v", scenario, err)
		}
	}
	sources, _, err := store.ExecuteSQLPlan(t.Context(), canonicalProjectionDefinitions(t), []string{"workflow-value-collections"})
	if err != nil {
		t.Fatal(err)
	}
	rows := sources["workflow-value-collections"].Rows
	if len(rows) != 1 || rows[0]["reason-code"] != "api-budget" || rows[0]["last-attempt-outcome"] != "failed" {
		t.Fatalf("failed imports changed accepted health: %v", rows)
	}
	stale := maps.Clone(original)
	stale["observedAt"] = clock.Add(-time.Second).Format(time.RFC3339)
	if err := publish(stale, "stale"); err != nil {
		t.Fatal("stale health must not roll back a decision or block ordinary publication", err)
	}
	regressed := maps.Clone(original)
	regressed["observedAt"] = clock.Add(time.Hour).Format(time.RFC3339)
	regressed["lastAttemptAt"] = clock.Add(-48 * time.Hour).Format(time.RFC3339)
	if err := publish(regressed, "older-attempt"); err != nil {
		t.Fatal("an older attempt must not erase a later known one", err)
	}
	unknown := maps.Clone(original)
	unknown["observedAt"] = clock.Add(time.Hour).Format(time.RFC3339)
	delete(unknown, "lastAttemptAt")
	delete(unknown, "lastAttemptOutcome")
	if err := publish(unknown, "unknown-attempt"); err != nil {
		t.Fatal("unknown attempts must not erase known history or prevent ordinary publication", err)
	}
	sources, _, err = store.ExecuteSQLPlan(t.Context(), canonicalProjectionDefinitions(t), []string{"workflow-value-collections"})
	if err != nil {
		t.Fatal(err)
	}
	rows = sources["workflow-value-collections"].Rows
	if len(rows) != 1 || rows[0]["last-attempt-outcome"] != "failed" || rows[0]["last-attempt-at"] == nil {
		t.Fatalf("unknown attempts erased accepted history: %v", rows)
	}
	disabled := maps.Clone(original)
	disabled["observedAt"] = clock.Add(2 * time.Hour).Format(time.RFC3339)
	disabled["registration"], disabled["state"], disabled["reasonCode"] = "disabled", "disabled", "disabled"
	disabled["reason"] = valueCollectionReasons["disabled"]
	delete(disabled, "collector")
	if err := publish(disabled, "disabled"); err != nil {
		t.Fatal(err)
	}
	if err := publish(original, "disabled-replay"); err != nil {
		t.Fatal(err)
	}
	sources, _, err = store.ExecuteSQLPlan(t.Context(), canonicalProjectionDefinitions(t), []string{"workflow-value-collections"})
	if err != nil {
		t.Fatal(err)
	}
	rows = sources["workflow-value-collections"].Rows
	if len(rows) != 1 || rows[0]["registration"] != "disabled" || rows[0]["collector"] != nil {
		t.Fatalf("stale replay revived a disabled collector: %v", rows)
	}
	if err := publish(nil, "withdrawn"); err != nil {
		t.Fatal("protecting clocks must not restore withdrawn collection records", err)
	}
}

func TestWorkflowValueCollectionSnapshotPermutationConvergence(t *testing.T) {
	store, _ := nativeTestStore(t)
	older := collectionFixture(t)
	attempted := maps.Clone(older)
	attempted["observedAt"] = "2026-10-23T15:00:00Z"
	attempted["lastAttemptAt"], attempted["lastAttemptOutcome"] = "2026-10-23T14:30:00Z", "available"
	deferred := maps.Clone(older)
	deferred["observedAt"] = "2026-10-24T14:00:00Z"
	delete(deferred, "lastAttemptAt")
	delete(deferred, "lastAttemptOutcome")
	records := []model.Row{older, attempted, deferred}
	for _, order := range [][]int{{0, 1, 2}, {0, 2, 1}, {1, 0, 2}, {1, 2, 0}, {2, 0, 1}, {2, 1, 0}} {
		if err := publishCollectionHealth(t, store, nil, "reset"); err != nil {
			t.Fatal(err)
		}
		for pass := range 2 {
			for index, record := range order {
				if err := publishCollectionHealth(t, store, records[record], fmt.Sprintf("%v-%d-%d", order, pass, index)); err != nil {
					t.Fatalf("order %v: %v", order, err)
				}
			}
		}
		sources, _, err := store.ExecuteSQLPlan(t.Context(), canonicalProjectionDefinitions(t), []string{"workflow-value-collections"})
		if err != nil {
			t.Fatal(err)
		}
		rows := sources["workflow-value-collections"].Rows
		if len(rows) != 1 || rows[0]["registration"] != "enabled" || rows[0]["reason-code"] != "api-budget" ||
			rows[0]["last-attempt-outcome"] != "available" {
			t.Fatalf("order %v lost independent collection facts: %v", order, rows)
		}
		for field, want := range map[string]any{"checked-at": deferred["observedAt"], "last-attempt-at": attempted["lastAttemptAt"]} {
			actual, err := evidenceTime(rows[0][field])
			expected, _ := evidenceTime(want)
			if err != nil || !actual.Equal(expected) {
				t.Fatalf("order %v changed %s: %v", order, field, rows)
			}
		}
	}
}
