package localops

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	copilot "github.com/github/copilot-sdk/go"

	"github.com/githubnext/gh-aw-cao/server/internal/githubquota"
)

func declaredSelector() map[string]any {
	return map[string]any{"label": "Repository", "debounce-ms": 300,
		"query":   map[string]any{"command": "gh search repos", "fields": []any{"fullName", "description"}, "limit": 20},
		"mapping": map[string]any{"value": "fullName", "label": "fullName", "description": "description", "target": "repository"}}
}
func TestSelectorLegacyDeclarationAndArgumentParity(t *testing.T) {
	s := service(t, nil)
	document := fixtureDocument()
	action := actionByID(document, "repository")
	action["selector"] = declaredSelector()
	s.options.Dashboard = func() map[string]any { return document }
	t.Setenv("LOCALOPS_SELECTOR_CAPTURE", "1")
	search := "--help; $(echo untrusted)"
	value := call(t, s, "selector", map[string]any{"id": "repository", "text": search})
	want := []string{"search", "repos", "--limit", "20", "--json", "fullName,description", "--", search}
	raw, err := os.ReadFile(filepath.Join(s.options.Workspace, "selector-argv.json"))
	if err != nil {
		t.Fatal(err)
	}
	var arguments []string
	if err = json.Unmarshal(raw, &arguments); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(arguments, want) || len(array(value["options"])) != 1 {
		t.Fatalf("%v %v", arguments, value)
	}
	for _, change := range []func(map[string]any){
		func(v map[string]any) { mapping(v["query"])["command"] = "gh api" },
		func(v map[string]any) { mapping(v["query"])["fields"] = []any{"fullName", "not-a-field"} },
		func(v map[string]any) { mapping(v["query"])["fields"] = []any{"fullName", "fullName"} },
		func(v map[string]any) { mapping(v["query"])["limit"] = 100 },
		func(v map[string]any) { mapping(v["mapping"])["target"] = "missing" },
		func(v map[string]any) { mapping(v["mapping"])["label"] = "missing" },
		func(v map[string]any) { v["debounce-ms"] = 0 },
		func(v map[string]any) { v["extra"] = true },
	} {
		selector := declaredSelector()
		change(selector)
		action["selector"] = selector
		statusError(t, s.Call(t.Context(), "selector", map[string]any{"id": "repository", "text": "owner"}, nil), 400)
	}
	action["selector"] = declaredSelector()
	for _, raw := range []string{"{}", `[{"fullName":"o/r","description":{}}]`, "[{}]", "not json"} {
		t.Setenv("LOCALOPS_SELECTOR_RESPONSE", raw)
		statusError(t, s.Call(t.Context(), "selector", map[string]any{"id": "repository", "text": "owner"}, nil), 502)
	}
	t.Setenv("LOCALOPS_SELECTOR_RESPONSE", "")
	for _, search := range []string{"x", strings.Repeat("x", 201), "ow\x00ner"} {
		statusError(t, s.Call(t.Context(), "selector", map[string]any{"id": "repository", "text": search}, nil), 400)
	}
	rows := make([]map[string]any, 500)
	for i := range rows {
		rows[i] = map[string]any{"fullName": fmt.Sprintf("owner/repository-%d", i), "description": "Repository"}
	}
	raw, err = json.Marshal(rows[:20])
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("LOCALOPS_SELECTOR_RESPONSE", string(raw))
	if value = call(t, s, "selector", map[string]any{"id": "repository", "text": "repository"}); len(array(value["options"])) != 20 {
		t.Fatal(value)
	}
	raw, err = json.Marshal(rows)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("LOCALOPS_SELECTOR_RESPONSE", string(raw))
	statusError(t, s.Call(t.Context(), "selector", map[string]any{"id": "repository", "text": "repository"}, nil), 502)
	t.Setenv("LOCALOPS_SELECTOR_RESPONSE", "")
	t.Setenv("LOCALOPS_SELECTOR_FAILURE", "1")
	err = s.Call(t.Context(), "selector", map[string]any{"id": "repository", "text": "owner"}, nil)
	statusError(t, err, 502)
	if strings.Contains(err.Error(), "private") {
		t.Fatal("raw authentication diagnostics leaked")
	}
}

func TestCustomViewLegacyDependencyIsolationAndConcurrentSaves(t *testing.T) {
	root := workspace(t)
	document, err := ValidateCustomView([]byte(previewDocument))
	if err != nil {
		t.Fatal(err)
	}
	dashboard := mapping(document["dashboard"])
	dashboard["units"] = map[string]any{"native": map[string]any{"name": "Native count", "symbol": "runs", "significant": 1, "format": "number"}}
	dashboard["card-templates"] = []any{map[string]any{"id": "conclusion", "icon": "workflow", "title": map[string]any{"field": "run-conclusion"}, "labels": []any{}, "details": []any{map[string]any{"field": "runs", "unit": "native"}}}}
	dashboard["queries"] = append(array(dashboard["queries"]), map[string]any{
		"name": "display-counts", "from": "recent", "limit": 10,
		"joins": []any{map[string]any{"source": "recent", "type": "left", "on": []any{map[string]any{"left": "id", "right": "id"}}, "fields": []any{map[string]any{"field": "id", "as": "joined-id"}}}},
	})
	page := mapping(array(dashboard["pages"])[0])
	view := mapping(array(page["views"])[0])
	view["title"] = "Native run labels"
	mapping(view["data"])["source"] = "display-counts"
	mapping(view["encoding"])["y"] = map[string]any{"field": "runs", "unit": "native"}
	page["views"] = append(array(page["views"]), map[string]any{
		"id": "cards", "mark": "list", "title": "Native cards", "data": map[string]any{"source": "display-counts", "limit": 10},
		"encoding":   map[string]any{"columns": []any{map[string]any{"field": "id", "type": "nominal"}}},
		"filter-bar": map[string]any{"filters": []any{map[string]any{"id": "runs", "label": "Runs", "groups": []any{map[string]any{"label": "Runs", "field": "id", "source": "recent", "value-field": "id"}}}}},
		"list":       map[string]any{"style": "entity-cards", "card": "conclusion", "icon": "workflow"},
	})
	page["sections"] = []any{map[string]any{"id": "results", "title": "Results", "layout": "full", "views": []any{"rows", "cards"}}}
	raw, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	saved, err := SaveCustomView(root, raw)
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadCustomViews(root)
	if err != nil || len(loaded) != 1 {
		t.Fatalf("%v %v", loaded, err)
	}
	result := MaterializeCustomView(loaded[0].Document, text(saved["id"]))
	isolated := mapping(result["dashboard"])
	id := text(saved["id"])
	queries := array(isolated["queries"])
	derived := mapping(queries[1])
	if derived["from"] != id+"-recent" || mapping(array(derived["joins"])[0])["source"] != id+"-recent" {
		t.Fatal(queries)
	}
	isolatedPage := mapping(array(isolated["pages"])[0])
	views := array(isolatedPage["views"])
	table, cards := mapping(views[0]), mapping(views[1])
	group := mapping(array(mapping(array(mapping(cards["filter-bar"])["filters"])[0])["groups"])[0])
	if group["source"] != id+"-recent" || mapping(mapping(table["encoding"])["y"])["unit"] != id+"-native" || mapping(cards["list"])["card"] != id+"-conclusion" {
		t.Fatal(isolated)
	}
	if mapping(mapping(table["encoding"])["y"])["field"] != "runs" || table["title"] != "Native run labels" {
		t.Fatal("labels and field names were rewritten")
	}
	if mapping(isolated["units"])[id+"-native"] == nil || !reflect.DeepEqual(mapping(array(isolatedPage["sections"])[0])["views"], []any{id + "-rows", id + "-cards"}) {
		t.Fatal(isolated)
	}
	root2 := workspace(t)
	var wg sync.WaitGroup
	failures := make(chan error, 8)
	ids := make(chan string, 8)
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			saved, e := SaveCustomView(root2, raw)
			if e != nil {
				failures <- e
				return
			}
			ids <- text(saved["id"])
		}()
	}
	wg.Wait()
	close(failures)
	close(ids)
	for e := range failures {
		t.Error(e)
	}
	for value := range ids {
		if value != id {
			t.Fatal(value)
		}
	}
	entries, err := os.ReadDir(filepath.Join(root2, CustomViewsDirectory))
	if err != nil || len(entries) != 1 {
		t.Fatalf("%v %v", entries, err)
	}
	changed := strings.Replace(string(raw), "Native run labels", "Changed labels", 1)
	if err = os.WriteFile(filepath.Join(root, text(saved["path"])), []byte(changed), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = LoadCustomViews(root); err == nil || !strings.Contains(err.Error(), "identity does not match") {
		t.Fatal(err)
	}
	if _, err = SaveCustomView(root, raw); err == nil {
		t.Fatal("corrupted storage accepted another save")
	}
}

var githubRepository = map[string]any{"full_name": "owner/repo", "description": nil, "html_url": "https://github.com/owner/repo", "default_branch": "main", "stargazers_count": 1, "forks_count": 2, "open_issues_count": 3, "archived": false, "visibility": "public"}

func githubReply(t *testing.T, status int, headers http.Header, body any) []byte {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	var reply strings.Builder
	fmt.Fprintf(&reply, "HTTP/2.0 %d Status\r\n", status)
	for key, values := range headers {
		for _, value := range values {
			fmt.Fprintf(&reply, "%s: %s\r\n", key, value)
		}
	}
	reply.WriteString("\r\n")
	if status != 304 {
		reply.Write(raw)
	}
	return []byte(reply.String())
}
func mockGitHub(t *testing.T) (*Service, *time.Time, *atomic.Int64) {
	t.Helper()
	s := service(t, nil)
	clock := time.Date(2026, 10, 18, 0, 0, 0, 0, time.UTC)
	s.github.now = func() time.Time { return clock }
	s.github.readToken = func(context.Context) ([]byte, error) { return []byte("test-credential"), nil }
	requests := &atomic.Int64{}
	s.github.fetch = func(_ context.Context, args []string) ([]byte, error) {
		requests.Add(1)
		if len(args) < 7 || !reflect.DeepEqual(args[:6], []string{"api", "--hostname", "github.com", "--method", "GET", "--include"}) {
			t.Errorf("unsafe GitHub arguments: %v", args)
		}
		return githubReply(t, 200, http.Header{"Etag": []string{`"upstream"`}}, githubRepository), nil
	}
	return s, &clock, requests
}
func TestGitHubLegacyRevalidationCredentialScopeAndPersistence(t *testing.T) {
	s, clock, requests := mockGitHub(t)
	path := "/api/v1/github/repos/Owner/Repo"
	first := call(t, s, "github", map[string]any{"path": path})
	etag := mapping(first["headers"])["ETag"]
	if first["status"] != float64(200) || !strings.Contains(text(mapping(first["headers"])["Cache-Control"]), "max-age=300") {
		t.Fatal(first)
	}
	if value := call(t, s, "github", map[string]any{"path": path, "etag": "W/" + text(etag)}); value["status"] != float64(304) {
		t.Fatal(value)
	}
	*clock = clock.Add(301 * time.Second)
	s.github.fetch = func(_ context.Context, args []string) ([]byte, error) {
		requests.Add(1)
		if !strings.Contains(strings.Join(args, "\n"), "If-None-Match: \"upstream\"") {
			t.Error("upstream ETag missing")
		}
		return githubReply(t, 304, nil, nil), nil
	}
	if value := call(t, s, "github", map[string]any{"path": path, "etag": etag}); value["status"] != float64(304) || mapping(value["headers"])["ETag"] != etag {
		t.Fatal(value)
	}
	if requests.Load() != 2 {
		t.Fatal(requests.Load())
	}
	s.github.readToken = func(context.Context) ([]byte, error) { return []byte("second-credential"), nil }
	s.github.fetch = func(context.Context, []string) ([]byte, error) {
		requests.Add(1)
		return githubReply(t, 200, nil, githubRepository), nil
	}
	call(t, s, "github", map[string]any{"path": path})
	if requests.Load() != 3 {
		t.Fatal("cache crossed credential boundary")
	}
	rows, err := s.github.db.QueryContext(t.Context(), "SELECT id,body FROM github_resources")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var id, body string
		if err = rows.Scan(&id, &body); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(id+body, "credential") {
			t.Fatal("credential persisted")
		}
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	_ = rows.Close()
	options := s.options
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	restarted, err := New(options)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = restarted.Close() }()
	restarted.github.now = func() time.Time { return *clock }
	restarted.github.readToken = func(context.Context) ([]byte, error) { return []byte("second-credential"), nil }
	restarted.github.fetch = func(context.Context, []string) ([]byte, error) {
		t.Error("fresh persisted cache refetched")
		return nil, errors.New("unexpected fetch")
	}
	if value := call(t, restarted, "github", map[string]any{"path": path}); value["status"] != float64(200) {
		t.Fatal(value)
	}
}
func TestGitHubLegacyDeduplicationAndQuietCredentialBackoff(t *testing.T) {
	s, _, requests := mockGitHub(t)
	var tokens atomic.Int64
	gate := make(chan struct{})
	s.github.readToken = func(ctx context.Context) ([]byte, error) {
		tokens.Add(1)
		select {
		case <-gate:
			return []byte("credential"), nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	var wg sync.WaitGroup
	results := make(chan error, 10)
	for range 10 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var result map[string]any
			err := s.Call(context.Background(), "github", map[string]any{"path": "/api/v1/github/repos/owner/repo"}, &result)
			if err == nil && result["status"] != float64(200) {
				err = fmt.Errorf("unexpected result: %v", result)
			}
			results <- err
		}()
	}
	time.Sleep(30 * time.Millisecond)
	close(gate)
	wg.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Error(err)
		}
	}
	if tokens.Load() != 1 || requests.Load() != 1 {
		t.Fatalf("credentials=%d requests=%d", tokens.Load(), requests.Load())
	}
	s.github.readToken = func(context.Context) ([]byte, error) {
		tokens.Add(1)
		return nil, errors.New("private credential diagnostic")
	}
	for range 2 {
		value := call(t, s, "github", map[string]any{"path": "/api/v1/github/repos/owner/other"})
		if value["status"] != float64(503) || strings.Contains(fmt.Sprint(value), "private") {
			t.Fatal(value)
		}
	}
	if tokens.Load() != 2 {
		t.Fatal("missing credentials were not backed off")
	}
}
func TestGitHubLegacyStaleRateLimitAndOversizePreservation(t *testing.T) {
	s, clock, requests := mockGitHub(t)
	path := "/api/v1/github/repos/owner/repo"
	first := call(t, s, "github", map[string]any{"path": path})
	etag := mapping(first["headers"])["ETag"]
	*clock = clock.Add(301 * time.Second)
	s.github.fetch = func(context.Context, []string) ([]byte, error) {
		requests.Add(1)
		return githubReply(t, 429, http.Header{"Retry-After": []string{"120"}}, nil), errors.New("rate limit")
	}
	stale := call(t, s, "github", map[string]any{"path": path, "etag": etag})
	if stale["status"] != float64(200) || mapping(stale["headers"])["Retry-After"] != "120" || !strings.Contains(text(mapping(stale["headers"])["Warning"]), "stale") {
		t.Fatal(stale)
	}
	limited := call(t, s, "github", map[string]any{"path": path + "/releases/latest"})
	if limited["status"] != float64(429) || mapping(limited["headers"])["Retry-After"] != "120" || requests.Load() != 2 {
		t.Fatal(limited, requests.Load())
	}
	*clock = clock.Add(121 * time.Second)
	s.github.fetch = func(context.Context, []string) ([]byte, error) {
		return githubReply(t, 200, http.Header{"Content-Length": []string{"999999999"}}, githubRepository), nil
	}
	stale = call(t, s, "github", map[string]any{"path": path})
	if !reflect.DeepEqual(stale["body"], first["body"]) || mapping(stale["headers"])["Warning"] == nil {
		t.Fatal(stale)
	}
	*clock = clock.Add(31 * time.Second)
	s.github.fetch = func(context.Context, []string) ([]byte, error) { return nil, errors.New("private network failure") }
	stale = call(t, s, "github", map[string]any{"path": path})
	if !reflect.DeepEqual(stale["body"], first["body"]) || strings.Contains(fmt.Sprint(stale), "private network") {
		t.Fatal(stale)
	}
}
func TestGitHubLegacySafeReleaseCompilerAndMalformedFields(t *testing.T) {
	s, clock, _ := mockGitHub(t)
	path := "/api/v1/github/repos/owner/repo"
	release := map[string]any{"tag_name": "v1", "name": nil, "html_url": "https://github.com/o/r/releases/tag/v1", "published_at": nil, "draft": false, "prerelease": false, "assets": []any{"must-not-return"}}
	s.github.fetch = func(context.Context, []string) ([]byte, error) { return githubReply(t, 200, nil, release), nil }
	value := call(t, s, "github", map[string]any{"path": path + "/releases/latest"})
	if value["status"] != float64(200) || mapping(value["body"])["assets"] != nil {
		t.Fatal(value)
	}
	workflow := ".github/workflows/Agent.lock.yml"
	content := map[string]any{"type": "file", "path": workflow, "sha": strings.Repeat("a", 40), "encoding": "base64", "content": base64.StdEncoding.EncodeToString([]byte("# gh-aw-metadata: {\"compiler_version\":\"v0.92.0\"}\nprivate workflow content")), "download_url": "https://untrusted.example/ignored"}
	s.github.fetch = func(_ context.Context, args []string) ([]byte, error) {
		if args[len(args)-1] != "/repos/owner/repo/contents/"+workflow {
			t.Error(args)
		}
		return githubReply(t, 200, nil, content), nil
	}
	value = call(t, s, "github", map[string]any{"path": path + "/contents/" + workflow})
	if value["status"] != float64(200) || mapping(value["body"])["gh_aw_version"] != "v0.92.0" || strings.Contains(fmt.Sprint(value), "private workflow") {
		t.Fatal(value)
	}
	for _, change := range []func(map[string]any){func(v map[string]any) { v["content"] = base64.StdEncoding.EncodeToString([]byte("name: not agentic")) }, func(v map[string]any) { v["path"] = ".github/workflows/unexpected.lock.yml" }, func(v map[string]any) { v["type"] = "symlink" }} {
		raw, err := json.Marshal(content)
		if err != nil {
			t.Fatal(err)
		}
		invalid := map[string]any{}
		if err = json.Unmarshal(raw, &invalid); err != nil {
			t.Fatal(err)
		}
		change(invalid)
		*clock = clock.Add(301 * time.Second)
		s.github.fetch = func(context.Context, []string) ([]byte, error) { return githubReply(t, 200, nil, invalid), nil }
		value = call(t, s, "github", map[string]any{"path": "/api/v1/github/repos/owner/invalid/contents/" + workflow})
		if value["status"] != float64(503) {
			t.Fatal(value)
		}
	}
	*clock = clock.Add(time.Minute)
	s.github.fetch = func(context.Context, []string) ([]byte, error) {
		return githubReply(t, 404, nil, nil), errors.New("not found")
	}
	if value = call(t, s, "github", map[string]any{"path": "/api/v1/github/repos/other/repo/releases/latest"}); value["status"] != float64(404) {
		t.Fatal(value)
	}
	*clock = clock.Add(time.Minute)
	s.github.fetch = func(context.Context, []string) ([]byte, error) {
		raw := map[string]any{}
		for key, v := range githubRepository {
			raw[key] = v
		}
		raw["description"] = map[string]any{"secret": "must-not-return"}
		return githubReply(t, 200, nil, raw), nil
	}
	if value = call(t, s, "github", map[string]any{"path": "/api/v1/github/repos/owner/malformed"}); value["status"] != float64(503) || strings.Contains(fmt.Sprint(value), "must-not-return") {
		t.Fatal(value)
	}
}
func TestGitHubLegacyUnsafePathsOriginAndCacheBounds(t *testing.T) {
	s, clock, requests := mockGitHub(t)
	var authentications atomic.Int64
	s.github.readToken = func(context.Context) ([]byte, error) { authentications.Add(1); return []byte("credential"), nil }
	for _, path := range []string{"/api/v1/github/repos/o/..", "/api/v1/github/repos/o/.", "/api/v1/github/repos/o/r/issues", "/api/v1/github/repos/o/r/contents/.github/workflows/test.yml", "/api/v1/github/repos/o/r/contents/.github/workflows/../secret.lock.yml", "/api/v1/github/repos/o/r/contents/.github/workflows/a%2fb.lock.yml", "/api/v1/github/repos/o/r%2fsecret", "/api/v1/github/repos/o/r?token=anything", "/api/v1/github/repos/o/r#fragment", "/api/v1/github/repos/o/r\\evil", "/api/v1/github/repos/o/r/../../evil", "/api/v1/github/repos/o/r%5cevil", "/api/v1/github/repos/o/r%252fsecret", "/api/v1/github/repos/o/r@evil.example", "/api/v1/github/repos//evil.example/repo", "https://evil.example/api/v1/github/repos/o/r", "//evil.example/api/v1/github/repos/o/r"} {
		if value := call(t, s, "github", map[string]any{"path": path}); value["status"] != float64(400) {
			t.Fatal(path, value)
		}
	}
	if authentications.Load() != 0 || requests.Load() != 0 {
		t.Fatal("unsafe paths used credentials")
	}
	var paths []string
	s.github.fetch = func(_ context.Context, args []string) ([]byte, error) {
		if args[2] != "github.com" || args[4] != "GET" {
			t.Fatal(args)
		}
		paths = append(paths, args[len(args)-1])
		return githubReply(t, 404, nil, nil), errors.New("not found")
	}
	for _, suffix := range []string{"", "/releases/latest"} {
		call(t, s, "github", map[string]any{"path": "/api/v1/github/repos/Owner-1/Repo_name.git" + suffix})
	}
	if !reflect.DeepEqual(paths, []string{"/repos/owner-1/repo_name.git", "/repos/owner-1/repo_name.git/releases/latest"}) {
		t.Fatal(paths)
	}
	s.github.fetch = func(context.Context, []string) ([]byte, error) {
		requests.Add(1)
		return githubReply(t, 200, nil, githubRepository), nil
	}
	for i := range 129 {
		*clock = clock.Add(time.Millisecond)
		call(t, s, "github", map[string]any{"path": fmt.Sprintf("/api/v1/github/repos/owner/repo-%d", i)})
	}
	call(t, s, "github", map[string]any{"path": "/api/v1/github/repos/owner/repo-128"})
	if requests.Load() != 129 {
		t.Fatal(requests.Load())
	}
	call(t, s, "github", map[string]any{"path": "/api/v1/github/repos/owner/repo-0"})
	if requests.Load() != 130 {
		t.Fatal("oldest cache row was not evicted")
	}
	*clock = clock.Add(24*time.Hour + 5*time.Minute + time.Millisecond)
	call(t, s, "github", map[string]any{"path": "/api/v1/github/repos/owner/repo-0"})
	if requests.Load() != 131 {
		t.Fatal("expired cache row was reused")
	}
}

type fakeAuthorClient struct {
	session   AuthoringSession
	createErr error
	stopped   *atomic.Int64
	config    **copilot.SessionConfig
}

func (c *fakeAuthorClient) CreateSession(_ context.Context, config *copilot.SessionConfig) (AuthoringSession, error) {
	if c.config != nil {
		*c.config = config
	}
	return c.session, c.createErr
}
func (c *fakeAuthorClient) Stop() error { c.stopped.Add(1); return nil }

type fakeAuthorSession struct {
	send    func(context.Context, copilot.MessageOptions) (*copilot.SessionEvent, error)
	aborted *atomic.Int64
}

func (s *fakeAuthorSession) SendAndWait(ctx context.Context, options copilot.MessageOptions) (*copilot.SessionEvent, error) {
	return s.send(ctx, options)
}
func (s *fakeAuthorSession) Abort(context.Context) error {
	if s.aborted != nil {
		s.aborted.Add(1)
	}
	return nil
}
func authorReply(content string) *copilot.SessionEvent {
	return &copilot.SessionEvent{Data: &copilot.AssistantMessageData{Content: content}}
}
func TestAuthoringLegacyPureSDKContextAndLifecycle(t *testing.T) {
	s := service(t, func(o *Options) { o.Canvas = true })
	intent := map[string]any{"intent": "Find failing workflows", "subject": "Workflow failures", "acceptance": "Show native failure counts"}
	var options AuthoringClientOptions
	var config *copilot.SessionConfig
	var stopped, aborted atomic.Int64
	session := &fakeAuthorSession{aborted: &aborted, send: func(_ context.Context, message copilot.MessageOptions) (*copilot.SessionEvent, error) {
		raw, _ := json.Marshal(intent)
		if !strings.Contains(message.Prompt, string(raw)) {
			t.Error("intent missing from prompt")
		}
		return authorReply(previewDocument), nil
	}}
	s.options.NewAuthoringClient = func(value AuthoringClientOptions) AuthoringClient {
		options = value
		return &fakeAuthorClient{session: session, stopped: &stopped, config: &config}
	}
	call(t, s, "query.generate", intent)
	if options.Mode != copilot.ModeEmpty || config.EnableConfigDiscovery == nil || *config.EnableConfigDiscovery || config.AvailableTools == nil || len(config.AvailableTools) != 0 || len(config.Tools) != 0 || len(config.MCPServers) != 0 || len(config.CustomAgents) != 0 || len(config.SkillDirectories) != 0 {
		t.Fatal("SDK sandbox not empty")
	}
	for _, fragment := range []string{"# Generate Dashboard IR", "Dashboard Language Specification", "# Declarative charts", "# Dashboard Authoring", "512", "time-unit"} {
		if !strings.Contains(config.SystemMessage.Content, fragment) {
			t.Errorf("missing trusted context %q", fragment)
		}
	}
	if config.SystemMessage.Mode != "append" || stopped.Load() != 1 {
		t.Fatal(config, stopped.Load())
	}
	if _, err := os.Stat(options.BaseDirectory); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("authoring directory retained: %v", err)
	}
	session.send = func(context.Context, copilot.MessageOptions) (*copilot.SessionEvent, error) {
		return authorReply(`{"intent":"Find failures","subject":"Runs","objective":"Investigate","acceptance":"Evidence"}`), nil
	}
	call(t, s, "query.enhance", map[string]any{"intent": "Find failures"})
	if !strings.Contains(config.SystemMessage.Content, "# Author dashboard intent") || stopped.Load() != 2 {
		t.Fatal("intent authoring did not use trusted skill")
	}
	for _, payload := range []any{nil, []any{}, map[string]any{}, map[string]any{"intent": " ", "subject": "Runs", "acceptance": "Evidence"}, map[string]any{"intent": "Runs", "subject": strings.Repeat("x", 2001), "acceptance": "Evidence"}, map[string]any{"intent": "Runs", "subject": "Runs", "acceptance": "Evidence", "tools": []any{"shell"}}} {
		statusError(t, s.Call(t.Context(), "query.generate", payload, nil), 400)
	}
}
func TestAuthoringLegacyUnicodeBudgetsCancellationAndErrors(t *testing.T) {
	boundary := map[string]any{"intent": "Detailed context", "subject": strings.Repeat("😀", 170), "objective": strings.Repeat("b", 170), "acceptance": strings.Repeat("c", 172)}
	if err := validateAuthoring(boundary, false, false); err != nil {
		t.Fatal(err)
	}
	if err := validateAuthoring(boundary, true, true); err != nil {
		t.Fatal(err)
	}
	boundary["acceptance"] = text(boundary["acceptance"]) + "d"
	if validateAuthoring(boundary, false, false) == nil || validateAuthoring(boundary, true, true) == nil {
		t.Fatal("combined Unicode budget not enforced")
	}
	if err := validateAuthoring(boundary, true, false); err != nil {
		t.Fatal("over-budget input cannot be condensed", err)
	}
	s := service(t, func(o *Options) { o.Canvas = true })
	var stopped, aborted atomic.Int64
	session := &fakeAuthorSession{aborted: &aborted, send: func(context.Context, copilot.MessageOptions) (*copilot.SessionEvent, error) {
		raw, _ := json.Marshal(boundary)
		return authorReply(string(raw)), nil
	}}
	s.options.NewAuthoringClient = func(AuthoringClientOptions) AuthoringClient {
		return &fakeAuthorClient{session: session, stopped: &stopped}
	}
	statusError(t, s.Call(t.Context(), "query.enhance", map[string]any{"intent": "Condense"}, nil), 503)
	ctx, cancel := context.WithCancel(t.Context())
	session.send = func(context.Context, copilot.MessageOptions) (*copilot.SessionEvent, error) {
		cancel()
		return authorReply(previewDocument), nil
	}
	statusError(t, s.Call(ctx, "query.generate", map[string]any{"intent": "Runs", "subject": "Runs", "acceptance": "Evidence"}, nil), 408)
	if aborted.Load() != 1 || stopped.Load() != 2 {
		t.Fatalf("aborted=%d stopped=%d", aborted.Load(), stopped.Load())
	}
	s.options.NewAuthoringClient = func(AuthoringClientOptions) AuthoringClient {
		return &fakeAuthorClient{createErr: errors.New("private SDK failure"), stopped: &stopped}
	}
	statusError(t, s.Call(t.Context(), "query.enhance", map[string]any{"intent": "Runs"}, nil), 503)
	if stopped.Load() != 3 {
		t.Fatal("failed SDK session was not stopped")
	}
	for _, send := range []func(context.Context, copilot.MessageOptions) (*copilot.SessionEvent, error){
		func(context.Context, copilot.MessageOptions) (*copilot.SessionEvent, error) {
			return nil, errors.New("private send error")
		},
		func(context.Context, copilot.MessageOptions) (*copilot.SessionEvent, error) { return nil, nil }, //nolint:nilnil // Deliberately simulate the SDK returning no assistant message.
		func(context.Context, copilot.MessageOptions) (*copilot.SessionEvent, error) {
			return authorReply(strings.Repeat("x", 131073)), nil
		},
		func(context.Context, copilot.MessageOptions) (*copilot.SessionEvent, error) {
			return authorReply("not json"), nil
		},
	} {
		session.send = send
		s.options.NewAuthoringClient = func(AuthoringClientOptions) AuthoringClient {
			return &fakeAuthorClient{session: session, stopped: &stopped}
		}
		statusError(t, s.Call(t.Context(), "query.enhance", map[string]any{"intent": "Runs"}, nil), 503)
	}
	if stopped.Load() != 7 {
		t.Fatal("failed SDK sends were not stopped")
	}
	entries, err := os.ReadDir(filepath.Join(s.options.Workspace, ".cao", "authoring"))
	if err != nil || len(entries) != 0 {
		t.Fatalf("failed SDK requests retained working directories: %v %v", entries, err)
	}
}

func TestQuotaLegacyReservationReconciliationAndResources(t *testing.T) {
	q, err := newNativeQuota(Options{MaxConcurrency: 4})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = q.store.Close() }()
	remaining := map[string]int{"core": 5000, "graphql": 5000}
	reset := time.Now().Add(time.Hour)
	fail := false
	q.read = func(_ context.Context, resources []string) (quotaSnapshot, error) {
		if fail {
			return quotaSnapshot{}, errors.New("private quota failure")
		}
		value := quotaSnapshot{"gh-test", map[string]githubquota.Observation{}}
		for _, resource := range resources {
			value.observations[resource] = githubquota.Observation{Limit: 5000, Remaining: remaining[resource], ResetAt: reset}
		}
		return value, nil
	}
	invocation := Invocation{Command: "gh aw update"}
	if capacity, _ := q.admit(t.Context(), 1, invocation, 0); capacity != 4 {
		t.Fatal(capacity)
	}
	if len(q.reservations[1].buckets) != 2 {
		t.Fatal("non-dispatch did not reserve both meters")
	}
	remaining["core"], remaining["graphql"] = 175, 175
	if err = q.complete(t.Context(), 1); err != nil {
		t.Fatal(err)
	}
	if len(q.reservations) != 0 {
		t.Fatal("completion did not reconcile reservations")
	}
	if capacity, _ := q.admit(t.Context(), 2, invocation, 0); capacity != 1 {
		t.Fatal(capacity)
	}
	if capacity, _ := q.admit(t.Context(), 3, invocation, 0); capacity != 0 {
		t.Fatal(capacity)
	}
	if err = q.release(t.Context(), 2); err != nil {
		t.Fatal(err)
	}
	if err = q.release(t.Context(), 2); err != nil {
		t.Fatal(err)
	}
	if err = q.complete(t.Context(), 2); err != nil {
		t.Fatal(err)
	}
	remaining["graphql"] = 0
	if capacity, _ := q.admit(t.Context(), 4, invocation, 0); capacity != 0 {
		t.Fatal("GraphQL exhaustion bypassed")
	}
	if capacity, _ := q.admit(t.Context(), 5, Invocation{Command: "gh workflow run activity"}, 0); capacity != 1 {
		t.Fatal(capacity)
	}
	fail = true
	if err = q.complete(t.Context(), 5); err == nil || q.reservations[5] == nil {
		t.Fatal("failed refresh released completed work")
	}
	fail = false
	remaining["core"] = 0
	if capacity, _ := q.admit(t.Context(), 6, Invocation{Command: "gh workflow run activity"}, 0); capacity != 0 {
		t.Fatal(capacity)
	}
	if q.reservations[5] != nil {
		t.Fatal("fresh observation did not reconcile prior finished work")
	}
	for _, command := range []string{"gh aw compile", "gh aw compile --strict --no-check-update", "gh aw --help"} {
		if !localQuotaBypass(command) {
			t.Fatal(command)
		}
	}
	for _, command := range []string{"gh aw update", "./cao.sh update", "gh workflow run activity", "gh agent-task create --from-file -", "gh aw compile --repo owner/repo", "gh aw compile -Rowner/repo", "gh aw compile --check-update"} {
		if localQuotaBypass(command) {
			t.Fatal(command)
		}
	}
	if !reflect.DeepEqual(quotaResources("gh workflow run activity"), []string{"core"}) {
		t.Fatal("dispatch resources not narrowed")
	}
	for _, command := range []string{"gh aw update", "./cao.sh update", "gh agent-task create --from-file -"} {
		if !reflect.DeepEqual(quotaResources(command), []string{"core", "graphql"}) {
			t.Fatal(command)
		}
	}
}
func TestQuotaLegacySplitLimitsUnknownAndLazyOfflineCommands(t *testing.T) {
	observer := &rateLimitObserver{}
	observer.write("stderr", "Sensitive output: secondary rate lim")
	observer.write("stderr", "it\nRetry-Af")
	observer.write("stderr", "ter: 120\n")
	if !observer.limited || observer.retryAfter != 120 {
		t.Fatal(observer)
	}

	for _, text := range []string{"GitHub: secondary rate limit\nRetry-After: 123\nsecret", "HTTP 429: Too Many Requests", "HTTP 403: Resource not accessible"} {
		limited, seconds := detectRateLimit(text)
		if strings.Contains(text, "403") {
			if limited || seconds != 0 {
				t.Fatal(limited, seconds)
			}
		} else if !limited {
			t.Fatal(text)
		}
	}
	q, err := newNativeQuota(Options{MaxConcurrency: 4})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = q.store.Close() }()
	var reads int
	q.read = func(context.Context, []string) (quotaSnapshot, error) {
		reads++
		return quotaSnapshot{}, errors.New("private raw error")
	}
	if capacity, _ := q.admit(t.Context(), 1, Invocation{Command: "gh aw compile"}, 0); capacity != 4 || reads != 0 {
		t.Fatal(capacity, reads)
	}
	if capacity, reason := q.admit(t.Context(), 2, Invocation{Command: "gh aw update"}, 0); capacity != 0 || strings.Contains(reason, "private") {
		t.Fatal(capacity, reason)
	}
	if capacity, _ := q.admit(t.Context(), 3, Invocation{Command: "gh aw compile"}, 0); capacity != 4 {
		t.Fatal("broken observation paused offline work")
	}
	if capacity, _ := q.admit(t.Context(), 4, Invocation{Command: "gh aw update"}, 4); capacity != 0 {
		t.Fatal("concurrency bound bypassed")
	}
	q.park(t.Context(), observer.retryAfter)
	if capacity, _ := q.admit(t.Context(), 5, Invocation{Command: "gh aw update"}, 0); capacity != 0 {
		t.Fatal("secondary limit did not park starts")
	}
	if duration := time.Until(q.parkedUntil); duration < 119*time.Second || duration > 121*time.Second {
		t.Fatal(duration)
	}
	for _, concurrency := range []int{-1, 33} {
		options := Options{Workspace: workspace(t), MaxConcurrency: concurrency}
		if _, err := New(options); err == nil {
			t.Fatal("invalid concurrency accepted", concurrency)
		}
	}
}

func TestQuotaLegacyNativeHostContextMalformedSnapshotsAndShutdown(t *testing.T) {
	s := service(t, nil)
	t.Setenv("GH_HOST", "quota.example.test")
	t.Setenv("GH_REPO", "owner/repo")
	t.Setenv("LOCALOPS_EXPECT_DIRECTORY", s.options.Workspace)
	q, err := newNativeQuota(s.options)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = q.store.Close() }()
	if capacity, _ := q.admit(t.Context(), 1, Invocation{Command: "gh aw update"}, 0); capacity != 4 {
		t.Fatal("native gh did not inherit requested host/directory", capacity)
	}
	if err = q.release(t.Context(), 1); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{"not JSON", "{}", `{"resources":{"core":{"limit":5000,"remaining":-1,"reset":9999999999},"graphql":{"limit":5000,"remaining":5000,"reset":9999999999}}}`} {
		t.Setenv("LOCALOPS_QUOTA_RESPONSE", raw)
		if capacity, reason := q.admit(t.Context(), 2, Invocation{Command: "gh aw update"}, 0); capacity != 0 || strings.Contains(reason, raw) {
			t.Fatal(capacity, reason)
		}
	}
	t.Setenv("LOCALOPS_QUOTA_RESPONSE", "")
	t.Setenv("LOCALOPS_QUOTA_BADUSER", "1")
	if capacity, _ := q.admit(t.Context(), 3, Invocation{Command: "gh aw update"}, 0); capacity != 0 {
		t.Fatal("invalid credential identity accepted")
	}
	t.Setenv("LOCALOPS_QUOTA_BADUSER", "")
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if capacity, _ := q.admit(ctx, 4, Invocation{Command: "gh aw update"}, 0); capacity != 0 {
		t.Fatal("canceled observation allowed a start")
	}
	if err = q.store.Close(); err != nil {
		t.Fatal(err)
	}
	if capacity, _ := q.admit(t.Context(), 5, Invocation{Command: "gh aw update"}, 0); capacity != 0 {
		t.Fatal("closed quota engine allowed a start")
	}
	started := make(chan struct{})
	s.queue.admission.read = func(ctx context.Context, _ []string) (quotaSnapshot, error) {
		close(started)
		<-ctx.Done()
		return quotaSnapshot{}, ctx.Err()
	}
	enqueue(t, s, "complete")
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("queue did not request admission")
	}
	closed := make(chan error, 1)
	go func() { closed <- s.Close() }()
	select {
	case err = <-closed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("queue shutdown did not cancel outstanding quota observation")
	}
}

func TestQuotaFailedStartReleasesReservations(t *testing.T) {
	s := service(t, nil)
	s.queue.options.GHExecutable = filepath.Join(s.options.Workspace, "missing-gh")
	s.queue.admission.read = func(_ context.Context, resources []string) (quotaSnapshot, error) {
		snapshot := quotaSnapshot{"test-identity", map[string]githubquota.Observation{}}
		for _, resource := range resources {
			snapshot.observations[resource] = githubquota.Observation{Limit: 5000, Remaining: 5000, ResetAt: time.Now().Add(time.Hour)}
		}
		return snapshot, nil
	}
	value := enqueue(t, s, "complete")
	waitJob(t, s, value["id"], "failed")
	s.queue.admission.mu.Lock()
	defer s.queue.admission.mu.Unlock()
	if len(s.queue.admission.reservations) != 0 {
		t.Fatal("failed process start retained a quota reservation")
	}
}
