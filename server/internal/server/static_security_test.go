package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStaticFilesStayInsideSiteRoot(t *testing.T) {
	site := t.TempDir()
	outside := t.TempDir()
	for name, content := range map[string]string{
		filepath.Join(site, "index.html"):   "<head></head><body>dashboard</body>",
		filepath.Join(site, "app.js"):       "export default 1;",
		filepath.Join(outside, "secret.js"): "private-file-content",
	} {
		if err := os.WriteFile(name, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	for name, target := range map[string]string{
		"escaped.js": filepath.Join(outside, "secret.js"),
		"outside":    outside,
		"alias.js":   "app.js",
	} {
		if err := os.Symlink(target, filepath.Join(site, name)); err != nil {
			t.Fatal(err)
		}
	}
	app := &App{config: Config{SiteDirectory: site}}
	for _, test := range []struct {
		path   string
		status int
		body   string
	}{
		{"/", http.StatusOK, "dashboard"},
		{"/index.html", http.StatusOK, "dashboard"},
		{"/missing-route", http.StatusOK, "dashboard"},
		{"/app.js", http.StatusOK, "export default 1;"},
		{"/alias.js", http.StatusOK, "export default 1;"},
		{"/../secret.js", http.StatusNotFound, ""},
		{"/%2e%2e/secret.js", http.StatusNotFound, ""},
		{"//" + strings.TrimPrefix(filepath.Join(outside, "secret.js"), "/"), http.StatusNotFound, ""},
		{"/escaped.js", http.StatusNotFound, ""},
		{"/outside/secret.js", http.StatusNotFound, ""},
		{"/api/missing", http.StatusNotFound, ""},
		{"/mcp", http.StatusNotFound, ""},
	} {
		t.Run(test.path, func(t *testing.T) {
			response := httptest.NewRecorder()
			app.static(response, httptest.NewRequestWithContext(t.Context(), http.MethodGet, test.path, nil))
			if response.Code != test.status {
				t.Fatalf("status = %d, want %d", response.Code, test.status)
			}
			if strings.Contains(response.Body.String(), "private-file-content") {
				t.Fatal("static handler exposed a file outside the site root")
			}
			if test.body != "" && !strings.Contains(response.Body.String(), test.body) {
				t.Fatal("static handler did not serve the expected content")
			}
		})
	}

	response := httptest.NewRecorder()
	request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/app.js", nil)
	request.Header.Set("Range", "bytes=0-5")
	app.static(response, request)
	if response.Code != http.StatusPartialContent || response.Body.String() != "export" {
		t.Fatal("static handler did not preserve byte-range serving")
	}
	response = httptest.NewRecorder()
	app.static(response, httptest.NewRequestWithContext(t.Context(), http.MethodHead, "/app.js", nil))
	if response.Code != http.StatusOK || response.Body.Len() != 0 {
		t.Fatal("static handler did not preserve HEAD serving")
	}
}

func TestServeIndexRejectsEscapingSymlink(t *testing.T) {
	site := t.TempDir()
	outside := filepath.Join(t.TempDir(), "private.html")
	if err := os.WriteFile(outside, []byte("private-file-content"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(site, "index.html")); err != nil {
		t.Fatal(err)
	}
	app := &App{config: Config{SiteDirectory: site}}
	response := httptest.NewRecorder()
	app.serveIndex(response, "")
	if response.Code != http.StatusNotFound || strings.Contains(response.Body.String(), "private-file-content") {
		t.Fatal("index handler followed a symlink outside the site root")
	}
}

func TestServeIndexEscapesAccessTokenInJavaScriptContext(t *testing.T) {
	site := t.TempDir()
	if err := os.WriteFile(filepath.Join(site, "index.html"), []byte("<head></head>"), 0o600); err != nil {
		t.Fatal(err)
	}
	app := &App{config: Config{SiteDirectory: site}, accessToken: testAccessToken}
	for _, token := range []string{
		testAccessToken,
		`");alert(1);//`,
		`</script><script>alert(1)</script>`,
		`<!--<img src=x onerror=alert(1)>-->`,
		"quote\"backslash\\newline\nseparator\u2028\u2029",
	} {
		response := httptest.NewRecorder()
		app.serveIndex(response, token)
		if response.Code != http.StatusOK {
			t.Fatal("index bootstrap failed")
		}
		body := response.Body.String()
		if strings.Count(body, "<script>") != 1 || strings.Count(body, "</script>") != 1 ||
			strings.Contains(body, "<img") {
			t.Fatal("access token escaped its script context")
		}
		_, argument, found := strings.Cut(body, `localStorage.setItem("cao-dashboard-access-token",`)
		if !found {
			t.Fatal("access token bootstrap is missing")
		}
		var decoded string
		if err := json.NewDecoder(strings.NewReader(argument)).Decode(&decoded); err != nil {
			t.Fatal("access token is not encoded as a JavaScript-compatible JSON string")
		}
		if decoded != token {
			t.Fatal("access token did not round-trip through the bootstrap")
		}
	}
}
