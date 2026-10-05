package postgresx

import (
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
)

func TestNativePublicationRefreshesPlannerStatistics(t *testing.T) {
	store, _ := nativeTestStore(t)
	nativeSeed(t.Context(), t, store, map[string][]model.Row{
		"$domains": {{"id": "domain", "runId": "run", "domain": "example.com"}},
	})
	assertEstimates := func(want int) {
		t.Helper()
		for _, table := range []string{"repositories", "workflows", "runs", "domains"} {
			var estimate float64
			if err := store.db.QueryRowContext(t.Context(),
				"SELECT reltuples FROM pg_class WHERE oid=to_regclass($1)", table).Scan(&estimate); err != nil {
				t.Fatal(err)
			}
			if estimate != float64(want) {
				t.Fatalf("%s planner estimate = %v, want %d replacement rows", table, estimate, want)
			}
		}
	}
	assertEstimates(1)

	writer, err := store.BeginIngestion(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Abort(t.Context())
	if _, err := writer.Publish(t.Context(), "empty-replacement"); err != nil {
		t.Fatal(err)
	}
	assertEstimates(0)
}
