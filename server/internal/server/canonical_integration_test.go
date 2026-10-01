package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/ingest"
	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/postgresx"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
	"github.com/jackc/pgx/v5"
	_ "github.com/jackc/pgx/v5/stdlib"
)

func TestCanonicalAPIQueriesMatchPostgresIngestion(t *testing.T) {
	rawURL := os.Getenv("POSTGRES_URL")
	if rawURL == "" {
		t.Skip("POSTGRES_URL is not set")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
	defer cancel()
	admin, err := sql.Open("pgx", rawURL)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schema := fmt.Sprintf("cao_canonical_test_%d", time.Now().UnixNano())
	if _, err := admin.ExecContext(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	defer func() {
		dropCtx, dropCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer dropCancel()
		_, _ = admin.ExecContext(dropCtx, "DROP SCHEMA "+schema+" CASCADE")
	}()
	config, err := pgx.ParseConfig(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	config.RuntimeParams["search_path"] = schema
	store, err := postgresx.NewConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	result, err := ingest.Run(ctx, store, nil, "../../testdata/deployed-subset", ingest.Options{
		DatabaseQueriesPath: "../../../dashboard/site/src/data/queries/database.json",
	})
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
	var repositoryDefinitions []query.Definition
	for _, definition := range definitions {
		if definition.Name == "repositories" {
			repositoryDefinitions = append(repositoryDefinitions, definition)
		}
	}
	if len(repositoryDefinitions) != 1 {
		t.Fatal("missing canonical repositories query")
	}
	service := canonicalService{store: store, definitions: repositoryDefinitions}
	repositories, err := service.rows(ctx, "repositories")
	if err != nil {
		t.Fatal(err)
	}
	direct, _, err := store.LoadSource(ctx, "$repositories", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(repositories) == 0 || len(repositories) != result.Counts["$repositories"] ||
		len(repositories) != len(direct.Rows) {
		t.Fatalf("canonical API and Postgres source differ: api=%d postgres=%d", len(repositories), len(direct.Rows))
	}
	id := fmt.Sprint(repositories[0]["id"])
	found := false
	for _, row := range direct.Rows {
		if fmt.Sprint(row["id"]) == id {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("canonical API repository %q missing from direct Postgres source", id)
	}
	repository, err := service.entity(ctx, "repositories", id)
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(repository["id"]) != id {
		t.Fatalf("canonical entity query returned the wrong repository: %#v", repository)
	}
	matching, err := service.filteredRows(ctx, "repositories", map[string]any{"id": id})
	if err != nil || len(matching) != 1 || fmt.Sprint(matching[0]["id"]) != id {
		t.Fatalf("canonical filter did not match ingested repository: %+v, %v", matching, err)
	}
	_, err = service.entity(ctx, "repositories", "repository:not-found")
	if err != errCanonicalEntityNotFound {
		t.Fatal(err)
	}

	app := &App{database: store, databaseQueries: append([]query.Definition{{
		Name: "$records", From: "$domains",
		Union: []string{"$tools", "$skills", "$friction", "$audits", "$issues"},
	}}, definitions...)}
	app.databaseQueries = append(app.databaseQueries, rawSourceDefinitions(definitions)...)
	response, status, err := app.executeQuery(ctx, queryRequest{
		SourceNames: []string{"runs", "overview-runs", "outcomes", "mcp-calls", "domains", "issues", "jobs"},
	}, false)
	if err != nil || status != http.StatusOK {
		t.Fatalf("Postgres dashboard query failed: status=%d error=%v", status, err)
	}
	for _, name := range []string{"runs", "overview-runs", "outcomes", "mcp-calls", "domains", "issues"} {
		if len(response.Sources[name].Rows) != 1 {
			t.Errorf("Postgres dashboard source %q has %d rows, want 1", name, len(response.Sources[name].Rows))
		}
	}
	if len(response.Sources["jobs"].Rows) != 0 || response.Sources["jobs"].Metadata["availability"] == "unavailable" {
		t.Errorf("empty canonical jobs source must remain available: %#v", response.Sources["jobs"])
	}
	if rows := response.Sources["outcomes"].Rows; len(rows) == 1 {
		outcome := rows[0]
		if link, ok := outcome["issue-link"].(model.Row); !ok ||
			link["href"] != "https://github.com/githubnext/gh-aw-cao/issues/42" || outcome["pull-request-link"] != nil {
			t.Fatalf("outcome issue link was not preserved: %#v", outcome)
		}
	}
}
