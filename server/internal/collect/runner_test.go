package collect

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeTokens satisfies TokenProvider without contacting GitHub.
type fakeTokens struct{ token string }

func (f fakeTokens) InstallationToken(context.Context, int64) (string, error) {
	return f.token, nil
}

// writeFakeBinary installs an executable that records its arguments and
// environment so the test can assert the collection command line without
// running the real GitHub CLI.
func writeFakeBinary(t *testing.T, directory, name, body string) string {
	t.Helper()
	path := filepath.Join(directory, name)
	script := "#!/bin/sh\n" + body + "\n"
	// #nosec G306 -- the fake binary must be executable by the test process.
	if err := os.WriteFile(path, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestRunnerReproducesTheActionsCollectionCommand(t *testing.T) {
	workspace := t.TempDir()
	recordPath := filepath.Join(workspace, "gh-args")
	catalogRoot := filepath.Join(workspace, "catalog")
	if err := os.MkdirAll(filepath.Join(catalogRoot, "activity"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(catalogRoot, "activity", "cao.mjs"), []byte("//"), 0o600); err != nil {
		t.Fatal(err)
	}
	gh := writeFakeBinary(t, workspace, "gh",
		`printf '%s\n' "$@" > `+recordPath+`; printf 'token=%s\n' "$GH_TOKEN" >> `+recordPath)
	node := writeFakeBinary(t, workspace, "node", `exit 0`)
	lake := Lake{Directory: filepath.Join(workspace, "lake")}
	runner := Runner{
		Lake: lake, CatalogRoot: catalogRoot,
		GitHubBinary: gh, NodeBinary: node,
		Tokens: fakeTokens{token: "installation-token"},
	}
	if err := runner.Validate(); err != nil {
		t.Fatal(err)
	}
	if err := runner.Collect(context.Background(), Task{
		Repository: "Octo/API", InstallationID: 5,
	}); err != nil {
		t.Fatal(err)
	}
	recorded, err := os.ReadFile(recordPath) // #nosec G304 -- the path is built from the test's own temporary directory.
	if err != nil {
		t.Fatal(err)
	}
	arguments := string(recorded)
	for _, expected := range []string{
		"aw\nlogs\n--audit", "--repo\nocto/api", "--artifacts\nusage",
		"--start-date\n-30d", "--cache-before\n-30d", "--count\n10000",
		"--max-storage\n1200", "--prune-older-runs", "token=installation-token",
	} {
		if !strings.Contains(arguments, expected) {
			t.Fatalf("collection command is missing %q:\n%s", expected, arguments)
		}
	}
	if !strings.Contains(arguments, "--max-github-api-rate-limit\n-2000") {
		t.Fatalf("expected a negative reserve to be passed:\n%s", arguments)
	}
	if !strings.Contains(arguments, filepath.Join(lake.ShardDirectory(), "octo-api-logs-")+"*") {
		t.Fatalf("expected a repository-scoped shard prefix:\n%s", arguments)
	}
}

func TestRunnerDoesNotLeakAmbientCredentials(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "ambient-secret")
	t.Setenv("AZURE_CLIENT_SECRET", "ambient-secret")
	environment := collectionEnvironment()
	for _, entry := range environment {
		if strings.Contains(entry, "ambient-secret") {
			t.Fatalf("collection environment leaked an ambient credential: %q", entry)
		}
	}
}

func TestLakeUsesThePublishedSnapshotLayout(t *testing.T) {
	lake := Lake{Directory: t.TempDir()}
	if err := lake.Prepare(); err != nil {
		t.Fatal(err)
	}
	populated, err := lake.Populated()
	if err != nil {
		t.Fatal(err)
	}
	if populated {
		t.Fatal("an empty lake must not report as populated")
	}
	layout := map[string]string{
		"shards":   "gh-aw-logs-shards",
		"runs":     "gh-aw-logs-runs",
		"records":  "gh-aw-logs-records",
		"manifest": "payload-hashes.json",
		"sources":  "inventory-sources.json",
	}
	actual := map[string]string{
		"shards":   filepath.Base(lake.ShardDirectory()),
		"runs":     filepath.Base(lake.RunsDirectory()),
		"records":  filepath.Base(lake.RecordsDirectory()),
		"manifest": filepath.Base(lake.ManifestPath()),
		"sources":  filepath.Base(lake.InventoryPath()),
	}
	for key, want := range layout {
		if actual[key] != want {
			t.Fatalf("%s directory = %q, want %q", key, actual[key], want)
		}
	}
	// Populated means projectable: compacted run shards plus a manifest. Raw
	// collected shards alone are not enough, because projection validates the
	// manifest before reading anything.
	raw := filepath.Join(lake.ShardDirectory(), lake.ShardPrefix("octo/api")+"1.jsonl")
	if err := WriteFileAtomic(raw, []byte("{}\n")); err != nil {
		t.Fatal(err)
	}
	populated, err = lake.Populated()
	if err != nil {
		t.Fatal(err)
	}
	if populated {
		t.Fatal("raw shards without a manifest must not report as populated")
	}
	if err := WriteFileAtomic(filepath.Join(lake.RunsDirectory(), "runs.jsonl"), []byte("{}\n")); err != nil {
		t.Fatal(err)
	}
	if err := WriteFileAtomic(lake.ManifestPath(), []byte("{}")); err != nil {
		t.Fatal(err)
	}
	populated, err = lake.Populated()
	if err != nil {
		t.Fatal(err)
	}
	if !populated {
		t.Fatal("a lake holding shards must report as populated")
	}
}

func TestWriteFileAtomicLeavesNoPartialFile(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "nested", "manifest.json")
	payload, err := json.Marshal(map[string]string{"a": "b"})
	if err != nil {
		t.Fatal(err)
	}
	if err := WriteFileAtomic(path, payload); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "manifest.json" {
		t.Fatalf("unexpected directory contents: %v", entries)
	}
}
