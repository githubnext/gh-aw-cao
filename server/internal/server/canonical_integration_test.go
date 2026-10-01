package server

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/ingest"
	"github.com/githubnext/gh-aw-cao/server/internal/postgresx"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
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
	dsn := stdlib.RegisterConnConfig(config)
	defer stdlib.UnregisterConnConfig(dsn)
	store, err := postgresx.New(ctx, dsn)
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
	service := canonicalService{store: store}
	repositories, err := service.rows(ctx, "repositories")
	if err != nil {
		t.Fatal(err)
	}
	direct, _, err := store.LoadSource(ctx, "repositories", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(repositories) == 0 || len(repositories) != result.Counts["repositories"] ||
		!reflect.DeepEqual(repositories, direct.Rows) {
		t.Fatalf("canonical API and Postgres source differ: api=%d postgres=%d", len(repositories), len(direct.Rows))
	}
	id := fmt.Sprint(repositories[0]["id"])
	repository, err := service.entity(ctx, "repositories", id)
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(repository["id"]) != id {
		t.Fatalf("canonical entity query returned the wrong repository: %#v", repository)
	}
	if _, err := service.repositoryRuns(ctx, id); err != nil {
		t.Fatal(err)
	}
}
