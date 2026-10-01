package ingest

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/postgresx"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
)

const deployedSubset = "../../testdata/deployed-subset"
const databaseQueries = "../../../dashboard/site/src/data/queries/database.json"

func TestForcedIngestionAdvancesRevisionWithoutChangingDataRevision(t *testing.T) {
	ctx, store := ingestTestStore(t)
	first, err := Run(ctx, store, nil, deployedSubset, Options{DatabaseQueriesPath: databaseQueries})
	if err != nil {
		t.Fatal(err)
	}
	second, err := Run(ctx, store, nil, deployedSubset, Options{DatabaseQueriesPath: databaseQueries, Force: true})
	if err != nil {
		t.Fatal(err)
	}
	if second.Revision != first.Revision+1 || second.DataRevision != first.DataRevision ||
		!reflect.DeepEqual(second.Counts, first.Counts) {
		t.Fatalf("forced ingestion changed data or did not advance revision: first=%+v second=%+v", first, second)
	}
	state, err := store.State(ctx)
	if err != nil || state.Revision != second.Revision || state.DataRevision != second.DataRevision {
		t.Fatalf("forced ingestion not reflected in database: %+v, %v", state, err)
	}
}

func TestUnchangedLakeReusesPostgresRevision(t *testing.T) {
	ctx, store := ingestTestStore(t)
	options := Options{DatabaseQueriesPath: databaseQueries}
	first, err := Run(ctx, store, nil, deployedSubset, options)
	if err != nil {
		t.Fatal(err)
	}
	second, err := Run(ctx, store, nil, deployedSubset, options)
	if err != nil {
		t.Fatal(err)
	}
	if second.Revision != first.Revision || second.DataRevision != first.DataRevision ||
		!reflect.DeepEqual(second.Counts, first.Counts) || second.EvaluatedAt != first.EvaluatedAt {
		t.Fatalf("unchanged lake was not reused: first=%+v second=%+v", first, second)
	}
}

func TestChangedInventoryCreatesFreshDataRevision(t *testing.T) {
	ctx, store := ingestTestStore(t)
	options := Options{DatabaseQueriesPath: databaseQueries}
	first, err := Run(ctx, store, nil, deployedSubset, options)
	if err != nil {
		t.Fatal(err)
	}
	directory := scratchDirectory(t)
	for _, name := range []string{
		"payload-hashes.json", "inventory-sources.json",
		"gh-aw-logs-runs/subset.jsonl", "gh-aw-logs-records/subset.jsonl",
	} {
		// #nosec G304 -- these fixture names are fixed within the checked-in deployed subset.
		content, err := os.ReadFile(filepath.Join(deployedSubset, name))
		if err != nil {
			t.Fatal(err)
		}
		if name == "inventory-sources.json" {
			content = append(content, '\n')
		}
		writeTestFile(t, filepath.Join(directory, name), content)
	}
	second, err := Run(ctx, store, nil, directory, options)
	if err != nil {
		t.Fatal(err)
	}
	if second.Revision != first.Revision+1 || second.DataRevision == first.DataRevision ||
		!reflect.DeepEqual(second.Counts, first.Counts) {
		t.Fatalf("changed inventory did not create a fresh data revision: first=%+v second=%+v", first, second)
	}
	state, err := store.State(ctx)
	if err != nil || state.DataRevision != second.DataRevision || state.Revision != second.Revision {
		t.Fatalf("fresh revision not activated: %+v, %v", state, err)
	}
}

func TestFailedPostgresReplaceRollsBackIngestedSources(t *testing.T) {
	ctx, store := ingestTestStore(t)
	result, err := Run(ctx, store, nil, deployedSubset, Options{DatabaseQueriesPath: databaseQueries})
	if err != nil {
		t.Fatal(err)
	}
	before, err := store.State(ctx)
	if err != nil {
		t.Fatal(err)
	}
	repositories, _, err := store.LoadSource(ctx, "$repositories", nil)
	if err != nil {
		t.Fatal(err)
	}
	diagnostics, err := store.Diagnostics(ctx)
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.Replace(ctx, map[string]model.Source{
		"invalid": {Source: "invalid", Rows: []model.Row{{"bad": make(chan int)}}},
	}, model.Diagnostics{}, "invalid-revision", time.Now())
	if err == nil {
		t.Fatal("expected replacement to fail")
	}
	after, err := store.State(ctx)
	if err != nil || !reflect.DeepEqual(after, before) || after.Revision != result.Revision {
		t.Fatalf("failed replacement changed active state: before=%+v after=%+v err=%v", before, after, err)
	}
	preserved, _, err := store.LoadSource(ctx, "$repositories", nil)
	if err != nil || !reflect.DeepEqual(preserved, repositories) {
		t.Fatalf("failed replacement lost ingested rows: %v, %v", preserved, err)
	}
	afterDiagnostics, err := store.Diagnostics(ctx)
	if err != nil || !reflect.DeepEqual(afterDiagnostics, diagnostics) {
		t.Fatalf("failed replacement changed diagnostics: %+v, %v", afterDiagnostics, err)
	}
	if _, _, err := store.LoadSource(ctx, "invalid", nil); !errors.Is(err, postgresx.ErrSourceUnavailable) {
		t.Fatalf("failed replacement exposed incomplete source: %v", err)
	}
}

func TestIngestedPostgresSourcesSupportDirectQueries(t *testing.T) {
	ctx, store := ingestTestStore(t)
	result, err := Run(ctx, store, nil, deployedSubset, Options{DatabaseQueriesPath: databaseQueries})
	if err != nil {
		t.Fatal(err)
	}
	repositories, metrics, err := store.LoadSource(ctx, "$repositories", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(repositories.Rows) == 0 || len(repositories.Rows) != result.Counts["$repositories"] ||
		metrics.OutputRows != len(repositories.Rows) {
		t.Fatalf("Postgres direct source disagrees with ingestion: rows=%d metrics=%+v counts=%+v",
			len(repositories.Rows), metrics, result.Counts)
	}
	id := repositories.Rows[0]["id"]
	definitions := []query.Definition{{
		Name: "selected-repository", From: "$repositories",
		Filter: &query.Filter{Predicates: []query.Predicate{{Field: "id", Equals: id}}},
	}}
	sources, _, err := query.New(ingestSourceLoader{store: store, ctx: ctx}).Execute(definitions, []string{"selected-repository"})
	if err != nil || len(sources["selected-repository"].Rows) != 1 ||
		sources["selected-repository"].Rows[0]["id"] != id {
		t.Fatalf("direct query did not select the ingested repository: %+v, %v", sources, err)
	}
}

type ingestSourceLoader struct {
	store *postgresx.Store
	ctx   context.Context
}

func (loader ingestSourceLoader) LoadSource(name string, definition *query.Definition) (model.Source, model.Metrics, error) {
	return loader.store.LoadSource(loader.ctx, name, definition)
}

func ingestTestStore(t *testing.T) (context.Context, *postgresx.Store) {
	t.Helper()
	url := os.Getenv("POSTGRES_URL")
	if url == "" {
		t.Skip("POSTGRES_URL is not set")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
	t.Cleanup(cancel)
	admin, err := sql.Open("pgx", url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = admin.Close() })
	schema := fmt.Sprintf("cao_ingest_test_%d", time.Now().UnixNano())
	if _, err := admin.ExecContext(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		dropCtx, dropCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer dropCancel()
		_, _ = admin.ExecContext(dropCtx, "DROP SCHEMA "+schema+" CASCADE")
	})
	config, err := pgx.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	config.RuntimeParams["search_path"] = schema
	store, err := postgresx.NewConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return ctx, store
}
