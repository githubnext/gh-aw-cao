package postgresx

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

func TestCampaignNativeTableContract(t *testing.T) {
	table, exists := entityTables["$campaigns"]
	if !exists || table.name != "campaigns" || !table.canonical || table.runtime {
		t.Fatal("Campaign must have a persisted native canonical table")
	}
	fields := map[string]string{}
	for _, column := range table.columns {
		fields[column.field] = column.sql
	}
	for field, sqlType := range map[string]string{
		"id": "TEXT", "slug": "TEXT", "version": "TEXT", "currentVersion": "TEXT",
		"mode": "TEXT", "enabled": "BOOLEAN", "workerCount": "BIGINT", "observedAt": "TIMESTAMPTZ",
	} {
		if fields[field] != sqlType {
			t.Errorf("Campaign field %s has type %q; expected %q", field, fields[field], sqlType)
		}
	}
}

func TestCampaignPersistsWithoutExecutionAndRefreshesIdentity(t *testing.T) {
	store, config := nativeTestStore(t)
	definition := []query.Definition{{
		Name: "campaigns", From: "$campaigns",
		Select: []query.SelectedField{
			{Field: "id"}, {Field: "slug"}, {Field: "name"}, {Field: "mode"},
			{Field: "enabled"}, {Field: "version"}, {Field: "workerCount"}, {Field: "description"},
		},
	}}
	campaign := model.Row{
		"id": "campaign:dashboard-sources:dependabot", "slug": "dependabot",
		"name": "Dependabot", "mode": "review", "enabled": false,
		"version": "v1", "workerCount": json.Number("0"), "description": nil,
	}
	for _, version := range []string{"v1", "v2"} {
		writer, err := store.BeginIngestion(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		// Simulate run-information followed by authoritative inventory enrichment.
		err = writer.Append(t.Context(), "$campaigns", campaign)
		if err == nil {
			err = writer.AppendInventory(t.Context(), "$campaigns", model.Row{
				"id": campaign["id"], "slug": campaign["slug"], "version": version,
			})
		}
		if err == nil {
			_, err = writer.Publish(t.Context(), version)
		}
		writer.Abort(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		campaign["version"] = version
		result, _, err := store.ExecuteSQLPlan(t.Context(), definition, []string{"campaigns"})
		if err != nil || !reflect.DeepEqual(result["campaigns"].Rows, []model.Row{campaign}) {
			t.Fatalf("Campaign round trip: %#v %v", result, err)
		}
		state, err := store.State(t.Context())
		if err != nil || state.Counts["$campaigns"] != 1 || state.Counts["$workflows"] != 0 || state.Counts["$runs"] != 0 {
			t.Fatalf("idle Campaign requires execution or duplicated on refresh: %+v %v", state, err)
		}
	}

	reopened, err := NewConfig(t.Context(), config)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reopened.Close() }()
	result, _, err := reopened.ExecuteSQLPlan(t.Context(), definition, []string{"campaigns"})
	if err != nil || !reflect.DeepEqual(result["campaigns"].Rows, []model.Row{campaign}) {
		t.Fatalf("Campaign did not persist across reopen: %#v %v", result, err)
	}
	if err := reopened.DeleteNamespace(t.Context()); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := reopened.db.QueryRowContext(t.Context(), "SELECT count(*) FROM campaigns WHERE namespace=$1", reopened.namespace).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("namespace deletion left Campaign rows behind")
	}
}
