package postgresx

import (
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
)

func TestReviewedInventoryRefreshesWorkflowMetadata(t *testing.T) {
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
		{"$workflows", model.Row{"id": "workflow", "repositoryId": "repository", "path": ".github/workflows/test.md",
			"name": "Previous name", "state": "unknown", "role": "worker"}},
	} {
		if err := writer.Append(t.Context(), record.source, record.row); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.AppendInventory(t.Context(), "$workflows", model.Row{
		"id": "workflow", "repositoryId": "repository", "path": ".github/workflows/test.md",
		"name": "Current name", "state": "active", "role": nil,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Publish(t.Context(), "reviewed-inventory"); err != nil {
		t.Fatal(err)
	}
	var name, state, role string
	if err := store.db.QueryRowContext(t.Context(), "SELECT name,state,role FROM workflows WHERE namespace=$1", store.namespace).
		Scan(&name, &state, &role); err != nil {
		t.Fatal(err)
	}
	if name != "Current name" || state != "active" || role != "worker" {
		t.Fatalf("inventory refresh changed identity or lost observed fields: %s %s %s", name, state, role)
	}
}
