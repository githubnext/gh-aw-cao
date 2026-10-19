package localpreview

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestWatchPublishesCanvasSavesAndExternalFragments(t *testing.T) {
	root := testDirectory(t)
	fixture(t, root)
	write(t, root, "site/index.html", "<!doctype html>")
	write(t, root, "site/dashboard.json", strings.Replace(baseDocument,
		`"dashboard":`, `"fragments":["fragment.json"],"dashboard":`, 1))
	fragment := `{"pages":[{"id":"fragment","title":"Fragment initial","kind":"custom","views":[]}]}`
	write(t, root, "site/fragment.json", fragment)
	w, err := Prepare(context.Background(), Options{
		Workspace: root, DataDirectory: "fixture", SiteDirectory: "site", Canvas: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer closeWorkspace(t, w)
	ctx, cancel := context.WithCancel(context.Background())
	updates := make(chan []byte, 4)
	done := make(chan error, 1)
	go func() {
		done <- w.Watch(ctx, func(content []byte) { updates <- content })
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(3 * time.Second):
			t.Error("Watch did not stop after cancellation")
		}
	})
	next := func(expected string) []byte {
		t.Helper()
		select {
		case content := <-updates:
			if !strings.Contains(string(content), expected) {
				t.Fatalf("watch update does not contain %q: %s", expected, content)
			}
			return content
		case <-time.After(3 * time.Second):
			t.Fatalf("watch did not publish %q", expected)
			return nil
		}
	}

	// Observe an external edit first so the save cannot precede subscription.
	write(t, root, "site/fragment.json", strings.Replace(fragment, "Fragment initial", "Fragment ready", 1))
	next("Fragment ready")
	authored := `{"language-version":"0.1.0","dashboard":{
		"id":"authored","title":"Authored",
		"queries":[{"name":"authored-runs","from":"canonical-runs","limit":10}],
		"pages":[{"id":"query-preview","title":"Saved view","kind":"custom","views":[
			{"id":"table","title":"Runs","mark":"table","data":{"source":"authored-runs","limit":10}}
		]}]
	}}`
	result, err := w.SaveDashboard(ctx, []byte(authored))
	if err != nil {
		t.Fatal(err)
	}
	saved := obj(result)
	id := text(saved["id"])
	if id == "" {
		t.Fatal("save response has no custom view identity")
	}
	broadcast := next(id)
	response, ok := saved["dashboard"].(json.RawMessage)
	if !ok || string(response) != string(broadcast) {
		t.Fatal("peer update must match the dashboard returned to the saving client")
	}
	write(t, root, "site/fragment.json", strings.Replace(fragment, "Fragment initial", "Fragment external", 1))
	if content := next("Fragment external"); !strings.Contains(string(content), id) {
		t.Fatal("external fragment refresh discarded the saved custom view")
	}
	content, err := w.Refresh()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(content), id) {
		t.Fatal("explicit refresh discarded the saved custom view")
	}
}
