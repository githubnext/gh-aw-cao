package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestGitHubResourceHandlersRejectNonReadMethods(t *testing.T) {
	app := resourceTestApp(t, func(*http.Request) (*http.Response, error) {
		t.Fatal("rejected requests must not reach GitHub")
		return nil, errors.New("unexpected request")
	})
	app.githubResources.localToken = func(context.Context) (string, error) {
		t.Fatal("rejected requests must not resolve credentials")
		return "", errors.New("unexpected credential lookup")
	}
	for _, release := range []bool{false, true} {
		for _, method := range []string{
			http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete,
			http.MethodOptions, http.MethodHead, http.MethodTrace, http.MethodConnect,
		} {
			request := httptest.NewRequestWithContext(t.Context(), method, "/api/v1/github/repos/owner/repo", nil)
			response := httptest.NewRecorder()
			app.gitHubResource(response, request, release)
			if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != http.MethodGet {
				t.Fatalf("method %s release=%t: status=%d allow=%q", method, release, response.Code, response.Header().Get("Allow"))
			}
		}
	}
}

func TestGitHubResourceUpstreamRequestsAreReadOnly(t *testing.T) {
	var paths []string
	app := resourceTestApp(t, func(request *http.Request) (*http.Response, error) {
		if request.Method != http.MethodGet || request.Body != nil {
			t.Fatalf("resource request must be a bodyless GET: %s %s", request.Method, request.URL.Path)
		}
		if version := request.Header.Get("X-GitHub-Api-Version"); version != "2026-03-10" {
			t.Fatalf("unexpected GitHub API version: %q", version)
		}
		paths = append(paths, request.URL.Path)
		if strings.HasSuffix(request.URL.Path, "/releases/latest") {
			return resourceResponse(http.StatusOK, `{"tag_name":"v1","name":null,"html_url":"https://github.com/owner/repo/releases/tag/v1","published_at":null,"draft":false,"prerelease":false}`), nil
		}
		return resourceResponse(http.StatusOK, resourceRepositoryJSON), nil
	})
	for _, path := range []string{"/api/v1/github/repos/owner/repo", "/api/v1/github/repos/owner/repo/releases/latest"} {
		if response := resourceGet(t, app, path, ""); response.Code != http.StatusOK {
			t.Fatalf("read failed: status=%d", response.Code)
		}
	}
	if strings.Join(paths, ",") != "/rate_limit,/repos/owner/repo,/repos/owner/repo/releases/latest" {
		t.Fatalf("unexpected upstream resource paths: %v", paths)
	}
}

func TestGitHubResourceBrowserCookieIsHttpOnlyAndReadOnly(t *testing.T) {
	app := resourceTestApp(t, func(*http.Request) (*http.Response, error) {
		t.Fatal("bootstrap must not request GitHub credentials or data")
		return nil, errors.New("unexpected request")
	})
	app.accessToken = strings.Repeat("local-capability-", 3)
	app.config.SiteDirectory = t.TempDir()
	if err := os.WriteFile(filepath.Join(app.config.SiteDirectory, "index.html"), []byte("<head></head>"), 0o600); err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	app.serveIndex(response, app.accessToken)
	result := response.Result()
	defer func() { _ = result.Body.Close() }()
	cookies := result.Cookies()
	if len(cookies) != 1 {
		t.Fatalf("expected local resource cookie, got %d", len(cookies))
	}
	cookie := cookies[0]
	if cookie.Name != "cao_github_local" || !cookie.HttpOnly || !cookie.Secure ||
		cookie.SameSite != http.SameSiteStrictMode || cookie.Path != "/api/v1/github/" ||
		cookie.Value == app.accessToken {
		t.Fatal("local resource cookie lacks required restrictions")
	}
	for _, test := range []struct {
		method, path string
		allowed      bool
	}{
		{http.MethodGet, "/api/v1/github/repos/owner/repo", true},
		{http.MethodGet, "/api/v1/github/repos/owner/repo/releases/latest", true},
		{http.MethodPost, "/api/v1/github/repos/owner/repo", false},
		{http.MethodGet, "/api/admin/logs", false},
		{http.MethodPost, "/api/v1/refresh", false},
	} {
		request := httptest.NewRequestWithContext(t.Context(), test.method, test.path, nil)
		request.AddCookie(cookie)
		if app.authorized(request) != test.allowed {
			t.Fatalf("cookie authorization mismatch for %s %s", test.method, test.path)
		}
	}
	request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/api/v1/refresh", nil)
	request.Header.Set("Authorization", "Bearer "+cookie.Value)
	if app.authorized(request) {
		t.Fatal("read-only resource cookie must not be usable as a bearer capability")
	}
	app.accessToken = ""
	request = httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/v1/github/repos/owner/repo", nil)
	request.AddCookie(&http.Cookie{
		Name: "cao_github_local", Value: "", Path: "/api/v1/github/",
		HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode,
	})
	if app.authorized(request) {
		t.Fatal("unconfigured local resource session must fail closed")
	}
}

func TestGitHubResourceStorageFailuresFailClosed(t *testing.T) {
	for _, operation := range []string{"missing", "read", "write"} {
		t.Run(operation, func(t *testing.T) {
			app := resourceTestApp(t, func(request *http.Request) (*http.Response, error) {
				if request.URL.Path == "/rate_limit" {
					return resourceResponse(http.StatusOK, `{}`), nil
				}
				return resourceResponse(http.StatusOK, resourceRepositoryJSON), nil
			})
			path := "/api/v1/github/repos/owner/repo"
			if response := resourceGet(t, app, path, ""); response.Code != http.StatusOK {
				t.Fatalf("initial fetch status=%d", response.Code)
			}
			key := githubResourceKey(1, "repos/owner/repo", nil, "test-credential")
			entry, _ := app.githubResources.get(key)
			entry.validated = time.Now().Add(-6 * time.Minute)
			app.githubResources.put(key, entry)
			store := app.githubResources.store.(*resourceTestStore)
			switch operation {
			case "missing":
				app.githubResources.store = nil
			case "read":
				store.readErr = errors.New("private storage diagnostic")
			case "write":
				store.writeErr = errors.New("private storage diagnostic")
			}
			response := resourceGet(t, app, path, "")
			if response.Code != http.StatusServiceUnavailable || response.Header().Get("Warning") != "" ||
				strings.Contains(response.Body.String(), "private storage") {
				t.Fatalf("storage failure not fail-closed: status=%d", response.Code)
			}
		})
	}
}
