package server

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-cao/server/internal/sqlitex"
)

func TestLocalBackfillCollectsSnapshotScopeWithLocalToken(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake gh uses a POSIX shell")
	}
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is required for canonical ingestion")
	}
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	now := time.Now().UTC().Truncate(time.Second)
	run := func(id int, at time.Time, status, conclusion string) []byte {
		content, err := json.Marshal(map[string]any{
			"schema_version": 2, "kind": "run", "run": map[string]any{
				"organization": "octo", "repository": "one", "run_id": id, "run_attempt": 1,
				"workflow_name": "test", "workflow_path": ".github/workflows/test.lock.yml",
				"created_at": at.Format(time.RFC3339), "updated_at": at.Add(time.Minute).Format(time.RFC3339),
				"status": status, "conclusion": conclusion,
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		return append(content, '\n')
	}
	snapshot := filepath.Join(directory, "snapshot.sqlite")
	fixture := filepath.Join(directory, "run.jsonl")
	seed := append(run(123, now.Add(-2*time.Hour), "completed", "success"),
		run(122, now.Add(-8*24*time.Hour), "completed", "failure")...)
	seed = append(seed, run(121, now.Add(-time.Hour), "in_progress", "")...)
	if err := os.WriteFile(fixture, seed, 0o600); err != nil {
		t.Fatal(err)
	}
	// #nosec G204 -- fixed runtime command and test-owned temporary files.
	initialize := exec.CommandContext(t.Context(), "node", "activity/cao.mjs", "ingest-jsonl",
		"--database", snapshot, "--input", fixture)
	initialize.Dir = root
	if output, err := initialize.CombinedOutput(); err != nil {
		t.Fatalf("initialize published snapshot: %v\n%s", err, output)
	}
	before, err := os.ReadFile(snapshot) // #nosec G304 -- test-owned temporary snapshot.
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fixture, run(124, now, "completed", "failure"), 0o600); err != nil {
		t.Fatal(err)
	}
	arguments := filepath.Join(directory, "arguments")
	gh := `#!/bin/sh
set -eu
if [ "$1" = api ]; then
  printf '%s\n' "$2" >> "` + arguments + `"
  printf '[{"workflows":[{"path":".github/workflows/test.lock.yml"}]}]\n'
  exit 0
fi
test "$1" = aw
test "$GH_TOKEN" = local-test-token
cache=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --cached-jsonl) cache="${2%\*}"; shift ;;
    --output) mkdir -p "$2"; shift ;;
    --start-date) printf '%s\n' "$2" >> "` + arguments + `"; shift ;;
  esac
  shift
done
cp "` + fixture + `" "${cache}1.jsonl"
`
	if err := os.WriteFile(filepath.Join(directory, "gh"), []byte(gh), 0o700); err != nil { // #nosec G306 -- executable test-only gh stub.
		t.Fatal(err)
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("GH_TOKEN", "local-test-token")
	t.Setenv("GITHUB_TOKEN", "unused-other-token")
	overlay := filepath.Join(directory, "overlay.sqlite")
	site := t.TempDir()
	if err := os.WriteFile(filepath.Join(site, "index.html"), []byte("<html>Dashboard</html>"), 0o600); err != nil {
		t.Fatal(err)
	}
	app, err := NewLocalSQLiteOverlayApp(t.Context(), snapshot, overlay, 0, Config{
		Listen: "127.0.0.1:8080", SiteDirectory: site, AccessToken: testAccessToken,
		DatabaseQueriesPath: filepath.Join(root, "dashboard/site/src/data/queries/database.json"),
		Logger:              log.New(&bytes.Buffer{}, "", 0),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := app.Start(t.Context()); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = app.Stop(context.WithoutCancel(t.Context())) }()
	store := app.database.(*sqlitex.Store)
	querySample := func(expectedRuns []string, exactCount int) queryResponse {
		t.Helper()
		req := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "http://localhost/api/v1/query",
			strings.NewReader(`{"sourceNames":["statistical-runs","runs"]}`))
		req.Header.Set("Content-Type", "application/json")
		authorize(req)
		response := httptest.NewRecorder()
		app.Handler().ServeHTTP(response, req)
		var result queryResponse
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || response.Code != http.StatusOK {
			t.Fatalf("sample HTTP query: %d %s %v", response.Code, response.Body.String(), err)
		}
		sample := result.Sources["statistical-runs"]
		frame, ok := sample.Metadata["statistical-frame"].(map[string]any)
		if !ok || frame["capacity"] != float64(8000) ||
			frame["population-count"] != float64(len(expectedRuns)) ||
			frame["selected-count"] != float64(len(expectedRuns)) ||
			frame["watermark-policy"] != "canonical-run-max" ||
			frame["selection-stage"] != "before-consumer-filter" || frame["weight-valid"] != false {
			t.Fatalf("missing conservative SQLite frame: %+v", sample.Metadata)
		}
		ids := make([]string, 0, len(sample.Rows))
		for _, row := range sample.Rows {
			ids = append(ids, row["run"].(string))
			if row["statistical-frame-id"] != frame["frame-id"] ||
				row["statistical-weight-valid"] != false || row["statistical-weight"] != nil {
				t.Fatalf("sample row lost its conservative frame binding: %+v", row)
			}
		}
		slices.Sort(ids)
		if !slices.Equal(ids, expectedRuns) || len(result.Sources["runs"].Rows) != exactCount {
			t.Fatalf("incorrect statistical/exact membership: %+v", result.Sources)
		}
		return result
	}
	initialQuery := querySample([]string{"123"}, 3)
	initial, err := store.State(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	working, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	relativeOverlay, err := filepath.Rel(working, overlay)
	if err != nil {
		t.Fatal(err)
	}
	b := localSQLiteBackfill{
		database: store, snapshot: snapshot, overlay: relativeOverlay, catalog: root, interval: time.Minute,
	}
	var logs bytes.Buffer
	var published int64
	if err := b.refresh(t.Context(), log.New(&logs, "", 0), func(revision int64) { published = revision }); err != nil {
		t.Fatalf("local refresh: %v\n%s", err, logs.String())
	}
	state, err := store.State(t.Context())
	if err != nil || state.Counts["$runs"] != 4 || published == 0 || published == initial.Revision {
		t.Fatalf("refresh did not publish fresher rows: %+v published=%d err=%v", state, published, err)
	}
	refreshed := querySample([]string{"123", "124"}, 4)
	initialFrame := initialQuery.Sources["statistical-runs"].Metadata["statistical-frame"].(map[string]any)
	refreshedFrame := refreshed.Sources["statistical-runs"].Metadata["statistical-frame"].(map[string]any)
	if refreshed.Revision == initialQuery.Revision || refreshedFrame["frame-id"] == initialFrame["frame-id"] ||
		refreshedFrame["watermark"] != now.Add(time.Minute).Format("2006-01-02T15:04:05.000Z") {
		t.Fatalf("backfill did not refresh HTTP sampling frame: %+v", refreshed)
	}
	if err := b.refresh(t.Context(), log.New(&logs, "", 0), func(revision int64) { published = revision }); err != nil {
		t.Fatalf("replay local refresh: %v", err)
	}
	replayed := querySample([]string{"123", "124"}, 4)
	if replayed.Sources["statistical-runs"].Metadata["statistical-frame"].(map[string]any)["frame-id"] != refreshedFrame["frame-id"] {
		t.Fatal("replayed evidence changed statistical membership frame")
	}
	after, err := os.ReadFile(snapshot) // #nosec G304 -- test-owned temporary snapshot.
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("refresh modified the deployed snapshot")
	}
	recorded, err := os.ReadFile(arguments) // #nosec G304 -- test-owned invocation log.
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(recorded), "repos/octo/one/actions/workflows") ||
		strings.Contains(string(recorded), "user/repos") || strings.Contains(logs.String(), "local-test-token") {
		t.Fatalf("refresh scope or logging is invalid: %s", recorded)
	}
}

func TestLocalBackfillMissingTokenIsExplicitAndCancellationStopsRetry(t *testing.T) {
	t.Setenv("GH_TOKEN", "")
	t.Setenv("GITHUB_TOKEN", "")
	t.Setenv("PATH", t.TempDir())
	if _, err := localBackfillToken(t.Context()); err == nil || !strings.Contains(err.Error(), "credentials unavailable") {
		t.Fatalf("missing credentials were not reported: %v", err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	b := localSQLiteBackfill{interval: time.Hour}
	done := make(chan struct{})
	go func() {
		b.run(ctx, log.New(&bytes.Buffer{}, "", 0), func(int64) { t.Error("canceled refresh published") })
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("backfill did not stop on cancellation")
	}
}
