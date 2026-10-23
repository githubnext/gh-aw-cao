package sqlitex

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/githubnext/gh-cao/server/internal/dashboardstore"
	"github.com/githubnext/gh-cao/server/internal/model"
	"github.com/githubnext/gh-cao/server/internal/query"
	"github.com/githubnext/gh-cao/server/internal/testutil"
)

func TestSnapshotOperationalValueEvidenceFromExportedLedger(t *testing.T) {
	content, err := os.ReadFile("../../../dashboard/site/test/fixtures/operational-value-evidence.jsonl")
	if err != nil {
		t.Fatal(err)
	}

	var envelope struct {
		Packet model.Row `json:"operational_value_evidence"`
	}
	if err := json.Unmarshal(content, &envelope); err != nil {
		t.Fatal(err)
	}
	path := testutil.SQLiteSnapshot(t, map[string][]model.Row{"operationalValueEvidence": {envelope.Packet}})
	store, err := Open(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Error(err)
		}
	})
	content, err = os.ReadFile("../../../dashboard/site/src/data/queries/database.json")
	if err != nil {
		t.Fatal(err)
	}
	var definitions []query.Definition
	if err := json.Unmarshal(content, &definitions); err != nil {
		t.Fatal(err)
	}
	var sources map[string]model.Source
	err = store.WithReadTransaction(t.Context(), func(ctx context.Context, reader dashboardstore.Reader) error {
		var err error
		sources, _, err = reader.ExecuteSQLPlan(ctx, definitions, []string{"operational-value-evidence"})
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	rows := sources["operational-value-evidence"].Rows
	metadata := sources["operational-value-evidence"].Metadata
	if metadata["as-of"] != envelope.Packet["windowEnd"] || metadata["retrieved-at"] != envelope.Packet["observedAt"] {
		t.Fatalf("original cutoff/capture clocks were lost: %v", metadata)
	}
	if len(rows) != len(envelope.Packet["facts"].([]any)) {
		t.Fatal("SQLite must project every exported fact without computing a report")
	}
	for _, row := range rows {
		if row["report-id"] != envelope.Packet["id"] || row["workflow-path"] != ".github/workflows/verify-bugs.md" {
			t.Fatalf("incorrect packet identity or immutable workflow path: %v", row)
		}
	}
}

func TestSnapshotWorkflowValueCollectionWithoutReport(t *testing.T) {
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
	record := envelope.Record
	record["repositoryId"] = "repository:octo%2Fexample"
	record["workflowId"] = "workflow:octo%2Fexample%3A.github%2Fworkflows%2Fverify-bugs.md"
	path := testutil.SQLiteSnapshot(t, map[string][]model.Row{
		"workflowValueCollections": {record},
		"repositories":             {{"id": record["repositoryId"], "owner": "octo", "name": "example"}},
		"workflows":                {{"id": record["workflowId"], "repositoryId": record["repositoryId"], "path": record["sourcePath"]}},
	})
	store, err := Open(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	content, err = os.ReadFile("../../../dashboard/site/src/data/queries/database.json")
	if err != nil {
		t.Fatal(err)
	}
	var definitions []query.Definition
	if err := json.Unmarshal(content, &definitions); err != nil {
		t.Fatal(err)
	}
	err = store.WithReadTransaction(t.Context(), func(ctx context.Context, reader dashboardstore.Reader) error {
		sources, _, err := reader.ExecuteSQLPlan(ctx, definitions, []string{"workflow-value-collections"})
		if err != nil {
			return err
		}
		rows := sources["workflow-value-collections"].Rows
		if len(rows) != 1 || rows[0]["registration"] != "enabled" || rows[0]["reason-code"] != "api-budget" ||
			rows[0]["checked-at"] != record["observedAt"] || rows[0]["last-attempt-at"] != record["lastAttemptAt"] {
			t.Fatalf("SQLite lost independent decision and attempt facts without a report: %+v", rows)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
