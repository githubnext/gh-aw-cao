package postgresx

import (
	"encoding/json"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/githubnext/gh-cao/server/internal/model"
	"github.com/githubnext/gh-cao/server/internal/query"
)

func evidencePacket(t *testing.T) model.Row {
	t.Helper()
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
	envelope.Packet["repositoryId"] = "repository:octo%2Fexample"
	envelope.Packet["workflowId"] = "workflow:octo%2Fexample%3A.github%2Fworkflows%2Fverify-bugs.md"
	return envelope.Packet
}

func TestOperationalValueEvidenceTypedProjection(t *testing.T) {
	packet := evidencePacket(t)
	if err := validateOperationalValueEvidence(packet); err != nil {
		t.Fatal(err)
	}
	reader := &readTransaction{store: &Store{namespace: "evidence"}}
	plan, err := query.CompileSQL(canonicalProjectionDefinitions(t), []string{"operational-value-evidence"}, reader.entitySQLSource)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(plan.CTEs, "operational_value_evidence_facts") || !strings.Contains(plan.CTEs, "source_path") {
		t.Fatal("logical evidence must project typed children and preserve source path")
	}
	if _, err := reader.entitySQLSource("$operationalValueEvidence.facts"); err == nil {
		t.Fatal("private typed child table must not become a second public logical source")
	}
	for _, mutate := range []func(model.Row){
		func(row model.Row) { row["id"] = "wrong" },
		func(row model.Row) { row["windowEnd"] = "2027-01-01T00:00:00Z" },
		func(row model.Row) { row["sourcePath"] = ".github/workflows/other.md" },
		func(row model.Row) { row["workflowId"] = "workflow:other" },
		func(row model.Row) { row["schemaVersion"] = "1" },
		func(row model.Row) { row["count"] = 3 },
		func(row model.Row) { row["facts"] = append(row["facts"].([]any), row["facts"].([]any)[0]) },
		func(row model.Row) { row["facts"].([]any)[1].(map[string]any)["url"] = "http://example.com" },
		func(row model.Row) { row["facts"].([]any)[1].(map[string]any)["url"] = "https://secret@example.com" },
		func(row model.Row) { row["facts"].([]any)[0].(map[string]any)["cadence-days"] = 0 },
		func(row model.Row) { row["facts"].([]any)[0].(map[string]any)["maturation-days"] = 0.5 },
		func(row model.Row) { row["facts"].([]any)[0].(map[string]any)["snapshot-direction"] = "sideways" },
		func(row model.Row) {
			for _, item := range row["facts"].([]any) {
				fact := item.(map[string]any)
				if fact["fact-kind"] == "snapshot" {
					delete(fact, "items-available")
				}
			}
		},
		func(row model.Row) {
			for _, item := range row["facts"].([]any) {
				fact := item.(map[string]any)
				if fact["fact-kind"] == "implementation" {
					fact["accepted-at"] = "2026-10-09T12:00:00Z"
				}
			}
		},
	} {
		packet := evidencePacket(t)
		mutate(packet)
		if err := validateOperationalValueEvidence(packet); err == nil {
			t.Fatal("malformed evidence must fail closed before storage")
		}
	}
}

func TestOperationalValueEvidenceHostedStorage(t *testing.T) {
	store, _ := nativeTestStore(t)
	packet := evidencePacket(t)
	writer, err := store.BeginIngestion(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Abort(t.Context())
	if err := writer.Append(t.Context(), "$repositories", model.Row{
		"id": packet["repositoryId"], "owner": "octo", "name": "example",
	}); err != nil {
		t.Fatal(err)
	}
	if err := writer.Append(t.Context(), "$workflows", model.Row{
		"id": packet["workflowId"], "repositoryId": packet["repositoryId"],
		"path": packet["sourcePath"], "name": "Verify bugs", "state": "unknown",
	}); err != nil {
		t.Fatal(err)
	}
	if err := writer.Append(t.Context(), "$operationalValueEvidence", packet); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Publish(t.Context(), "evidence"); err != nil {
		t.Fatal(err)
	}
	sources, metrics, err := store.ExecuteSQLPlan(t.Context(), canonicalProjectionDefinitions(t), []string{"operational-value-evidence"})
	if err != nil {
		t.Fatal(err)
	}
	rows := sources["operational-value-evidence"].Rows
	metadata := sources["operational-value-evidence"].Metadata
	if metadata["as-of"] != packet["windowEnd"] || metadata["retrieved-at"] != packet["observedAt"] ||
		metadata["completeness"] != "unknown" || metadata["freshness"] != "unknown" {
		t.Fatalf("hosted evidence must retain cutoff/capture without asserting quality: %v", metadata)
	}
	if len(rows) != len(packet["facts"].([]any)) || !slices.Contains(metrics.PushedDown, "sql-plan") {
		t.Fatal("hosted evidence must execute against typed facts entirely through SQL")
	}
	for _, row := range rows {
		if row["report-id"] != packet["id"] || row["repository"] != "example" ||
			row["workflow-path"] != ".github/workflows/verify-bugs.md" {
			t.Fatalf("incorrect common fact identity: %v", row)
		}
	}
}
