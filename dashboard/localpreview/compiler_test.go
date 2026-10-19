package localpreview

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func workflowRow(path, version string) object {
	return object{
		"organization": "octo", "repository": "repo", "workflow": path,
		"gh-aw-version": version, "gh-aw-current-version": "v0.92.0", "gh-aw-update-state": "update-available",
	}
}

func TestCompilerReleaseRefreshPreservesSnapshotEvidence(t *testing.T) {
	rows := []any{}
	for _, version := range []string{"v0.91.5", "v0.92.0", "unknown"} {
		rows = append(rows, object{
			"gh-aw-version": version, "gh-aw-current-version": "v0.89.21",
			"gh-aw-update-state": "up-to-date", "observed-at": "2026-10-01T00:00:00Z",
		})
	}
	snapshot := object{"workflows": object{"metadata": object{"as-of": "2026-10-01T00:00:00Z"}, "rows": rows}}
	before := clone(snapshot)
	refreshed, err := RefreshCompilerRelease(snapshot, "0.92.0+build")
	if err != nil {
		t.Fatal(err)
	}
	for index, value := range list(obj(refreshed["workflows"])["rows"]) {
		row := obj(value)
		if row["gh-aw-current-version"] != "v0.92.0" || row["gh-aw-update-state"] != []string{"update-available", "up-to-date", "unknown"}[index] ||
			row["gh-aw-version"] != obj(rows[index])["gh-aw-version"] || row["observed-at"] != obj(rows[index])["observed-at"] {
			t.Fatalf("compiler comparison changed snapshot evidence: %#v", row)
		}
	}
	if !reflect.DeepEqual(obj(refreshed["workflows"])["metadata"], obj(snapshot["workflows"])["metadata"]) || !reflect.DeepEqual(snapshot, before) {
		t.Fatal("refresh changed observation metadata or mutated the snapshot")
	}
	for _, invalid := range []string{"", "invalid", "v0.93.0-rc.1", "v0.93.0-rc.01"} {
		if _, err := RefreshCompilerRelease(snapshot, invalid); err == nil {
			t.Fatalf("accepted invalid latest stable release %q", invalid)
		}
	}
	if _, err := RefreshCompilerRelease(object{"workflows": object{}}, "v0.92.0"); err == nil {
		t.Fatal("malformed workflow inventory was accepted")
	}
	if _, err := RefreshCompilerRelease(object{}, "v0.92.0"); err != nil {
		t.Fatal("missing optional workflow inventory should be preserved")
	}
}

func TestCompilerReleaseComparisonsPreserveVersionSemantics(t *testing.T) {
	for _, test := range []struct{ installed, latest, state string }{
		{"v0.91.5", "v0.92.0", "update-available"},
		{"v0.92.0", "v0.92.0", "up-to-date"},
		{"v0.93.0", "v0.92.0", "up-to-date"},
		{"v0.92.0-rc.1", "v0.92.0", "update-available"},
		{"v0.92.0", "v0.92.0-rc.1", "up-to-date"},
		{"v0.92.0-rc.2", "v0.92.0-rc.10", "update-available"},
		{"v0.92.0-1", "v0.92.0-alpha", "update-available"},
		{"v0.92.0-alpha", "v0.92.0-1", "up-to-date"},
		{"v0.92.0-alpha", "v0.92.0-alpha.1", "update-available"},
		{"v0.92.0-alpha.1", "v0.92.0-alpha", "up-to-date"},
		{"v0.92.0+build", "0.92.0", "up-to-date"},
		{"unknown", "v0.92.0", "unknown"},
		{"v0.92.0", "unknown", "unknown"},
		{"v0.92.0-rc.01", "v0.92.0", "unknown"},
	} {
		if actual := compilerUpdateState(test.installed, test.latest); actual != test.state {
			t.Errorf("%s versus %s: got %s, want %s", test.installed, test.latest, actual, test.state)
		}
	}
}

func TestLiveCompilerRefreshDeduplicatesRetainedCoordinates(t *testing.T) {
	paths := []string{"first.md", "first.lock.yml", ".github/workflows/first.md", ".github/workflows/first.lock.yml"}
	rows := []any{}
	for _, path := range paths {
		rows = append(rows, workflowRow(path, "v0.91.5"))
	}
	rows = append(rows, workflowRow("ci.yml", "v0.91.5"))
	other := workflowRow("first.md", "v0.91.5")
	other["repository"] = "other"
	rows = append(rows, other)
	sources := object{"workflows": object{"metadata": object{"as-of": "2026-10-01T00:00:00Z"}, "rows": rows}}
	before := clone(sources)
	var mutex sync.Mutex
	requested := []string{}
	refreshed, err := refreshCompilerVersions(context.Background(), sources, func(_ context.Context, path string) (compilerResponse, error) {
		mutex.Lock()
		requested = append(requested, path)
		mutex.Unlock()
		version := "v0.92.0"
		if strings.Contains(path, "/other/") {
			version = "v0.91.5"
		}
		return compilerResponse{status: 200, version: version}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(requested) != 2 {
		t.Fatalf("expected one read per retained repository/workflow coordinate, got %v", requested)
	}
	actual := list(obj(refreshed["workflows"])["rows"])
	for index := range paths {
		row := obj(actual[index])
		if row["gh-aw-version"] != "v0.92.0" || row["gh-aw-update-state"] != "up-to-date" {
			t.Fatalf("source/lock path aliases did not share compiler evidence: %#v", row)
		}
	}
	if !reflect.DeepEqual(actual[4], rows[4]) || obj(actual[5])["gh-aw-version"] != "v0.91.5" {
		t.Fatal("unrelated workflow or other repository received an incorrect override")
	}
	if !reflect.DeepEqual(sources, before) || !reflect.DeepEqual(obj(refreshed["workflows"])["metadata"], obj(sources["workflows"])["metadata"]) {
		t.Fatal("live refresh mutated source evidence or metadata")
	}
}

func TestUnavailableOrStaleCompilerEvidenceNeverEstablishesCurrentStatus(t *testing.T) {
	for _, response := range []compilerResponse{
		{status: 404}, {status: 503}, {status: 200, version: "invalid"},
		{status: 200, warning: `110 - "Response is stale"`, version: "v0.92.0"},
	} {
		sources := object{"workflows": object{"rows": []any{workflowRow("first.md", "v0.92.0")}}}
		refreshed, err := refreshCompilerVersions(context.Background(), sources, func(context.Context, string) (compilerResponse, error) { return response, nil })
		if err != nil {
			t.Fatal(err)
		}
		row := obj(list(obj(refreshed["workflows"])["rows"])[0])
		if row["gh-aw-version"] != "v0.92.0" || row["gh-aw-update-state"] != "unknown" {
			t.Fatalf("unavailable or stale evidence claimed current status: %#v", row)
		}
	}
	refreshed, err := refreshCompilerVersions(context.Background(), object{"workflows": object{"rows": []any{workflowRow("first.md", "v0.92.0")}}},
		func(context.Context, string) (compilerResponse, error) {
			return compilerResponse{}, errors.New("unavailable")
		})
	if err != nil || obj(list(obj(refreshed["workflows"])["rows"])[0])["gh-aw-update-state"] != "unknown" {
		t.Fatal("a failed read must retain evidence but clear current status")
	}
}

func TestLiveCompilerRefreshRejectsUntrustedCoordinatesAndUnknownRelease(t *testing.T) {
	first := workflowRow("first.md", "v0.91.5")
	first["gh-aw-current-version"] = "unknown"
	badRepository, badOrganization := workflowRow("second.md", "v0.91.5"), workflowRow("second.md", "v0.91.5")
	badRepository["repository"], badOrganization["organization"] = "..", "bad/owner"
	rows := []any{first, workflowRow("../secret.md", "v0.91.5"), workflowRow("bad/name.md", "v0.91.5"), badRepository, badOrganization}
	reads := 0
	refreshed, err := refreshCompilerVersions(context.Background(), object{"workflows": object{"rows": rows}},
		func(context.Context, string) (compilerResponse, error) {
			reads++
			return compilerResponse{status: 200, version: "v0.92.0"}, nil
		})
	if err != nil {
		t.Fatal(err)
	}
	actual := list(obj(refreshed["workflows"])["rows"])
	if reads != 1 || obj(actual[0])["gh-aw-update-state"] != "unknown" || !reflect.DeepEqual(actual[1:], rows[1:]) {
		t.Fatal("refresh widened retained workflow authority or inferred a known release")
	}
}

func TestLiveCompilerReadsAreBoundedAndOverflowIsUnknown(t *testing.T) {
	rows := []any{}
	for index := range 130 {
		rows = append(rows, workflowRow(fmt.Sprintf("workflow-%d.md", index), "v0.91.5"))
	}
	var reads, active, maximum atomic.Int32
	release := make(chan struct{})
	var once sync.Once
	refreshed, err := refreshCompilerVersions(context.Background(), object{"workflows": object{"rows": rows}},
		func(context.Context, string) (compilerResponse, error) {
			reads.Add(1)
			current := active.Add(1)
			for previous := maximum.Load(); current > previous && !maximum.CompareAndSwap(previous, current); previous = maximum.Load() {
			}
			if current == 8 {
				once.Do(func() { close(release) })
			}
			<-release
			active.Add(-1)
			return compilerResponse{status: 200, version: "v0.92.0"}, nil
		})
	if err != nil {
		t.Fatal(err)
	}
	if reads.Load() != 128 || maximum.Load() != 8 {
		t.Fatalf("refresh exceeded its budgets: reads=%d concurrency=%d", reads.Load(), maximum.Load())
	}
	for _, value := range list(obj(refreshed["workflows"])["rows"])[128:] {
		if obj(value)["gh-aw-update-state"] != "unknown" || obj(value)["gh-aw-version"] != "v0.91.5" {
			t.Fatal("workflows beyond the refresh limit must remain explicitly unknown")
		}
	}
}

func compilerFileResponse(t *testing.T, path, version string) []byte {
	t.Helper()
	content, err := json.Marshal(object{
		"type": "file", "path": path, "sha": strings.Repeat("a", 40), "encoding": "base64",
		"content": base64.StdEncoding.EncodeToString([]byte(`# gh-aw-metadata: {"compiler_version":"` + version + `"}` + "\n")),
	})
	if err != nil {
		t.Fatal(err)
	}
	return content
}

func TestCompilerGitHubMetadataIsValidatedAndStalenessPreserved(t *testing.T) {
	path := "repos/octo/repo/contents/.github/workflows/demo.lock.yml"
	content := compilerFileResponse(t, ".github/workflows/demo.lock.yml", "v0.92.0")
	response, err := readCompilerResponse(content, path)
	if err != nil || response.version != "v0.92.0" {
		t.Fatal("valid compiler metadata was not decoded")
	}
	stale := append([]byte("HTTP/2.0 200 OK\r\nWarning: 110 - \"Response is stale\"\r\n\r\n"), content...)
	response, err = readCompilerResponse(stale, path)
	if err != nil || response.warning == "" {
		t.Fatal("stale response authority was lost")
	}
	for _, invalid := range [][]byte{
		[]byte("{}"), []byte("invalid"), []byte(strings.Repeat("a", 513<<10)),
		compilerFileResponse(t, ".github/workflows/other.lock.yml", "v0.92.0"),
		[]byte(strings.Replace(string(content), `"encoding":"base64"`, `"encoding":"utf8"`, 1)),
		[]byte(strings.Replace(string(content), strings.Repeat("a", 40), "invalid-sha", 1)),
	} {
		if _, err := readCompilerResponse(invalid, path); err == nil {
			t.Fatal("invalid compiler resource was accepted")
		}
	}
}

func TestArtifactPreparationRefreshesLatestCompilerRelease(t *testing.T) {
	root := testDirectory(t)
	data := fixture(t, root)
	write(t, data, "inventory-sources.json", `{"workflows":{"metadata":{"as-of":"2026-10-01T00:00:00Z"},"rows":[{
		"organization":"octo","repository":"repo","workflow":"demo.md",
		"gh-aw-version":"v0.91.5","gh-aw-current-version":"v0.89.21","gh-aw-update-state":"up-to-date",
		"observed-at":"2026-10-01T00:00:00Z"
	}]}}`)
	executable := fakeGH(t, root, trustedArtifact, trustedRun)
	original := read(t, filepath.Join(data, "gh-aw-logs.sqlite"))
	w, err := Prepare(context.Background(), Options{Workspace: root, Repository: "owner/control", GHExecutable: executable})
	if err != nil {
		t.Fatal(err)
	}

	defer closeWorkspace(t, w)
	sources, _, err := readObject(filepath.Join(w.SourceDirectory, "inventory-sources.json"))
	if err != nil {
		t.Fatal(err)
	}
	row := obj(list(obj(sources["workflows"])["rows"])[0])
	if row["gh-aw-version"] != "v0.91.5" || row["gh-aw-current-version"] != "v0.92.0" || row["gh-aw-update-state"] != "update-available" ||
		row["observed-at"] != "2026-10-01T00:00:00Z" {
		t.Fatal("preparation did not refresh release comparison while preserving snapshot evidence")
	}
	if !strings.Contains(string(read(t, filepath.Join(root, "gh-calls"))), "repos/github/gh-aw/releases/latest") ||
		string(read(t, w.DatabasePath)) != string(original) {
		t.Fatal("release refresh was skipped or rewrote the native SQLite snapshot")
	}
	script := string(read(t, executable))
	script = strings.Replace(script, `printf '{"tag_name":"v0.92.0"}\n'`, "exit 1", 1)
	if err := os.WriteFile(executable, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	if next, err := Prepare(context.Background(), Options{Workspace: root, Repository: "owner/control", GHExecutable: executable}); err == nil {
		_ = next.Close()
		t.Fatal("missing latest release authority must fail closed")
	}
}
