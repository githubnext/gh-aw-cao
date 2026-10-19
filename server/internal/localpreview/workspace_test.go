package localpreview

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func testDirectory(t *testing.T) string {
	t.Helper()
	directory, err := os.MkdirTemp(".", ".preview-test-")
	if err != nil {
		t.Fatal(err)
	}
	directory, err = filepath.Abs(directory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	return directory
}

func write(t *testing.T, root, name, value string) string {
	t.Helper()
	file := filepath.Join(root, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(value), 0o600); err != nil {
		t.Fatal(err)
	}
	return file
}

func read(t *testing.T, name string) []byte {
	t.Helper()
	content, err := os.ReadFile(name) // #nosec G304 -- Test-owned fixture path.
	if err != nil {
		t.Fatal(err)
	}
	return content
}

func closeWorkspace(t *testing.T, workspace *Workspace) {
	t.Helper()
	if err := workspace.Close(); err != nil {
		t.Error(err)
	}
}

const baseDocument = `{
	"language-version":"0.1.0",
	"dashboard":{"id":"test","title":"Test","pages":[
		{"id":"overview","title":"Overview","kind":"custom","views":[
			{"id":"runs","title":"Runs","mark":"table","data":{"source":"test-runs"}}
		]}
	],"queries":[{"name":"test-runs","from":"canonical-runs"}],
	"navigation":[{"label":"Operations","pages":["overview"]}]}
}`

func fixture(t *testing.T, workspace string) string {
	t.Helper()
	directory := filepath.Join(workspace, "fixture", "cao")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", filepath.Join(directory, "gh-aw-logs.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`CREATE TABLE __idb_records(database_name TEXT,store_name TEXT,record_key TEXT,value TEXT)`,
		`INSERT INTO __idb_records VALUES ('gh-aw-cao-dashboard-data','runs','"run-1"','{"id":"run-1","status":"success"}')`,
	} {
		if _, err := db.ExecContext(t.Context(), statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	write(t, directory, "inventory-sources.json", `{"repositories":{"rows":[{"repository":"o/r","api-key":"never-show-this"}]}}`)
	write(t, directory, "gh-aw-logs-runs/run.jsonl", `{"id":"run-1","token":"never-show-this","body":"Bearer secretCredential","status":"success"}`+"\n")
	refreshHashes(t, directory)
	write(t, directory, "index.html", "<!doctype html><title>Published dashboard</title>")
	write(t, directory, "dashboard.json", baseDocument)
	write(t, directory, "src/main.js", "document.title = 'Published dashboard';")
	return directory
}

func refreshHashes(t *testing.T, directory string) {
	t.Helper()
	hashes := object{}
	for _, name := range []string{"gh-aw-logs.sqlite", "gh-aw-logs-runs/run.jsonl"} {
		digest := sha256.Sum256(read(t, filepath.Join(directory, name)))
		hashes[name] = hex.EncodeToString(digest[:])
	}
	content, err := json.Marshal(hashes)
	if err != nil {
		t.Fatal(err)
	}
	write(t, directory, "payload-hashes.json", string(content))
}

func TestPrepareOfflineNativeSnapshot(t *testing.T) {
	root := testDirectory(t)
	data := fixture(t, root)
	original := read(t, filepath.Join(data, "gh-aw-logs.sqlite"))
	workspace, err := Prepare(context.Background(), Options{Workspace: root, DataDirectory: "fixture", Repository: "owner/control"})
	if err != nil {
		t.Fatal(err)
	}
	defer closeWorkspace(t, workspace)
	if !within(root, workspace.Directory) || workspace.SiteDirectory != workspace.SourceDirectory {
		t.Fatalf("unexpected isolated paths: %+v", workspace)
	}
	if len(workspace.Prefix) != 49 || !regexpCapability(workspace.Prefix) {
		t.Fatalf("invalid capability: %q", workspace.Prefix)
	}
	if string(read(t, workspace.DatabasePath)) != string(original) {
		t.Fatal("native snapshot was modified")
	}
	var core object
	if err := json.Unmarshal(read(t, filepath.Join(workspace.OverlayDirectory, "dashboard.json")), &core); err != nil {
		t.Fatal(err)
	}
	body := obj(core["dashboard"])
	if body["repository"] != "owner/control" {
		t.Fatal("control repository was not applied")
	}
	page := obj(list(body["pages"])[0])
	if _, present := page["views"]; present || !strings.HasPrefix(text(page["chunk"]), "dashboard-pages/") {
		t.Fatal("page was not split into an immutable chunk")
	}
	var chunk object
	if err := json.Unmarshal(read(t, filepath.Join(workspace.OverlayDirectory, text(page["chunk"]))), &chunk); err != nil {
		t.Fatal(err)
	}
	if len(list(chunk["queries"])) != 1 || len(list(obj(chunk["page"])["views"])) != 1 {
		t.Fatal("chunk lost its queries or view")
	}
	inventory := read(t, filepath.Join(workspace.SourceDirectory, "inventory-sources.json"))
	shard := read(t, filepath.Join(workspace.OverlayDirectory, "gh-aw-logs-runs/run.jsonl"))
	if strings.Contains(string(inventory), "never-show") || strings.Contains(string(shard), "secretCredential") || strings.Contains(string(shard), "never-show") {
		t.Fatal("secrets leaked through public preview inputs")
	}
	var hashes object
	if err := json.Unmarshal(read(t, filepath.Join(workspace.OverlayDirectory, "payload-hashes.json")), &hashes); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(shard)
	if hashes["gh-aw-logs-runs/run.jsonl"] != hex.EncodeToString(digest[:]) {
		t.Fatal("published redacted shard hash does not match its bytes")
	}
	copy := workspace.Dashboard()
	obj(copy["dashboard"])["title"] = "mutated"
	if obj(workspace.Dashboard()["dashboard"])["title"] == "mutated" {
		t.Fatal("Dashboard returned mutable shared state")
	}
	previewDirectory := workspace.Directory
	if err := workspace.Close(); err != nil {
		t.Fatal(err)
	}
	if err := workspace.Close(); err != nil {
		t.Fatal("Close must be idempotent")
	}
	if _, err := os.Stat(previewDirectory); !os.IsNotExist(err) {
		t.Fatal("Close did not remove preview files")
	}
	if _, err := os.Stat(data); err != nil {
		t.Fatal("Close removed source data")
	}
}

func regexpCapability(prefix string) bool {
	_, err := hex.DecodeString(strings.TrimPrefix(prefix, "/"))
	return err == nil && strings.HasPrefix(prefix, "/")
}

func TestPrepareRejectsUnsafeOrMalformedArtifacts(t *testing.T) {
	tests := map[string]func(*testing.T, string, string){
		"checksum": func(t *testing.T, root, data string) {
			write(t, data, "gh-aw-logs-runs/run.jsonl", "{}")
		},
		"malformed-jsonl": func(t *testing.T, root, data string) {
			write(t, data, "gh-aw-logs-runs/run.jsonl", "not json")
			refreshHashes(t, data)
		},
		"malformed-inventory": func(t *testing.T, root, data string) {
			write(t, data, "inventory-sources.json", "[]")
		},
		"missing-manifest": func(t *testing.T, root, data string) {
			if err := os.Remove(filepath.Join(data, "payload-hashes.json")); err != nil {
				t.Fatal(err)
			}
		},
		"missing-database": func(t *testing.T, root, data string) {
			if err := os.Remove(filepath.Join(data, "gh-aw-logs.sqlite")); err != nil {
				t.Fatal(err)
			}
		},
		"multiple-canonical": func(t *testing.T, root, data string) {
			write(t, root, "fixture/another/inventory-sources.json", "{}")
		},
		"unsafe-manifest": func(t *testing.T, root, data string) {
			var manifest object
			if err := json.Unmarshal(read(t, filepath.Join(data, "payload-hashes.json")), &manifest); err != nil {
				t.Fatal(err)
			}
			manifest["../outside.jsonl"] = strings.Repeat("a", 64)
			content, _ := json.Marshal(manifest)
			write(t, data, "payload-hashes.json", string(content))
		},
		"symlink": func(t *testing.T, root, data string) {
			if err := os.Symlink(filepath.Join(root, "fixture"), filepath.Join(data, "loop")); err != nil {
				t.Fatal(err)
			}
		},
		"malformed-canonical-record": func(t *testing.T, root, data string) {
			db, err := sql.Open("sqlite", filepath.Join(data, "gh-aw-logs.sqlite"))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := db.ExecContext(t.Context(), `UPDATE __idb_records SET value='[]'`); err != nil {
				t.Fatal(err)
			}
			_ = db.Close()
			refreshHashes(t, data)
		},
		"wrong-database": func(t *testing.T, root, data string) {
			db, err := sql.Open("sqlite", filepath.Join(data, "gh-aw-logs.sqlite"))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := db.ExecContext(t.Context(), `UPDATE __idb_records SET database_name='unrelated'`); err != nil {
				t.Fatal(err)
			}
			_ = db.Close()
			refreshHashes(t, data)
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			root := testDirectory(t)
			data := fixture(t, root)
			mutate(t, root, data)
			if workspace, err := Prepare(context.Background(), Options{Workspace: root, DataDirectory: "fixture"}); err == nil {
				_ = workspace.Close()
				t.Fatal("invalid artifact was accepted")
			}
			entries, err := filepath.Glob(filepath.Join(root, ".cao-dashboard-preview-*"))
			if err != nil || len(entries) != 0 {
				t.Fatal("failed preparation leaked disposable files")
			}
		})
	}
}

func TestWorkspaceContainment(t *testing.T) {
	root := testDirectory(t)
	outside := testDirectory(t)
	fixture(t, root)
	write(t, outside, "index.html", "outside")
	if err := os.Symlink(outside, filepath.Join(root, "external")); err != nil {
		t.Fatal(err)
	}
	for _, options := range []Options{
		{Workspace: root, DataDirectory: "fixture", SiteDirectory: "external"},
		{Workspace: root, DataDirectory: "fixture", CatalogDirectory: outside},
		{Workspace: root, DataDirectory: outside},
		{Workspace: root, DataDirectory: "fixture", DashboardPath: "../missing.json"},
		{Workspace: root, DataDirectory: "fixture", Canvas: true, Admin: true},
	} {
		if workspace, err := Prepare(context.Background(), options); err == nil {
			_ = workspace.Close()
			t.Fatal("out-of-workspace or conflicting configuration was accepted")
		}
	}
}

func TestFragmentsCampaignsAndAtomicRefresh(t *testing.T) {
	root := testDirectory(t)
	data := fixture(t, root)
	write(t, root, "site/index.html", "<!doctype html>")
	base := strings.Replace(baseDocument, `"dashboard":`, `"fragments":["fragments/extra.json"],"dashboard":`, 1)
	write(t, root, "site/dashboard.json", base)
	write(t, root, "site/fragments/extra.json", `{"pages":[{"id":"fragment","title":"Fragment","kind":"custom","views":[]}],"navigation":[{"label":"Operations","pages":["fragment"]}]}`)
	write(t, root, "README.txt", "catalog non-directory entries must be ignored")
	write(t, root, ".cao-dashboard-preview-stale/dashboard.json", baseDocument)
	write(t, root, "campaign/dashboard.json", strings.ReplaceAll(strings.ReplaceAll(baseDocument, "overview", "campaign"), "test-runs", "campaign-runs"))
	w, err := Prepare(context.Background(), Options{Workspace: root, DataDirectory: data, SiteDirectory: "site", CatalogDirectory: root})
	if err != nil {
		t.Fatal(err)
	}
	defer closeWorkspace(t, w)
	if len(list(obj(w.Dashboard()["dashboard"])["pages"])) != 3 {
		t.Fatal("fragment or campaign page was not composed")
	}
	if groups := list(obj(w.Dashboard()["dashboard"])["navigation"]); len(groups) != 1 || len(list(obj(groups[0])["pages"])) != 3 {
		t.Fatal("navigation sections were not merged by label")
	}
	prior := read(t, filepath.Join(w.OverlayDirectory, "dashboard.json"))
	var core object
	_ = json.Unmarshal(prior, &core)
	oldChunk := text(obj(list(obj(core["dashboard"])["pages"])[0])["chunk"])
	write(t, root, "site/fragments/extra.json", `{"pages":[`)
	if _, err := w.Refresh(); err == nil {
		t.Fatal("invalid source was accepted")
	}
	if string(read(t, filepath.Join(w.OverlayDirectory, "dashboard.json"))) != string(prior) {
		t.Fatal("invalid update replaced last valid dashboard")
	}
	write(t, root, "site/fragments/extra.json", `{"pages":[{"id":"fragment","title":"Updated","kind":"custom","views":[]}]}`)
	if _, err := w.Refresh(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(w.OverlayDirectory, oldChunk)); err != nil {
		t.Fatal("refresh invalidated an already-published immutable chunk")
	}
}

func TestPublishedPageChunksAreHydrated(t *testing.T) {
	root := testDirectory(t)
	data := fixture(t, root)
	var original object
	_ = json.Unmarshal([]byte(baseDocument), &original)
	core, chunks, err := splitDocument(original)
	if err != nil {
		t.Fatal(err)
	}
	content, _ := json.Marshal(core)
	write(t, data, "dashboard.json", string(content))
	for name, content := range chunks {
		write(t, data, name, string(content))
	}
	w, err := Prepare(context.Background(), Options{Workspace: root, DataDirectory: "fixture"})
	if err != nil {
		t.Fatal(err)
	}
	defer closeWorkspace(t, w)
	if len(list(obj(w.Dashboard()["dashboard"])["queries"])) != 1 {
		t.Fatal("published page queries were not hydrated")
	}
}

func TestEmbeddedSiteNeedsNoBuildOrPackageInstallation(t *testing.T) {
	root := testDirectory(t)
	data := fixture(t, root)
	if err := os.Remove(filepath.Join(data, "index.html")); err != nil {
		t.Fatal(err)
	}
	w, err := Prepare(context.Background(), Options{Workspace: root, DataDirectory: "fixture", Canvas: true})
	if err != nil {
		t.Fatal(err)
	}
	defer closeWorkspace(t, w)
	if w.SiteDirectory == w.SourceDirectory {
		t.Fatal("embedded site fallback was not extracted")
	}
	if _, err := os.Stat(filepath.Join(w.SiteDirectory, "node_modules")); !os.IsNotExist(err) {
		t.Fatal("embedded site must not require an npm installation")
	}
	validator := read(t, filepath.Join(w.OverlayDirectory, "src/validator-dashboard.js"))
	if !strings.Contains(string(validator), "./vendor/yaml.js") || strings.Contains(string(validator), "from 'yaml'") {
		t.Fatal("source validator does not use its embedded browser dependency")
	}
	terminal := read(t, filepath.Join(w.OverlayDirectory, "src/components/cli-terminal-runtime.js"))
	if strings.Contains(string(terminal), "@xterm/") || !strings.Contains(string(terminal), "../vendor/xterm.js") {
		t.Fatal("source terminal has unresolved package imports")
	}
	for _, name := range []string{"yaml.js", "xterm.js", "addon-fit.js", "addon-web-links.js", "strip-ansi.js", "xterm-css.js"} {
		if content := read(t, filepath.Join(w.OverlayDirectory, "src/vendor", name)); len(content) == 0 {
			t.Fatal("embedded browser dependency is empty")
		}
	}
	licenses := read(t, filepath.Join(w.OverlayDirectory, "src/vendor/third-party-licenses.txt"))
	if !strings.Contains(string(licenses), "Copyright") {
		t.Fatal("third-party license notices were not retained")
	}
	foundEditor := false
	for _, candidate := range list(obj(w.Dashboard()["dashboard"])["pages"]) {
		foundEditor = foundEditor || obj(candidate)["id"] == "query-editor"
	}
	if !foundEditor {
		t.Fatal("canvas query editor page was not composed")
	}
}

func TestCanvasCustomViewSaveAndNamespacing(t *testing.T) {
	root := testDirectory(t)
	fixture(t, root)
	w, err := Prepare(context.Background(), Options{Workspace: root, DataDirectory: "fixture", Canvas: true})
	if err != nil {
		t.Fatal(err)
	}
	defer closeWorkspace(t, w)
	document := `{"language-version":"0.1.0","dashboard":{
		"id":"authored","title":"Authored","queries":[{"name":"authored-runs","from":"canonical-runs","limit":10}],
		"pages":[{"id":"query-preview","title":"My view","kind":"custom","views":[{"id":"table","title":"Runs","mark":"table","data":{"source":"authored-runs","limit":10}}]}]
	}}`
	result, err := w.SaveDashboard(context.Background(), []byte(document))
	if err != nil {
		t.Fatal(err)
	}
	saved := obj(result)
	id := text(saved["id"])
	if !strings.HasPrefix(id, "local-") || saved["dashboard"] == nil {
		t.Fatal("SaveDashboard did not return an identified view and active dashboard")
	}
	var customPage object
	for _, candidate := range list(obj(w.Dashboard()["dashboard"])["pages"]) {
		if obj(candidate)["id"] == id {
			customPage = obj(candidate)
		}
	}
	if customPage == nil {
		t.Fatal("saved custom page was not materialized")
	}
	view := obj(list(customPage["views"])[0])
	if view["id"] != id+"-table" || obj(view["data"])["source"] != id+"-authored-runs" {
		t.Fatal("custom view identifiers or query references were not isolated")
	}
	if _, err := w.SaveDashboard(context.Background(), []byte(document)); err != nil {
		t.Fatal("saving the same view must be idempotent")
	}
}

func TestBackendSpecificPageSourceIndexes(t *testing.T) {
	document := object{
		"language-version": "0.1.0",
		"dashboard": object{"pages": []any{object{
			"id": "conditional", "title": "Conditional", "kind": "custom",
			"views": []any{
				object{"mark": "table", "data": object{"source": "static-data"}, "requires": object{"backend": "static"}},
				object{"mark": "table", "data": object{"source": "hosted-data"}, "requires": object{"backend": "hosted"}},
			},
		}}},
	}
	core, _, err := splitDocument(document)
	if err != nil {
		t.Fatal(err)
	}
	index := obj(obj(list(obj(core["dashboard"])["pages"])[0])["backend-source-index"])
	for backend, expected := range map[string]string{"static": "static-data", "hosted": "hosted-data"} {
		values, _ := obj(index[backend])["sourceNames"].([]string)
		if len(values) != 1 || values[0] != expected {
			t.Fatalf("backend %s has incorrect source names: %#v", backend, index[backend])
		}
	}
}

func TestRejectsFragmentsOutsideSourceDirectory(t *testing.T) {
	for name, fragment := range map[string]string{"parent": "../outside.json", "absolute": "/outside.json", "duplicate": "same.json"} {
		t.Run(name, func(t *testing.T) {
			root := testDirectory(t)
			data := fixture(t, root)
			write(t, root, "outside.json", `{"pages":[]}`)
			document := strings.Replace(baseDocument, `"dashboard":`, `"fragments":["`+fragment+`"],"dashboard":`, 1)
			if name == "duplicate" {
				write(t, data, "same.json", `{"queries":[]}`)
				document = strings.Replace(document, `["same.json"]`, `["same.json","same.json"]`, 1)
			}
			write(t, data, "dashboard.json", document)
			if w, err := Prepare(context.Background(), Options{Workspace: root, DataDirectory: "fixture"}); err == nil {
				_ = w.Close()
				t.Fatal("unsafe fragment was accepted")
			}
		})
	}
}

func TestWatchRetainsLastValidOutput(t *testing.T) {
	root := testDirectory(t)
	fixture(t, root)
	write(t, root, "site/index.html", "<!doctype html>")
	path := write(t, root, "site/dashboard.json", baseDocument)
	w, err := Prepare(context.Background(), Options{Workspace: root, DataDirectory: "fixture", SiteDirectory: "site"})
	if err != nil {
		t.Fatal(err)
	}
	defer closeWorkspace(t, w)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	updates := make(chan []byte, 4)
	done := make(chan error, 1)
	go func() { done <- w.Watch(ctx, func(content []byte) { updates <- content }) }()
	time.Sleep(50 * time.Millisecond)
	if err := os.WriteFile(path, []byte(`{"broken":`), 0o600); err != nil {
		t.Fatal(err)
	}
	select {
	case <-updates:
		t.Fatal("invalid edit triggered callback")
	case <-time.After(350 * time.Millisecond):
	}
	valid := strings.Replace(baseDocument, `"title":"Test"`, `"title":"Watch updated"`, 1)
	if err := os.WriteFile(path, []byte(valid), 0o600); err != nil {
		t.Fatal(err)
	}
	select {
	case content := <-updates:
		if !strings.Contains(string(content), "Watch updated") {
			t.Fatal("callback did not receive updated valid document")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("valid edit was not published")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("Watch did not stop after cancellation")
	}
}

func fakeGH(t *testing.T, root, artifacts, provenance string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake gh uses a POSIX shell")
	}
	write(t, root, "repo-response.json", `{"default_branch":"main","full_name":"owner/control"}`)
	write(t, root, "artifacts-response.json", artifacts)
	write(t, root, "run-response.json", provenance)
	executable := write(t, root, "fake-gh", `#!/bin/sh
printf '%s\n' "$*" >> gh-calls
case "$1 $2" in
  'auth status') exit 0 ;;
  'api repos/owner/control') cat repo-response.json ;;
  'api repos/owner/control/actions/artifacts?name=central-agentic-ops-dashboard&per_page=100') cat artifacts-response.json ;;
  'api repos/owner/control/actions/runs/42') cat run-response.json ;;
  'api repos/github/gh-aw/releases/latest') printf '{"tag_name":"v0.92.0"}\n' ;;
  'run download')
    while [ "$#" -gt 0 ]; do
      if [ "$1" = '--dir' ]; then shift; cp -R fixture/. "$1"/; exit 0; fi
      shift
    done
    exit 2 ;;
  *) exit 3 ;;
esac
`)
	if err := os.Chmod(executable, 0o700); err != nil { // #nosec G302 -- Private, trusted executable fixture.
		t.Fatal(err)
	}
	return executable
}

const trustedArtifact = `{"artifacts":[{"name":"central-agentic-ops-dashboard","expired":false,"created_at":"2026-10-01T00:00:00Z","workflow_run":{"id":42}}]}`
const trustedRun = `{"status":"completed","conclusion":"success","head_branch":"main","path":".github/workflows/cao-dashboard.yml","head_repository":{"full_name":"owner/control"}}`

func TestAuthenticatedArtifactProvenance(t *testing.T) {
	for name, provenance := range map[string]string{
		"trusted":      trustedRun,
		"failed":       strings.Replace(trustedRun, "success", "failure", 1),
		"wrong-branch": strings.Replace(trustedRun, `"main"`, `"feature"`, 1),
		"wrong-path":   strings.Replace(trustedRun, "cao-dashboard.yml", "untrusted.yml", 1),
		"fork":         strings.Replace(trustedRun, `"owner/control"`, `"attacker/fork"`, 1),
	} {
		t.Run(name, func(t *testing.T) {
			root := testDirectory(t)
			fixture(t, root)
			executable := fakeGH(t, root, trustedArtifact, provenance)
			w, err := Prepare(context.Background(), Options{Workspace: root, Repository: "owner/control", GHExecutable: executable})
			if name != "trusted" {
				if err == nil {
					_ = w.Close()
					t.Fatal("untrusted artifact was accepted")
				}
				if strings.Contains(string(read(t, filepath.Join(root, "gh-calls"))), "run download") {
					t.Fatal("artifact was downloaded before provenance was verified")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			defer closeWorkspace(t, w)
			calls := string(read(t, filepath.Join(root, "gh-calls")))
			if !strings.HasPrefix(calls, "auth status --hostname github.com\n") || !strings.Contains(calls, "run download 42") {
				t.Fatal("artifact authentication or download was skipped")
			}
		})
	}
}

func TestArtifactSelectionFailsClosed(t *testing.T) {
	for name, artifacts := range map[string]string{
		"expired":        strings.Replace(trustedArtifact, `"expired":false`, `"expired":true`, 1),
		"missing":        `{"artifacts":[]}`,
		"malformed":      `{"artifacts":"unexpected"}`,
		"missing-expiry": strings.Replace(trustedArtifact, `"expired":false,`, "", 1),
		"latest-untrusted": `{"artifacts":[
			{"name":"central-agentic-ops-dashboard","expired":false,"created_at":"2026-10-01T00:00:00Z","workflow_run":{"id":42}},
			{"name":"central-agentic-ops-dashboard","expired":false,"created_at":"2026-10-02T00:00:00Z","workflow_run":{"id":99}}
		]}`,
	} {
		t.Run(name, func(t *testing.T) {
			root := testDirectory(t)
			fixture(t, root)
			executable := fakeGH(t, root, artifacts, trustedRun)
			if w, err := Prepare(context.Background(), Options{Workspace: root, Repository: "owner/control", GHExecutable: executable}); err == nil {
				_ = w.Close()
				t.Fatal("invalid artifact selection was accepted")
			}
		})
	}
}

func TestRedactionAndAuthenticationErrors(t *testing.T) {
	root := testDirectory(t)
	executable := write(t, root, "fake-gh", "#!/bin/sh\necho 'Bearer sensitivecredential ghp_abcdefghijklmnopqrstuvwx' >&2\nexit 1\n")
	if err := os.Chmod(executable, 0o700); err != nil { // #nosec G302 -- Private, trusted executable fixture.
		t.Fatal(err)
	}
	_, err := Prepare(context.Background(), Options{Workspace: root, Repository: "owner/control", GHExecutable: executable})
	if err == nil || strings.Contains(err.Error(), "sensitivecredential") || strings.Contains(err.Error(), "ghp_") {
		t.Fatal("authentication error leaked credentials")
	}
	value := object{
		"token":  "sensitive",
		"safe":   []any{"ghp_abcdefghijklmnopqrstuvwx", "Bearer credential", "AKIAABCDEFGHIJKLMNOP", "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----"},
		"nested": object{"client-secret": "sensitive", "label": "kept"},
	}
	content, _ := json.Marshal(redact(value, ""))
	if strings.Contains(string(content), "sensitive") || strings.Contains(string(content), "credential") || strings.Contains(string(content), "ghp_") || !strings.Contains(string(content), "kept") {
		t.Fatal("secret redaction failed")
	}
}
