package postgresx

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

func TestWorkflowCampaignForeignKeyAndProjection(t *testing.T) {
	store, _ := nativeTestStore(t)
	writer, err := store.BeginIngestion(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Abort(t.Context())
	for _, record := range []struct {
		source string
		row    model.Row
	}{
		{"$repositories", model.Row{"id": "repository", "owner": "octo", "name": "api"}},
		{"$campaigns", model.Row{"id": "campaign", "slug": "demo", "name": "Current campaign",
			"icon": "goal", "workerCount": 0, "inventoryWarnings": 2, "aiCreditAllowance": 1.5, "readmePath": "demo/README.md"}},
		{"$workflows", model.Row{"id": "workflow", "repositoryId": "repository", "campaignId": "campaign",
			"path": ".github/workflows/demo.md", "campaignName": "Stale copy", "ghAwVersion": "v1", "ghAwCurrentVersion": "v1"}},
	} {
		if err := writer.Append(t.Context(), record.source, record.row); err != nil {
			t.Fatal(err)
		}
	}
	before, err := writer.Publish(t.Context(), "campaign-fk")
	if err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile("../../../dashboard/site/src/data/queries/database.json")
	if err != nil {
		t.Fatal(err)
	}
	var definitions []query.Definition
	if err := json.Unmarshal(content, &definitions); err != nil {
		t.Fatal(err)
	}
	sources, _, err := store.ExecuteSQLPlan(t.Context(), definitions, []string{"workflows"})
	if err != nil {
		t.Fatal(err)
	}
	row := sources["workflows"].Rows[0]
	for field, value := range map[string]any{
		"campaign": "demo", "campaign-name": "Current campaign", "campaign-icon": "goal",
		"campaign-worker-count": json.Number("0"), "campaign-inventory-warnings": json.Number("2"),
		"campaign-aic-allowance": json.Number("1.5"), "campaign-readme-path": "demo/README.md",
		"gh-aw-version-label": "v1 (current)",
	} {
		if !reflect.DeepEqual(row[field], value) {
			t.Errorf("%s=%#v, want %#v", field, row[field], value)
		}
	}
	invalid, err := store.BeginIngestion(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer invalid.Abort(t.Context())
	if err := invalid.Append(t.Context(), "$repositories", model.Row{"id": "repository"}); err != nil {
		t.Fatal(err)
	}
	if err := invalid.Append(t.Context(), "$workflows", model.Row{
		"id": "workflow", "repositoryId": "repository", "campaignId": "missing",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := invalid.Publish(t.Context(), "invalid-campaign"); err == nil {
		t.Fatal("accepted a Workflow referencing a missing Campaign")
	}
	invalid.Abort(t.Context())
	after, err := store.State(t.Context())
	if err != nil || after.Revision != before.Revision || after.DataRevision != before.DataRevision ||
		!after.EvaluatedAt.Equal(before.EvaluatedAt) || !reflect.DeepEqual(after.Counts, before.Counts) {
		t.Fatalf("invalid Campaign reference changed published state: %#v, %v", after, err)
	}
}
