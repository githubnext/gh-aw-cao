package server

import (
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/postgresx"
	"github.com/githubnext/gh-aw-cao/server/internal/testutil"
)

// constructorDatabase satisfies New's database requirement where no dashboard data is read.
func constructorDatabase() *postgresx.Store { return &postgresx.Store{} }

func integrationDatabase(t testing.TB) *postgresx.Store {
	t.Helper()
	return testutil.Postgres(t, t.Context(), "CAO_POSTGRES_URL", "POSTGRES_URL")
}

func seedDatabase(t *testing.T, store *postgresx.Store, sources map[string]model.Source) {
	t.Helper()
	writer, err := store.BeginIngestion(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Abort(t.Context())
	for name, source := range sources {
		for _, row := range source.Rows {
			if err := writer.Append(t.Context(), name, row); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := writer.Quality(t.Context(), "$runs", model.Metadata{"as-of": "2026-02-03T04:05:06Z"}); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Publish(t.Context(), "test-data"); err != nil {
		t.Fatal(err)
	}
}
