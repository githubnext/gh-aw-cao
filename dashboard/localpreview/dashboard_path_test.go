package localpreview

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/githubnext/gh-aw-cao/dashboard"
)

func fixtureWithoutSite(t *testing.T, root string) string {
	t.Helper()
	data := fixture(t, root)
	if err := os.Remove(filepath.Join(data, "index.html")); err != nil {
		t.Fatal(err)
	}
	return data
}

func TestExplicitWorkspaceDashboardDoesNotRequireAnExplicitSite(t *testing.T) {
	root := testDirectory(t)
	fixtureWithoutSite(t, root)
	document := strings.Replace(baseDocument, `"dashboard":`, `"fragments":["fragments/editable.json"],"dashboard":`, 1)
	path := write(t, root, "fixture-dashboard.json", document)
	write(t, root, "fragments/editable.json", `{"pages":[{"id":"editable","title":"Editable fragment","kind":"custom","views":[]}]}`)
	w, err := Prepare(t.Context(), Options{Workspace: root, DataDirectory: "fixture", DashboardPath: path})
	if err != nil {
		t.Fatal(err)
	}
	defer closeWorkspace(t, w)
	if w.base != path || within(w.SiteDirectory, path) {
		t.Fatal("explicit editable dashboard was not independent of bundled UI assets")
	}
	pages := list(obj(w.Dashboard()["dashboard"])["pages"])
	if len(pages) != 2 || obj(pages[1])["id"] != "editable" {
		t.Fatal("explicit dashboard did not resolve fragments relative to its own directory")
	}
	write(t, root, "fragments/editable.json", `{"pages":[{"id":"editable","title":"Updated fragment","kind":"custom","views":[]}]}`)
	if _, err := w.Refresh(); err != nil {
		t.Fatal(err)
	}
	if obj(list(obj(w.Dashboard()["dashboard"])["pages"])[1])["title"] != "Updated fragment" {
		t.Fatal("workspace-owned editable fragment was not refreshed")
	}
}

func TestExplicitWorkspaceDashboardRejectsMissingFragmentDependencies(t *testing.T) {
	root := testDirectory(t)
	fixtureWithoutSite(t, root)
	content, err := dashboard.Site.ReadFile("site/dashboard.json")
	if err != nil {
		t.Fatal(err)
	}
	write(t, root, "fixture-dashboard.json", string(content))
	w, err := Prepare(t.Context(), Options{Workspace: root, DataDirectory: "fixture", DashboardPath: "fixture-dashboard.json"})
	if err == nil {
		_ = w.Close()
		t.Fatal("copied source dashboard silently resolved missing dependencies from unrelated UI assets")
	}
	if !strings.Contains(err.Error(), "load dashboard fragment: dashboard input file does not exist") {
		t.Fatalf("missing fragment was misreported as a workspace authority failure: %v", err)
	}
}

func TestExplicitWorkspaceDashboardRetainsContainmentDuringRefresh(t *testing.T) {
	root := testDirectory(t)
	outside := testDirectory(t)
	fixtureWithoutSite(t, root)
	path := write(t, root, "editable/dashboard.json", baseDocument)
	external := write(t, outside, "external.json", strings.Replace(baseDocument, `"title":"Test"`, `"title":"Outside"`, 1))
	w, err := Prepare(t.Context(), Options{Workspace: root, DataDirectory: "fixture", DashboardPath: "editable/dashboard.json"})
	if err != nil {
		t.Fatal(err)
	}
	defer closeWorkspace(t, w)
	prior := read(t, filepath.Join(w.OverlayDirectory, "dashboard.json"))
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(external, path); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Refresh(); err == nil {
		t.Fatal("explicit dashboard symlink escaped the selected workspace")
	}
	if string(prior) != string(read(t, filepath.Join(w.OverlayDirectory, "dashboard.json"))) {
		t.Fatal("unsafe update replaced the last valid dashboard")
	}
	if _, err := Prepare(context.Background(), Options{Workspace: root, DataDirectory: "fixture", DashboardPath: path}); err == nil {
		t.Fatal("unsafe explicit dashboard was accepted during startup")
	}
}
