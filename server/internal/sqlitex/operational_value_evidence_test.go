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
	defer store.Close()
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
