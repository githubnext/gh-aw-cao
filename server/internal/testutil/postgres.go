package testutil

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/githubnext/gh-aw-cao/server/internal/postgresx"
)

// Postgres creates a private schema, including when initialization fails.
// Service-backed tests never replace another test's or the operator's data.
func Postgres(t testing.TB, parent context.Context, environment ...string) *postgresx.Store {
	t.Helper()
	endpoint := ""
	for _, name := range environment {
		if endpoint = os.Getenv(name); endpoint != "" {
			break
		}
	}
	if endpoint == "" {
		t.Skipf("set one of %v to run Postgres integration tests", environment)
	}
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()
	admin, err := sql.Open("pgx", endpoint)
	if err != nil {
		t.Fatal("configure Postgres test connection")
	}
	t.Cleanup(func() { _ = admin.Close() })
	schema := fmt.Sprintf("cao_test_%d", time.Now().UnixNano())
	if _, err := admin.ExecContext(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal("create isolated Postgres test schema")
	}
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.WithoutCancel(parent), 10*time.Second)
		defer stop()
		if _, err := admin.ExecContext(cleanup, "DROP SCHEMA "+schema+" CASCADE"); err != nil {
			t.Error("remove isolated Postgres test schema")
		}
	})
	config, err := pgx.ParseConfig(endpoint)
	if err != nil {
		t.Fatal("parse Postgres test configuration")
	}
	config.RuntimeParams["search_path"] = schema
	store, err := postgresx.NewConfig(ctx, config)
	if err != nil {
		t.Fatal("initialize isolated Postgres test schema")
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}
