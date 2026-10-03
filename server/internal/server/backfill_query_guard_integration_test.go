package server

import (
	"net/http/httptest"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/simulator"
)

func TestPostgresBackfillLargeQueriesPreserveResourceGuards(t *testing.T) {
	backfillServices(t)
	ctx := t.Context()
	backfillDebugTelemetry(t, ctx)
	scenario := simulator.Scenario{
		Name: "large-query-guard", Repositories: 30_000,
		History: &simulator.History{Days: 14, RunsPerDay: 1, AsOf: time.Now().Add(-time.Minute).UTC().Format(time.RFC3339)},
	}
	h := newSyntheticBackfill(t, ctx, scenario)
	if result, err := h.backfill.Replay(ctx); err != nil || result.Counts["$runs"] != 210_000 {
		t.Fatalf("large synthetic replay = %+v, %v", result, err)
	}
	app, err := New(ctx, h.backfill.Store, Config{
		Database: h.data, DatabaseQueriesPath: backfillDatabaseQueries,
		Listen: "127.0.0.1:0", SiteDirectory: t.TempDir(), AccessToken: testAccessToken,
		QueryCache: QueryCacheConfig{Disabled: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	local := httptest.NewServer(app.Handler())
	defer local.Close()
	backfillStressSamples(t, ctx, local, scenario, 7)
	if h.api.Stats().Requests != 0 {
		t.Fatal("native large-query guard validation unexpectedly contacted GitHub")
	}
}
