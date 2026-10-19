package sqlitex

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
)

func putInventory(t *testing.T, path string, sources map[string]model.Source) {
	t.Helper()
	content, err := json.Marshal(sources)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(filepath.Dir(path), "inventory-sources.json"), content, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestNativeInventoryProvidesCanonicalParentsWithoutChangingSnapshot(t *testing.T) {
	path := nativeSnapshot(t, nil)
	putInventory(t, path, map[string]model.Source{
		"campaigns":    {Rows: []model.Row{{"campaign": "demo", "campaign-name": "Demo"}}},
		"repositories": {Rows: []model.Row{{"organization": "octo", "repository": "repo", "visibility": "private"}}},
		"workflows": {
			Rows: []model.Row{{
				"organization": "octo", "repository": "repo", "workflow": "first.lock.yml", "campaign": "demo",
				"gh-aw-version": "v0.92.0", "gh-aw-current-version": "v0.92.0", "gh-aw-update-state": "up-to-date",
			}},
			Metadata: model.Metadata{"as-of": "2026-10-18T10:00:00Z", "completeness": "complete"},
		},
	})
	before, err := readSidecar(path, maxInventoryBytes)
	if err != nil {
		t.Fatal(err)
	}
	store, err := Open(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	sources, _, err := store.ExecuteSQLPlan(t.Context(), canonicalDefinitions(t), []string{"workflows", "$workflows", "$repositories", "$campaigns"})
	if err != nil {
		t.Fatal(err)
	}
	workflow := sources["$workflows"].Rows[0]
	for field, expected := range map[string]any{
		"id": "workflow:octo%2Frepo%3A.github%2Fworkflows%2Ffirst.md", "repositoryId": "repository:octo%2Frepo",
		"path": ".github/workflows/first.md", "ghAwVersion": "v0.92.0", "ghAwUpdateState": "up-to-date",
		"campaignId": "campaign:dashboard-sources:demo", "observedAt": "2026-10-18T10:00:00Z",
	} {
		if workflow[field] != expected {
			t.Errorf("canonical %s=%#v, expected %#v", field, workflow[field], expected)
		}
	}
	if logical := sources["workflows"].Rows[0]; logical["campaign-name"] != "Demo" || logical["gh-aw-version"] != "v0.92.0" {
		t.Fatalf("inventory did not flow through canonical database queries: %#v", logical)
	}
	state, err := store.State(t.Context())
	if err != nil || !state.Ready || state.Counts["$workflows"] != 1 || state.Counts["$repositories"] != 1 || state.Counts["$campaigns"] != 1 {
		t.Fatalf("inventory state: %#v %v", state, err)
	}
	diagnostics, err := store.Diagnostics(t.Context())
	if err != nil || diagnostics.Counts["workflows"] != 1 || len(diagnostics.RelationshipErrors) != 0 {
		t.Fatalf("inventory diagnostics: %#v %v", diagnostics, err)
	}
	after, err := readSidecar(path, maxInventoryBytes)
	if err != nil {
		t.Fatal(err)
	}
	equalJSON(t, after, before)
}

func TestNativeInventoryCompilerEvidenceMatchesAliasesAndIsolatesRepositories(t *testing.T) {
	paths := []string{"first.md", "first.lock.yml", ".github/workflows/first.md", ".github/workflows/first.lock.yml"}
	for _, inventoryPath := range paths {
		for _, canonicalPath := range paths {
			for _, updateState := range []string{"up-to-date", "unknown"} {
				t.Run(inventoryPath+"/"+canonicalPath+"/"+updateState, func(t *testing.T) {
					path := nativeSnapshot(t, map[string][]model.Row{
						"workflows": {
							{"id": "workflow:first", "repositoryId": "repository:octo%2Frepo", "path": canonicalPath, "name": "Historical name",
								"ghAwVersion": "v0.91.5", "ghAwUpdateState": "update-available", "createdAt": "2025-01-01T00:00:00Z"},
							{"id": "workflow:other", "repositoryId": "repository:octo%2Fother", "path": canonicalPath,
								"ghAwVersion": "v0.91.5", "ghAwUpdateState": "update-available"},
							{"id": "workflow:placeholder", "repositoryId": "repository:octo%2Frepo", "name": "Historical placeholder"},
						},
					})
					putInventory(t, path, map[string]model.Source{"workflows": {Rows: []model.Row{{
						"organization": "octo", "repository": "repo", "workflow": inventoryPath,
						"gh-aw-version": "v0.92.0", "gh-aw-current-version": "v0.92.0", "gh-aw-update-state": updateState,
					}}}})
					store, err := Open(t.Context(), path)
					if err != nil {
						t.Fatal(err)
					}
					defer func() { _ = store.Close() }()
					sources, _, err := store.ExecuteSQLPlan(t.Context(), nil, []string{"$workflows"})
					if err != nil {
						t.Fatal(err)
					}
					index := map[string]model.Row{}
					for _, row := range sources["$workflows"].Rows {
						index[row["id"].(string)] = row
					}
					if len(index) != 3 {
						t.Fatalf("alias generated duplicate workflow: %#v", index)
					}
					updated := index["workflow:first"]
					if updated["ghAwVersion"] != "v0.92.0" || updated["ghAwCurrentVersion"] != "v0.92.0" || updated["ghAwUpdateState"] != updateState ||
						updated["createdAt"] != "2025-01-01T00:00:00Z" || updated["name"] != "Historical name" || updated["path"] != canonicalPath {
						t.Fatalf("compiler overlay changed unrelated history or lost retained evidence: %#v", updated)
					}
					if other := index["workflow:other"]; other["ghAwVersion"] != "v0.91.5" || other["ghAwUpdateState"] != "update-available" {
						t.Fatalf("compiler overlay crossed repository boundary: %#v", other)
					}
					if placeholder := index["workflow:placeholder"]; placeholder["ghAwVersion"] != nil || placeholder["ghAwUpdateState"] != nil {
						t.Fatalf("placeholder became compiler evidence: %#v", placeholder)
					}
					state, err := store.State(t.Context())
					if err != nil || state.Counts["$workflows"] != 3 {
						t.Fatalf("alias inventory inflated counts: %#v %v", state, err)
					}
				})
			}
		}
	}
}

func TestNativeInventoryUnavailableAndMissingCompilerEvidence(t *testing.T) {
	for _, availability := range []string{"available", "unavailable"} {
		t.Run(availability, func(t *testing.T) {
			path := nativeSnapshot(t, map[string][]model.Row{"workflows": {{
				"id": "workflow:first", "repositoryId": "repository:octo%2Frepo", "path": ".github/workflows/first.md",
				"ghAwVersion": "v0.91.5", "ghAwCurrentVersion": "v0.92.0", "ghAwUpdateState": "update-available",
			}}})
			putInventory(t, path, map[string]model.Source{"workflows": {
				Rows:     []model.Row{{"organization": "octo", "repository": "repo", "workflow": "first.md", "gh-aw-update-state": "unknown"}},
				Metadata: model.Metadata{"availability": availability},
			}})
			store, err := Open(t.Context(), path)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = store.Close() }()
			sources, _, err := store.ExecuteSQLPlan(t.Context(), nil, []string{"$workflows"})
			if err != nil {
				t.Fatal(err)
			}
			if availability == "unavailable" {
				if len(sources["$workflows"].Rows) != 0 || sources["$workflows"].Metadata["availability"] != "unavailable" {
					t.Fatal("unavailable inventory was turned into current evidence")
				}
				return
			}
			row := sources["$workflows"].Rows[0]
			if row["ghAwVersion"] != "v0.91.5" || row["ghAwCurrentVersion"] != "v0.92.0" || row["ghAwUpdateState"] != "unknown" {
				t.Fatalf("missing installed version replaced retained evidence: %#v", row)
			}
		})
	}
}
