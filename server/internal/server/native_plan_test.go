package server

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/postgresx"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

func nativeAPIFixture() map[string]model.Source {
	return map[string]model.Source{
		"$repositories": {Rows: []model.Row{{"id": "repo", "owner": "octo", "name": "api"}}},
		"$workflows":    {Rows: []model.Row{{"id": "workflow", "repositoryId": "repo"}}},
		"$runs":         {Rows: []model.Row{{"id": "run", "workflowId": "workflow", "repositoryId": "repo"}}},
		"$domains":      {Rows: []model.Row{{"id": "first", "runId": "run"}, {"id": "second", "runId": "run"}, {"id": "third", "runId": "run"}}},
	}
}

func TestNativePlanUsesExistingHTTPPaginationContract(t *testing.T) {
	store := integrationDatabase(t)
	seedDatabase(t, store, nativeAPIFixture())
	app := &App{database: store, databaseQueries: []query.Definition{{Name: "domains", From: "$domains"}}}
	input := queryRequest{SourceNames: []string{"pick"}, CompiledQueries: []query.Definition{{Name: "pick", From: "domains"}}, Pagination: map[string]paginationRequest{"pick": {Limit: 1}}}
	first, status, err := app.executeQuery(t.Context(), input, false)
	if err != nil || status != http.StatusOK || len(first.Sources["pick"].Rows) != 1 || first.Sources["pick"].Rows[0]["id"] != "first" ||
		first.Sources["pick"].Metadata["total-row-count"] != 3 || first.Sources["pick"].ContinuationToken == "" {
		t.Fatalf("first native page failed: %+v %d %v", first, status, err)
	}
	if first.Metrics.RetainedRows != 1 {
		t.Fatalf("pagination decoded whole source or used fallback: %+v", first.Metrics)
	}
	input.Pagination["pick"] = paginationRequest{Limit: 1, ContinuationToken: first.Sources["pick"].ContinuationToken}
	second, status, err := app.executeQuery(t.Context(), input, false)
	if err != nil || status != http.StatusOK || len(second.Sources["pick"].Rows) != 1 || second.Sources["pick"].Rows[0]["id"] != "second" {
		t.Fatalf("second native page failed: %+v %d %v", second, status, err)
	}
	seedDatabase(t, store, nativeAPIFixture())
	if _, _, err := app.executeQuery(t.Context(), input, false); err == nil {
		t.Fatal("stale revision-bound cursor accepted")
	}
}

func TestHostedSQLFailsClosedForUnsupportedDefinitions(t *testing.T) {
	store := integrationDatabase(t)
	seedDatabase(t, store, nil)
	app := &App{database: store}
	_, _, err := app.executeQuery(t.Context(), queryRequest{SourceNames: []string{"unsupported"}, Queries: []query.Definition{{Name: "unsupported", From: "arbitrary-legacy-source"}}}, false)
	if err == nil {
		t.Fatal("hosted source fallback admitted")
	}
	if strings.Contains(err.Error(), "fallback") {
		t.Fatalf("SQL cutover contains fallback: %v", err)
	}
}

func TestMetadataCompositionAndUnavailableLeftJoin(t *testing.T) {
	store := integrationDatabase(t)
	writer, err := store.BeginIngestion(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Abort(t.Context())
	for source, input := range nativeAPIFixture() {
		for _, row := range input.Rows {
			if err := writer.Append(t.Context(), source, row); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := writer.Quality(t.Context(), "$runs", model.Metadata{"as-of": "2026-02-03T00:00:00Z", "freshness": "stale"}); err != nil {
		t.Fatal(err)
	}
	if err := writer.Quality(t.Context(), "$repositories", model.Metadata{"availability": "unavailable", "completeness": "partial", "as-of": "2026-02-01T00:00:00Z"}); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Publish(t.Context(), "metadata"); err != nil {
		t.Fatal(err)
	}
	definitions := []query.Definition{{Name: "enriched", From: "$runs", Joins: []query.Join{{Source: "$repositories", Type: "left", On: []query.JoinKey{{Left: "id", Right: "id"}}, Fields: []query.SelectedField{{Field: "owner", As: "repository-owner"}}}}}}
	err = store.WithReadTransaction(t.Context(), func(ctx context.Context, reader postgresx.NativeReader) error {
		result, _, err := reader.ExecuteSQLPlan(ctx, definitions, []string{"enriched"})
		if err != nil {
			return err
		}
		source := result["enriched"]
		if len(source.Rows) != 1 || source.Rows[0]["repository-owner"] != nil || source.Metadata["completeness"] != "partial" ||
			source.Metadata["freshness"] != "stale" || source.Metadata["as-of"] != "2026-02-01T00:00:00Z" {
			t.Errorf("native metadata composition failed: %+v", source)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
