package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/collect"
	"github.com/githubnext/gh-aw-cao/server/internal/githubapp"
	"github.com/githubnext/gh-aw-cao/server/internal/githubquota"
	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/postgresx"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
	"github.com/githubnext/gh-aw-cao/server/internal/telemetry"
)

const backfillDatabaseQueries = "../../../dashboard/site/src/data/queries/database.json"

type backfillEnumeration struct{ runPages int }

func (*backfillEnumeration) ListInstallations(context.Context) ([]githubapp.Installation, error) {
	return []githubapp.Installation{{ID: 7}}, nil
}

func (*backfillEnumeration) ListRepositories(context.Context, int64) ([]githubapp.Repository, error) {
	return []githubapp.Repository{{FullName: "githubnext/gh-aw-cao"}}, nil
}

func (e *backfillEnumeration) ListWorkflowRuns(
	_ context.Context, installation int64, repository string, page, perPage int,
) ([]githubapp.WorkflowRun, int, githubquota.ResponseQuota, error) {
	if installation != 7 || repository != "githubnext/gh-aw-cao" || page != 1 || perPage != 100 {
		return nil, 0, githubquota.ResponseQuota{}, fmt.Errorf("unexpected historical enumeration parameters")
	}
	e.runPages++
	return []githubapp.WorkflowRun{{
		ID: 424242, Attempt: 1, CreatedAt: time.Date(2026, 9, 23, 17, 59, 0, 0, time.UTC),
	}}, 0, githubquota.ResponseQuota{}, nil
}

func TestPostgresBackfillIntegration(t *testing.T) {
	if os.Getenv("CAO_BACKFILL_INTEGRATION") != "1" {
		t.Skip("run npm run test:integration:dashboard-backfill for local Postgres/Redis/OpenObserve coverage")
	}
	for _, name := range []string{"CAO_POSTGRES_URL", "REDIS_URL", "CAO_BACKFILL_OPENOBSERVE_URL",
		"CAO_LOCAL_OTEL_EMAIL", "CAO_LOCAL_OTEL_PASSWORD",
		"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "OTEL_EXPORTER_OTLP_HEADERS"} {
		if os.Getenv(name) == "" {
			t.Fatalf("%s is required when backfill integration is enabled", name)
		}
	}
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Minute)
	defer cancel()
	started := time.Now()
	service := fmt.Sprintf("cao-backfill-test-%d", started.UnixNano())
	flush := backfillTelemetry(t, ctx, service)
	data := integrationDatabase(t)
	client, err := redisx.New(os.Getenv("REDIS_URL"))
	if err != nil {
		t.Fatal("configure local Redis")
	}
	store := redisx.NewStore(client, service)
	if err := store.Ping(ctx); err != nil {
		t.Fatal("local Redis is unavailable")
	}
	lake := collect.Lake{Directory: t.TempDir()}
	if err := os.CopyFS(lake.Directory, os.DirFS("../../testdata/deployed-subset")); err != nil {
		t.Fatal(err)
	}
	enrollment := collect.Enrollment{Store: store}
	enumeration := &backfillEnumeration{}
	backfill := collect.Backfill{
		Store: store, Lake: lake, Enrollment: enrollment,
		Queue: collect.Queue{Store: store, MaxLength: 100},
		Projector: collect.Projector{
			Store: store, Data: data, Lake: lake, Enrollment: enrollment,
			DatabaseQueriesPath: backfillDatabaseQueries,
		},
		Enumerator: enumeration, RunEnumerator: enumeration,
	}
	app, err := New(ctx, store, Config{
		Database: data, DatabaseQueriesPath: backfillDatabaseQueries,
		Listen: "127.0.0.1:0", SiteDirectory: t.TempDir(), AccessToken: testAccessToken,
		QueryCache: QueryCacheConfig{Disabled: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	local := httptest.NewServer(app.Handler())
	defer local.Close()
	var committed postgresx.State
	var expected map[string]model.Source
	var queryTrace string

	if !t.Run("cold start publishes native rows and admits durable tasks", func(t *testing.T) {
		backfillReadiness(t, ctx, local, http.StatusServiceUnavailable)
		state, err := backfill.Run(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if state.Phase != "collecting" || !state.LakeReplayed || state.Revision != 1 ||
			state.Repositories != 1 || state.Installations != 1 || state.QueuedRepositories != 1 ||
			state.QueuedRunTasks != 1 || state.EnumerationFailures != 0 || state.CompletedAt == "" {
			t.Fatalf("unexpected cold-start result: %+v", state)
		}
		persisted, err := backfill.State(ctx)
		if err != nil || persisted != state {
			t.Fatalf("backfill checkpoint was not persisted: %+v, %v", persisted, err)
		}
		if installation, err := enrollment.InstallationFor(ctx, "githubnext/gh-aw-cao"); err != nil || installation != 7 {
			t.Fatalf("enrollment installation = %d, err=%v", installation, err)
		}
		assertBackfillQueueDepth(t, ctx, backfill.Queue)
		committed = backfillState(t, ctx, data)
		if !committed.Ready || committed.DataRevision == "" ||
			committed.Counts["$runs"] != 1 || committed.Counts["$repositories"] != 1 {
			t.Fatalf("native Postgres state = %+v", committed)
		}
		result, traceID := backfillHTTPQuery(t, ctx, local)
		queryTrace = traceID
		expected = result.Sources
		assertBackfillRows(t, result)
		backfillReadiness(t, ctx, local, http.StatusOK)
	}) {
		return
	}

	if !t.Run("rerun reuses revision and suppresses duplicate tasks", func(t *testing.T) {
		state, err := backfill.Run(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if state.Revision != committed.Revision || state.QueuedRepositories != 0 || state.QueuedRunTasks != 0 ||
			state.Phase != "collecting" || enumeration.runPages != 2 {
			t.Fatalf("rerun advanced revision, duplicated work, or ignored cursor: %+v, pages=%d", state, enumeration.runPages)
		}
		assertBackfillQueueDepth(t, ctx, backfill.Queue)
		if got := backfillState(t, ctx, data); !reflect.DeepEqual(got, committed) {
			t.Fatalf("unchanged replay changed Postgres state: %+v", got)
		}
	}) {
		return
	}

	// Replay must not depend on GitHub enumeration or quota availability.
	backfill.Enumerator = nil
	backfill.RunEnumerator = nil
	if !t.Run("lost Postgres projection recovers from retained lake without GitHub", func(t *testing.T) {
		if err := data.DeleteNamespace(ctx); err != nil {
			t.Fatal(err)
		}
		backfillReadiness(t, ctx, local, http.StatusServiceUnavailable)
		replayed, err := backfill.Replay(ctx)
		if err != nil {
			t.Fatal(err)
		}
		restored := backfillState(t, ctx, data)
		if replayed.Revision != 1 || !restored.Ready || restored.DataRevision != committed.DataRevision ||
			!reflect.DeepEqual(restored.Counts, committed.Counts) {
			t.Fatalf("lake recovery did not restore native data: %+v", restored)
		}
		committed = restored
		result, _ := backfillHTTPQuery(t, ctx, local)
		if !reflect.DeepEqual(result.Sources, expected) {
			t.Fatal("recovery changed canonical rows or metadata")
		}
		backfillReadiness(t, ctx, local, http.StatusOK)
	}) {
		return
	}

	if !t.Run("malformed replacement fails and preserves serving data", func(t *testing.T) {
		shard := filepath.Join(lake.RecordsDirectory(), "subset.jsonl")
		original, err := os.ReadFile(shard) // #nosec G304 -- shard is a fixed file in this test's temporary lake.
		if err != nil {
			t.Fatal(err)
		}
		manifest, err := os.ReadFile(lake.ManifestPath())
		if err != nil {
			t.Fatal(err)
		}
		var hashes map[string]string
		if err := json.Unmarshal(manifest, &hashes); err != nil {
			t.Fatal(err)
		}
		malformed := append(bytes.Clone(original), []byte("not-json\n")...)
		hash := sha256.Sum256(malformed)
		hashes["gh-aw-logs-records/subset.jsonl"] = hex.EncodeToString(hash[:])
		changedManifest, err := json.Marshal(hashes)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(shard, malformed, 0o600); err != nil { // #nosec G703 -- fixed file in the test's temporary lake.
			t.Fatal(err)
		}
		if err := os.WriteFile(lake.ManifestPath(), changedManifest, 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := backfill.Replay(ctx); err == nil {
			t.Fatal("backfill accepted a hash-valid but malformed record shard")
		}
		if got := backfillState(t, ctx, data); !reflect.DeepEqual(got, committed) {
			t.Fatalf("failed replay replaced committed state: %+v", got)
		}
		if pending, err := backfill.Projector.PendingProjection(ctx); err != nil || !pending {
			t.Fatalf("failed replay did not leave a retry marker: %t, %v", pending, err)
		}
		result, _ := backfillHTTPQuery(t, ctx, local)
		if !reflect.DeepEqual(result.Sources, expected) {
			t.Fatal("failed replay changed rows served by the live HTTP server")
		}
		backfillReadiness(t, ctx, local, http.StatusOK)
		if err := os.WriteFile(shard, original, 0o600); err != nil { // #nosec G703 -- restores the same fixed temporary fixture.
			t.Fatal(err)
		}
		if err := os.WriteFile(lake.ManifestPath(), manifest, 0o600); err != nil { // #nosec G703 -- fixed manifest in the test's temporary lake.
			t.Fatal(err)
		}
		repaired, err := backfill.Replay(ctx)
		if err != nil || repaired.Revision != committed.Revision {
			t.Fatalf("repaired replay failed or advanced unchanged data: %+v, %v", repaired, err)
		}
		if pending, err := backfill.Projector.PendingProjection(ctx); err != nil || pending {
			t.Fatalf("successful replay did not clear retry marker: %t, %v", pending, err)
		}
	}) {
		return
	}

	t.Run("empty lake fails closed", func(t *testing.T) {
		empty := backfill
		empty.Lake = collect.Lake{Directory: t.TempDir()}
		if err := empty.Lake.Prepare(); err != nil {
			t.Fatal(err)
		}
		if _, err := empty.Replay(ctx); err == nil {
			t.Fatal("empty evidence lake was accepted")
		}
		if got := backfillState(t, ctx, data); !reflect.DeepEqual(got, committed) {
			t.Fatal("empty lake changed existing data")
		}
	})
	t.Run("OpenObserve receives correlated traces and backfill metrics", func(t *testing.T) {
		flush(t)
		assertBackfillTelemetry(t, ctx, service, queryTrace, started)
	})
}

func backfillState(t *testing.T, ctx context.Context, data *postgresx.Store) postgresx.State {
	t.Helper()
	state, err := data.State(ctx)
	if err != nil {
		t.Fatal(err)
	}
	return state
}

func assertBackfillQueueDepth(t *testing.T, ctx context.Context, queue collect.Queue) {
	t.Helper()
	depth, err := queue.Depth(ctx)
	if err != nil || depth != 1 {
		t.Fatalf("durable repository task depth = %d, err=%v", depth, err)
	}
	runDepth, err := queue.Store.StreamLength(ctx, "collect:run-tasks")
	if err != nil || runDepth != 1 {
		t.Fatalf("durable historical run task depth = %d, err=%v", runDepth, err)
	}
}

func backfillReadiness(t *testing.T, ctx context.Context, local *httptest.Server, want int) {
	t.Helper()
	backfillRequest(t, ctx, local, http.MethodGet, "/api/readiness", nil, want, nil)
}

func backfillHTTPQuery(t *testing.T, ctx context.Context, local *httptest.Server) (queryResponse, string) {
	t.Helper()
	input := queryRequest{}
	for _, source := range []string{"runs", "repositories", "workflows", "domains", "tools", "audits"} {
		input.Queries = append(input.Queries, query.Definition{Name: "backfill-" + source, From: "$" + source})
		input.SourceNames = append(input.SourceNames, "backfill-"+source)
	}
	body, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	var result queryResponse
	traceID := backfillRequest(t, ctx, local, http.MethodPost, "/api/v1/query", body, http.StatusOK, &result)
	return result, traceID
}

func backfillRequest(t *testing.T, ctx context.Context, local *httptest.Server, method, path string, body []byte, status int, result any) string {
	t.Helper()
	request, err := http.NewRequestWithContext(ctx, method, local.URL+path, bytes.NewReader(body)) // #nosec G704 -- httptest binds this endpoint to loopback.
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+testAccessToken)
	request.Header.Set("Content-Type", "application/json")
	response, err := local.Client().Do(request) // #nosec G704 -- the request targets the local httptest server.
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != status {
		t.Fatalf("%s %s returned %d, want %d", method, path, response.StatusCode, status)
	}
	if result != nil {
		if err := json.NewDecoder(response.Body).Decode(result); err != nil {
			t.Fatal(err)
		}
	} else if _, err := io.Copy(io.Discard, response.Body); err != nil {
		t.Fatal(err)
	}
	traceID := response.Header.Get(telemetry.TraceIDHeader)
	if len(traceID) != 32 || len(response.Header.Get(telemetry.SpanIDHeader)) != 16 {
		t.Fatal("live server response lacks W3C trace/span correlation")
	}
	return traceID
}

func assertBackfillRows(t *testing.T, result queryResponse) {
	t.Helper()
	for _, name := range []string{"runs", "repositories", "workflows", "domains", "tools", "audits"} {
		if len(result.Sources["backfill-"+name].Rows) != 1 {
			t.Fatalf("%s rows = %d, want one deployed-fixture row", name, len(result.Sources["backfill-"+name].Rows))
		}
	}
	run := result.Sources["backfill-runs"].Rows[0]
	if run["id"] != "run:424242" || run["repositoryId"] != "repository:githubnext/gh-aw-cao" ||
		run["workflowId"] != "workflow:githubnext/gh-aw-cao:dashboard" {
		t.Fatalf("backfill lost canonical run relationships: %+v", run)
	}
}
