package server

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
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
	now := time.Now().UTC()
	run := func(id int, at time.Time) []byte {
		content, err := json.Marshal(map[string]any{
			"schema_version": 2, "kind": "run", "run": map[string]any{
				"organization": "octo", "repository": "one", "run_id": id, "run_attempt": 1,
				"workflow_name": "test", "workflow_path": ".github/workflows/test.lock.yml",
				"created_at": at.Format(time.RFC3339), "updated_at": at.Format(time.RFC3339),
				"status": "completed", "conclusion": "success",
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		return append(content, '\n')
	}
	snapshot := filepath.Join(directory, "snapshot.sqlite")
	fixture := filepath.Join(directory, "run.jsonl")
	if err := os.WriteFile(fixture, run(123, now.Add(-2*time.Hour)), 0o600); err != nil {
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
	if err := os.WriteFile(fixture, run(124, now), 0o600); err != nil {
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
	store, err := sqlitex.OpenOverlay(t.Context(), snapshot, overlay, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
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
	if err != nil || state.Counts["$runs"] != 2 || published == 0 || published == initial.Revision {
		t.Fatalf("refresh did not publish fresher rows: %+v published=%d err=%v", state, published, err)
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
