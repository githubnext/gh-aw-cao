package server

import (
	"context"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/postgresx"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

func TestSimulationDaysSource(t *testing.T) {
	source, err := (&databaseLoader{}).runtimeSource(t.Context(), simulationDaysSourceName, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(source.Rows) != 30 {
		t.Fatalf("simulation days = %d, want 30", len(source.Rows))
	}
	if source.Rows[0]["day"] != 1 || source.Rows[0]["date"] != "2025-01-01T00:00:00.000Z" {
		t.Fatalf("first simulation day = %v", source.Rows[0])
	}
	if source.Rows[29]["day"] != 30 || source.Rows[29]["date"] != "2025-01-30T00:00:00.000Z" {
		t.Fatalf("last simulation day = %v", source.Rows[29])
	}
	if source.Metadata["source-kind"] != "synthetic" || source.Metadata["availability"] != "available" {
		t.Fatalf("simulation metadata = %v", source.Metadata)
	}
	found := false
	for _, name := range RuntimeQuerySourceNames() {
		if name == simulationDaysSourceName {
			found = true
		}
	}
	if !found {
		t.Fatal("simulation-days not registered as a runtime source")
	}
	database := integrationDatabase(t)
	seedDatabase(t, database, nil)
	result, _, err := func() (map[string]model.Source, model.Metrics, error) {
		var sources map[string]model.Source
		var metrics model.Metrics
		err := database.WithReadTransaction(t.Context(), func(ctx context.Context, reader postgresx.NativeReader) error {
			var err error
			sources, metrics, err = (&databaseLoader{ctx: ctx, database: reader}).ExecuteSQLPlan(
				[]query.Definition{{Name: "simulated", From: simulationDaysSourceName}},
				[]string{"simulated"}, nil)
			return err
		})
		return sources, metrics, err
	}()
	if err != nil {
		t.Fatal(err)
	}
	if len(result["simulated"].Rows) != 30 {
		t.Fatalf("simulated query rows = %d, want 30", len(result["simulated"].Rows))
	}
}
