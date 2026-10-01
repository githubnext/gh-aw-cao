package server

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/postgresx"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

// constructorDatabase satisfies New's database requirement where no dashboard data is read.
func constructorDatabase() *postgresx.Store { return &postgresx.Store{} }

func integrationDatabase(t *testing.T) *postgresx.Store {
	t.Helper()
	rawURL := os.Getenv("POSTGRES_URL")
	if rawURL == "" {
		t.Skip("POSTGRES_URL is not set")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	admin, err := sql.Open("pgx", rawURL)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("cao_server_test_%d", time.Now().UnixNano())
	if _, err := admin.ExecContext(ctx, "CREATE SCHEMA "+schema); err != nil {
		_ = admin.Close()
		t.Fatal(err)
	}
	config, err := pgx.ParseConfig(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	config.RuntimeParams["search_path"] = schema
	dsn := stdlib.RegisterConnConfig(config)
	store, err := postgresx.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = store.Close()
		stdlib.UnregisterConnConfig(dsn)
		dropCtx, dropCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer dropCancel()
		if _, err := admin.ExecContext(dropCtx, "DROP SCHEMA "+schema+" CASCADE"); err != nil {
			t.Errorf("remove test schema: %v", err)
		}
		_ = admin.Close()
	})
	return store
}
