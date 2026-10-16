package server

import (
	"context"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/postgresx"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

func TestHostedCLICommandSourcesRemainUnavailable(t *testing.T) {
	loader := &databaseLoader{}
	names := []string{"cli-commands", "cli-command-summary", "cli-command-statuses"}
	for _, name := range names {
		source, err := loader.runtimeSource(t.Context(), name, nil)
		if err != nil || source.Metadata["availability"] != "unavailable" || len(source.Rows) != 0 {
			t.Fatalf("command storage must not enable hosted execution: %s %+v %v", name, source, err)
		}
	}
	database := integrationDatabase(t)
	err := database.WithReadTransaction(t.Context(), func(ctx context.Context, reader postgresx.NativeReader) error {
		sources, _, err := (&databaseLoader{ctx: ctx, database: reader}).ExecuteSQLPlan(
			[]query.Definition{{Name: "commands", From: "cli-commands"}}, []string{"commands"}, nil)
		if err != nil {
			return err
		}
		if source := sources["commands"]; source.Metadata["availability"] != "unavailable" || len(source.Rows) != 0 {
			t.Fatalf("production SQL query fabricated command availability: %+v", source)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
