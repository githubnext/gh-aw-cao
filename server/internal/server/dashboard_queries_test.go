package server

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDecodeDashboardQueries_BareArrayShape(t *testing.T) {
	definitions, shape, err := decodeDashboardQueries([]byte(`[{"name":"a","from":"runs"},{"name":"b","from":"runs"}]`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if shape != dashboardQueriesShapeArray {
		t.Errorf("shape = %q, want %q", shape, dashboardQueriesShapeArray)
	}
	if len(definitions) != 2 {
		t.Fatalf("len(definitions) = %d, want 2", len(definitions))
	}
	if definitions[0].Name != "a" || definitions[1].Name != "b" {
		t.Errorf("definitions = %+v, want names a, b", definitions)
	}
}

func TestDecodeDashboardQueries_QueriesWrapperShape(t *testing.T) {
	definitions, shape, err := decodeDashboardQueries([]byte(`{"queries":[{"name":"wrapped","from":"runs"}]}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if shape != dashboardQueriesShapeQueries {
		t.Errorf("shape = %q, want %q", shape, dashboardQueriesShapeQueries)
	}
	if len(definitions) != 1 || definitions[0].Name != "wrapped" {
		t.Errorf("definitions = %+v, want one definition named wrapped", definitions)
	}
}

func TestDecodeDashboardQueries_DashboardQueriesWrapperShape(t *testing.T) {
	definitions, shape, err := decodeDashboardQueries([]byte(`{"dashboard":{"queries":[{"name":"nested","from":"runs"}]}}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if shape != dashboardQueriesShapeDashboard {
		t.Errorf("shape = %q, want %q", shape, dashboardQueriesShapeDashboard)
	}
	if len(definitions) != 1 || definitions[0].Name != "nested" {
		t.Errorf("definitions = %+v, want one definition named nested", definitions)
	}
}

func TestDecodeDashboardQueries_QueriesWrapperTakesPriorityOverDashboardQueries(t *testing.T) {
	definitions, shape, err := decodeDashboardQueries([]byte(
		`{"queries":[{"name":"top-level","from":"runs"}],"dashboard":{"queries":[{"name":"nested","from":"runs"}]}}`,
	))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if shape != dashboardQueriesShapeQueries {
		t.Errorf("shape = %q, want %q", shape, dashboardQueriesShapeQueries)
	}
	if len(definitions) != 1 || definitions[0].Name != "top-level" {
		t.Errorf("definitions = %+v, want one definition named top-level", definitions)
	}
}

func TestDecodeDashboardQueries_MalformedJSONReturnsError(t *testing.T) {
	_, _, err := decodeDashboardQueries([]byte(`{not json`))
	if err == nil {
		t.Fatal("expected an error for malformed JSON")
	}
}

func TestDecodeDashboardQueries_EmptyDocumentYieldsNoDefinitions(t *testing.T) {
	definitions, shape, err := decodeDashboardQueries([]byte(`{}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if shape != dashboardQueriesShapeDashboard {
		t.Errorf("shape = %q, want %q", shape, dashboardQueriesShapeDashboard)
	}
	if len(definitions) != 0 {
		t.Errorf("definitions = %+v, want none", definitions)
	}
}

func TestParseDashboardQueries_EmptyPathReturnsNoDefinitionsWithoutReadingAFile(t *testing.T) {
	definitions, err := ParseDashboardQueries("")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if definitions != nil {
		t.Errorf("definitions = %+v, want nil", definitions)
	}
}

func TestParseDashboardQueries_MissingFileReturnsError(t *testing.T) {
	_, err := ParseDashboardQueries(filepath.Join(t.TempDir(), "does-not-exist.json"))
	if err == nil {
		t.Fatal("expected an error for a missing file")
	}
}

func TestParseDashboardQueries_ReadsAndParsesRealFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "queries.json")
	if err := os.WriteFile(path, []byte(`[{"name":"from-disk","from":"runs"}]`), 0o600); err != nil {
		t.Fatalf("unexpected error writing fixture: %v", err)
	}
	definitions, err := ParseDashboardQueries(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(definitions) != 1 || definitions[0].Name != "from-disk" {
		t.Errorf("definitions = %+v, want one definition named from-disk", definitions)
	}
}
