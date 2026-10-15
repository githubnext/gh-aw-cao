package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/collect"
	"github.com/githubnext/gh-aw-cao/server/internal/githubapp"
	"github.com/githubnext/gh-aw-cao/server/internal/githubquota"
	"github.com/githubnext/gh-aw-cao/server/internal/operational/memory"
)

type resourceRoundTripper func(*http.Request) (*http.Response, error)

func (f resourceRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

const resourceRepositoryJSON = `{"full_name":"owner/repo","description":null,"html_url":"https://github.com/owner/repo","default_branch":"main","stargazers_count":42,"forks_count":3,"open_issues_count":2,"archived":false,"visibility":"public","secret":"never","owner":{"email":"private"}}`

func resourceResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: http.Header{
		"X-Ratelimit-Limit":     {"5000"},
		"X-Ratelimit-Remaining": {"4999"},
		"X-Ratelimit-Reset":     {strconv.FormatInt(time.Now().Add(time.Hour).Unix(), 10)},
	}, Body: io.NopCloser(strings.NewReader(body))}
}

func resourceTestApp(t *testing.T, transport resourceRoundTripper) *App {
	t.Helper()
	store, err := memory.New(memory.Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	quota, err := githubquota.New(store, githubquota.Options{})
	if err != nil {
		t.Fatal(err)
	}
	return &App{
		config: Config{HostProfile: localHostProfile(), ActionsRepository: "owner/repo"},
		quota:  quota,
		githubResources: githubResourceCache{
			localToken: func(context.Context) (string, error) { return "test-credential", nil },
			transport:  transport,
		},
	}
}

func resourceMux(app *App) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/github/repos/{owner}/{repo}", app.gitHubRepositoryResource)
	mux.HandleFunc("GET /api/v1/github/repos/{owner}/{repo}/releases/latest", app.gitHubReleaseResource)
	return mux
}

func resourceGet(t *testing.T, app *App, path, etag string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, path, nil)
	request.Header.Set("If-None-Match", etag)
	response := httptest.NewRecorder()
	resourceMux(app).ServeHTTP(response, request)
	return response
}

func TestGitHubResourceNormalization(t *testing.T) {
	for _, test := range []struct {
		name    string
		body    string
		release bool
		fields  int
	}{
		{"repository", resourceRepositoryJSON, false, 9},
		{"release", `{"tag_name":"v1","name":null,"html_url":"https://github.com/owner/repo/releases/tag/v1","published_at":null,"draft":false,"prerelease":true,"body":"private release notes","assets":[]}`, true, 6},
	} {
		t.Run(test.name, func(t *testing.T) {
			body, err := normalizeGitHubResource([]byte(test.body), test.release)
			if err != nil {
				t.Fatal(err)
			}
			var value map[string]any
			if err := json.Unmarshal(body, &value); err != nil {
				t.Fatal(err)
			}
			if len(value) != test.fields || strings.Contains(string(body), "private") || strings.Contains(string(body), "never") {
				t.Fatalf("unexpected normalized body: %s", body)
			}
			nullable := "description"
			if test.release {
				nullable = "name"
			}
			if field, exists := value[nullable]; !exists || field != nil {
				t.Fatalf("nullable field lost: %s", body)
			}
		})
	}
	for _, body := range []string{`null`, `{}`, `[]`, `{"full_name":4}`, `{"tag_name":"v1","html_url":false}`} {
		for _, release := range []bool{false, true} {
			if _, err := normalizeGitHubResource([]byte(body), release); err == nil {
				t.Fatalf("accepted invalid JSON %s", body)
			}
		}
	}
}

func TestGitHubResourceConditionalCaching(t *testing.T) {
	var reads atomic.Int64
	app := resourceTestApp(t, func(request *http.Request) (*http.Response, error) {
		if request.URL.Host != "api.github.com" || request.Header.Get("Authorization") != "Bearer "+"test-credential" {
			t.Error("unexpected destination or credential")
		}
		if request.URL.Path == "/rate_limit" {
			return resourceResponse(http.StatusOK, `{}`), nil
		}
		count := reads.Add(1)
		if count > 1 {
			if request.Header.Get("If-None-Match") != `"upstream"` {
				t.Error("upstream conditional header was not retained")
			}
			return resourceResponse(http.StatusNotModified, ""), nil
		}
		response := resourceResponse(http.StatusOK, resourceRepositoryJSON)
		response.Header.Set("ETag", `"upstream"`)
		return response, nil
	})
	path := "/api/v1/github/repos/owner/repo"
	first := resourceGet(t, app, path, "")
	if first.Code != http.StatusOK || first.Header().Get("ETag") == "" || first.Header().Get("ETag") == `"upstream"` {
		t.Fatalf("unexpected first response: %d %s", first.Code, first.Body.String())
	}
	if first.Header().Get("Cache-Control") != "private, max-age=300, stale-while-revalidate=86400" {
		t.Fatal("missing private cache policy")
	}
	second := resourceGet(t, app, path, `"other", W/`+first.Header().Get("ETag"))
	if second.Code != http.StatusNotModified || second.Body.Len() != 0 || reads.Load() != 1 {
		t.Fatalf("client conditional caching failed: %d reads=%d", second.Code, reads.Load())
	}
	key := githubResourceKey(1, "repos/owner/repo", nil, "test-credential")
	cached, _ := app.githubResources.get(key)
	cached.validated = time.Now().Add(-6 * time.Minute)
	app.githubResources.put(key, cached)
	third := resourceGet(t, app, path, first.Header().Get("ETag"))
	if third.Code != http.StatusNotModified || reads.Load() != 2 {
		t.Fatalf("upstream 304 failed: %d reads=%d", third.Code, reads.Load())
	}
	fourth := resourceGet(t, app, path, "")
	if fourth.Code != http.StatusOK || fourth.Body.String() != first.Body.String() || reads.Load() != 2 {
		t.Fatal("304 did not retain normalized payload")
	}
}

func TestGitHubResourceAbsentCredentialsAndHostedFailClosed(t *testing.T) {
	var calls atomic.Int64
	app := resourceTestApp(t, func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		return resourceResponse(http.StatusOK, resourceRepositoryJSON), nil
	})
	app.githubResources.localToken = func(context.Context) (string, error) { return "", errors.New("not logged in") }
	if response := resourceGet(t, app, "/api/v1/github/repos/owner/repo", ""); response.Code != http.StatusServiceUnavailable || response.Header().Get("Retry-After") == "" {
		t.Fatalf("missing credentials status = %d", response.Code)
	}
	app.config.HostProfile = hostedHostProfile()
	app.githubResources.localToken = func(context.Context) (string, error) {
		t.Fatal("hosted mode attempted local CLI credentials")
		return "", nil
	}
	if response := resourceGet(t, app, "/api/v1/github/repos/owner/repo", ""); response.Code != http.StatusServiceUnavailable {
		t.Fatalf("unconfigured hosted status = %d", response.Code)
	}
	if calls.Load() != 0 {
		t.Fatal("unconfigured credentials reached upstream")
	}
}

func TestGitHubResourceInputAndScope(t *testing.T) {
	app := resourceTestApp(t, func(*http.Request) (*http.Response, error) {
		t.Fatal("invalid or out-of-scope request reached upstream")
		return nil, errors.New("unexpected upstream request")
	})
	for _, test := range []struct {
		path   string
		status int
	}{
		{"/api/v1/github/repos/other/repo", http.StatusForbidden},
		{"/api/v1/github/repos/owner/repo?url=https://evil.example", http.StatusBadRequest},
		{"/api/v1/github/repos/owner/repo%2fextra", http.StatusBadRequest},
		{"/api/v1/github/repos/owner/%2e%2e", http.StatusBadRequest},
		{"/api/v1/github/repos/owner/r%40po", http.StatusBadRequest},
	} {
		if response := resourceGet(t, app, test.path, ""); response.Code != test.status {
			t.Errorf("%s: got %d, want %d", test.path, response.Code, test.status)
		}
	}
}

func TestGitHubResourceHostedEnrollmentScope(t *testing.T) {
	store, err := memory.New(memory.Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	enrollment := collect.Enrollment{Metadata: store, Leases: store}
	if err := enrollment.AddRepositories(t.Context(), 42, []string{"owner/repo"}); err != nil {
		t.Fatal(err)
	}
	app := &App{config: Config{HostProfile: hostedHostProfile(), Collector: &CollectorConfig{AppID: 7}},
		reconciler: &Collector{client: &githubapp.Client{}, enrollment: enrollment}}
	if installation, err := app.githubResourceScope(t.Context(), "owner/repo"); err != nil || installation != 42 {
		t.Fatalf("enrolled scope: installation=%d err=%v", installation, err)
	}
	if _, err := app.githubResourceScope(t.Context(), "other/repo"); err == nil {
		t.Fatal("hosted scope widened beyond enrollment")
	}
}

func TestGitHubResourceDeduplicatesConcurrentReads(t *testing.T) {
	var reads atomic.Int64
	started, release := make(chan struct{}), make(chan struct{})
	app := resourceTestApp(t, func(request *http.Request) (*http.Response, error) {
		if request.URL.Path == "/rate_limit" {
			return resourceResponse(http.StatusOK, `{}`), nil
		}
		if reads.Add(1) == 1 {
			close(started)
		}
		<-release
		return resourceResponse(http.StatusOK, resourceRepositoryJSON), nil
	})
	var wg sync.WaitGroup
	results := make(chan int, 20)
	for range 20 {
		wg.Go(func() {
			response := resourceGet(t, app, "/api/v1/github/repos/owner/repo", "")
			results <- response.Code
		})
	}
	<-started
	close(release)
	wg.Wait()
	close(results)
	for status := range results {
		if status != http.StatusOK {
			t.Errorf("concurrent request status=%d", status)
		}
	}
	if reads.Load() != 1 {
		t.Fatalf("got %d upstream resource reads, want 1", reads.Load())
	}
}

func TestGitHubResourceRateLimitPreservesStale(t *testing.T) {
	var reads atomic.Int64
	app := resourceTestApp(t, func(request *http.Request) (*http.Response, error) {
		if request.URL.Path == "/rate_limit" {
			return resourceResponse(http.StatusOK, `{}`), nil
		}
		if reads.Add(1) == 1 {
			return resourceResponse(http.StatusOK, resourceRepositoryJSON), nil
		}
		response := resourceResponse(http.StatusTooManyRequests, `{"message":"secret diagnostic"}`)
		response.Header.Set("Retry-After", "120")
		return response, nil
	})
	path, key := "/api/v1/github/repos/owner/repo", githubResourceKey(1, "repos/owner/repo", nil, "test-credential")
	first := resourceGet(t, app, path, "")
	cached, _ := app.githubResources.get(key)
	cached.validated = time.Now().Add(-6 * time.Minute)
	app.githubResources.put(key, cached)
	for range 2 {
		response := resourceGet(t, app, path, "")
		if response.Code != http.StatusTooManyRequests || response.Header().Get("Retry-After") == "" ||
			strings.Contains(response.Body.String(), "secret") {
			t.Fatalf("rate limit response: %d %s", response.Code, response.Body.String())
		}
	}
	retained, found := app.githubResources.get(key)
	if !found || string(retained.body) != first.Body.String() || reads.Load() != 2 {
		t.Fatalf("stale payload lost or parked bucket ignored: found=%t reads=%d", found, reads.Load())
	}
	state, err := app.quota.State(t.Context(), githubquota.BucketID{App: "local-cli", Installation: 1})
	if err != nil || state.Reserved != 0 {
		t.Fatalf("reservation leaked: %+v %v", state, err)
	}
}

func TestGitHubResourceColdQuotaRateLimits(t *testing.T) {
	for _, status := range []int{http.StatusForbidden, http.StatusTooManyRequests} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			var calls atomic.Int64
			app := resourceTestApp(t, func(request *http.Request) (*http.Response, error) {
				calls.Add(1)
				if request.URL.Path != "/rate_limit" {
					t.Error("resource fetched despite unavailable quota")
				}
				response := resourceResponse(status, `{}`)
				response.Header.Set("X-RateLimit-Remaining", "0")
				if status == http.StatusTooManyRequests {
					response.Header.Set("Retry-After", "60")
				}
				return response, nil
			})
			for range 2 {
				response := resourceGet(t, app, "/api/v1/github/repos/owner/repo", "")
				if response.Code != http.StatusTooManyRequests || response.Header().Get("Retry-After") == "" {
					t.Fatalf("cold quota response: %d %s", response.Code, response.Body.String())
				}
			}
			if calls.Load() != 1 {
				t.Fatalf("cold quota limit was not retained: %d calls", calls.Load())
			}
		})
	}
}

func TestGitHubResourceErrorKeepsPreviousPayload(t *testing.T) {
	var reads atomic.Int64
	app := resourceTestApp(t, func(request *http.Request) (*http.Response, error) {
		if request.URL.Path == "/rate_limit" {
			return resourceResponse(http.StatusOK, `{}`), nil
		}
		if reads.Add(1) == 1 {
			return resourceResponse(http.StatusOK, resourceRepositoryJSON), nil
		}
		return resourceResponse(http.StatusOK, `{"full_name":null}`), nil
	})
	key := githubResourceKey(1, "repos/owner/repo", nil, "test-credential")
	first := resourceGet(t, app, "/api/v1/github/repos/owner/repo", "")
	cached, _ := app.githubResources.get(key)
	cached.validated = time.Now().Add(-6 * time.Minute)
	app.githubResources.put(key, cached)
	response := resourceGet(t, app, "/api/v1/github/repos/owner/repo", "")
	if response.Code != http.StatusOK || response.Header().Get("Warning") != `110 - "Response is stale"` ||
		response.Header().Get("Cache-Control") != "private, max-age=0, stale-while-revalidate=86400" ||
		response.Body.String() != first.Body.String() {
		t.Fatalf("malformed upstream status=%d", response.Code)
	}
	retained, found := app.githubResources.get(key)
	if !found || string(retained.body) != first.Body.String() || !retained.validated.Equal(cached.validated) {
		t.Fatal("failed revalidation replaced or refreshed stale data")
	}
	app.config.ActionsRepository = "different/repo"
	if response := resourceGet(t, app, "/api/v1/github/repos/owner/repo", ""); response.Code != http.StatusForbidden {
		t.Fatal("cache bypassed repository scope")
	}
}

func TestGitHubResourceUpstreamErrorsAndRedirects(t *testing.T) {
	for _, status := range []int{http.StatusFound, http.StatusUnauthorized, http.StatusNotFound, http.StatusInternalServerError} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			app := resourceTestApp(t, func(request *http.Request) (*http.Response, error) {
				if request.URL.Path == "/rate_limit" {
					return resourceResponse(http.StatusOK, `{}`), nil
				}
				if request.URL.Host != "api.github.com" {
					t.Fatal("credentials followed a redirect")
				}
				response := resourceResponse(status, `{"secret":"never return"}`)
				response.Header.Set("Location", "https://evil.example/leak")
				return response, nil
			})
			response := resourceGet(t, app, "/api/v1/github/repos/owner/repo", "")
			want := http.StatusServiceUnavailable
			if status == http.StatusNotFound {
				want = status
			}
			if response.Code != want || strings.Contains(response.Body.String(), "secret") {
				t.Fatalf("unexpected upstream error mapping: %d %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestGitHubResourceReleaseRoute(t *testing.T) {
	app := resourceTestApp(t, func(request *http.Request) (*http.Response, error) {
		if request.URL.Path == "/rate_limit" {
			return resourceResponse(http.StatusOK, `{}`), nil
		}
		if request.URL.Path != "/repos/owner/repo/releases/latest" {
			t.Errorf("unexpected resource path %s", request.URL.Path)
		}
		return resourceResponse(http.StatusOK, `{"tag_name":"v2","name":"Release","html_url":"https://github.com/owner/repo/releases/tag/v2","published_at":"2026-10-15T00:00:00Z","draft":false,"prerelease":false,"body":"omit"}`), nil
	})
	response := resourceGet(t, app, "/api/v1/github/repos/OWNER/Repo/releases/latest", "")
	if response.Code != http.StatusOK || strings.Contains(response.Body.String(), "omit") ||
		!strings.Contains(response.Body.String(), `"tag_name":"v2"`) {
		t.Fatalf("release route: %d %s", response.Code, response.Body.String())
	}
}

func TestGitHubResourceCacheBoundAndExpiry(t *testing.T) {
	var cache githubResourceCache
	for index := range githubResourceEntries + 10 {
		cache.put(strconv.Itoa(index), githubResourceEntry{body: []byte("{}"), validated: time.Now()})
	}
	if len(cache.entries) != githubResourceEntries {
		t.Fatalf("unbounded cache size=%d", len(cache.entries))
	}
	cache.put("expired", githubResourceEntry{validated: time.Now().Add(-githubResourceKeepFor - time.Minute)})
	if _, found := cache.get("expired"); found {
		t.Fatal("expired payload retained")
	}
}

func TestGitHubResourceCacheIsolatesAuthentication(t *testing.T) {
	var reads atomic.Int64
	app := resourceTestApp(t, func(request *http.Request) (*http.Response, error) {
		if request.URL.Path == "/rate_limit" {
			return resourceResponse(http.StatusOK, `{}`), nil
		}

		reads.Add(1)
		return resourceResponse(http.StatusOK, resourceRepositoryJSON), nil
	})
	for _, identity := range []struct{ authorization, cookie string }{
		{"identity-one", "session=one"},
		{"identity-one", "session=one"},
		{"identity-two", "session=one"},
		{"identity-two", "session=two"},
	} {
		request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/v1/github/repos/owner/repo", nil)
		request.Header.Set("Authorization", identity.authorization)
		request.Header.Set("Cookie", identity.cookie)
		response := httptest.NewRecorder()
		resourceMux(app).ServeHTTP(response, request)
		vary := strings.Join(response.Header().Values("Vary"), ",")
		if response.Code != http.StatusOK || !strings.Contains(vary, "Authorization") || !strings.Contains(vary, "Cookie") {
			t.Fatalf("missing private response isolation: %d %s", response.Code, vary)
		}
	}
	if reads.Load() != 3 {
		t.Fatalf("authentication cache partitions collapsed: upstream reads=%d", reads.Load())
	}
	for key := range app.githubResources.entries {
		if strings.Contains(key, "identity-") || strings.Contains(key, "session=") {
			t.Fatal("raw authentication persisted in resource cache keys")
		}
	}
}

func TestGitHubResourceFreshCacheChecksLocalCredentials(t *testing.T) {
	var reads atomic.Int64
	app := resourceTestApp(t, func(request *http.Request) (*http.Response, error) {
		if request.URL.Path == "/rate_limit" {
			return resourceResponse(http.StatusOK, `{}`), nil
		}
		reads.Add(1)
		return resourceResponse(http.StatusOK, resourceRepositoryJSON), nil
	})
	path := "/api/v1/github/repos/owner/repo"
	first := resourceGet(t, app, path, "")
	if first.Code != http.StatusOK {
		t.Fatalf("initial resource status=%d", first.Code)
	}
	app.githubResources.localToken = func(context.Context) (string, error) { return "", errors.New("signed out") }
	if response := resourceGet(t, app, path, ""); response.Code != http.StatusServiceUnavailable {
		t.Fatal("fresh cache bypassed signed-out local credentials")
	}
	app.githubResources.localToken = func(context.Context) (string, error) { return "different-account", nil }
	if response := resourceGet(t, app, path, ""); response.Code != http.StatusOK || reads.Load() != 2 {
		t.Fatalf("account switch reused cached data: status=%d reads=%d", response.Code, reads.Load())
	}
}

func TestGitHubResourceCacheAgeDoesNotRestartFreshness(t *testing.T) {
	app := resourceTestApp(t, func(request *http.Request) (*http.Response, error) {
		if request.URL.Path == "/rate_limit" {
			return resourceResponse(http.StatusOK, `{}`), nil
		}
		return resourceResponse(http.StatusOK, resourceRepositoryJSON), nil
	})
	path := "/api/v1/github/repos/owner/repo"
	first := resourceGet(t, app, path, "")
	key := githubResourceKey(1, "repos/owner/repo", nil, "test-credential")
	cached, _ := app.githubResources.get(key)
	cached.validated = time.Now().Add(-2 * time.Minute)
	app.githubResources.put(key, cached)
	for _, etag := range []string{"", first.Header().Get("ETag")} {
		response := resourceGet(t, app, path, etag)
		age, err := strconv.Atoi(response.Header().Get("Age"))
		if err != nil || age < 120 || age > 125 {
			t.Fatalf("cache age reset: status=%d age=%q", response.Code, response.Header().Get("Age"))
		}
	}
}

func TestGitHubResourceHostedUsesInstallationCredentials(t *testing.T) {
	key, err := stressAppKey()
	if err != nil {
		t.Fatal(err)
	}
	var tokenRequests atomic.Int64
	transport := resourceRoundTripper(func(request *http.Request) (*http.Response, error) {
		if request.Method == http.MethodPost && request.URL.Path == "/app/installations/42/access_tokens" {
			tokenRequests.Add(1)
			response := resourceResponse(http.StatusCreated, `{"token":"installation-credential","expires_at":"2099-01-01T00:00:00Z"}`)
			response.Header.Set("Content-Type", "application/json")
			return response, nil
		}
		if request.Header.Get("Authorization") != "Bearer "+"installation-credential" {
			t.Error("hosted resource did not use installation credentials")
		}
		if request.URL.Path == "/rate_limit" {
			return resourceResponse(http.StatusOK, `{}`), nil
		}
		return resourceResponse(http.StatusOK, resourceRepositoryJSON), nil
	})
	client, err := githubapp.New(githubapp.Config{AppID: 7, PrivateKeyPEM: key, Transport: transport})
	if err != nil {
		t.Fatal(err)
	}
	store, err := memory.New(memory.Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	enrollment := collect.Enrollment{Metadata: store, Leases: store}
	if err := enrollment.AddRepositories(t.Context(), 42, []string{"owner/repo"}); err != nil {
		t.Fatal(err)
	}
	app := resourceTestApp(t, transport)
	app.config.HostProfile = hostedHostProfile()
	app.config.Collector = &CollectorConfig{AppID: 7, PrivateKeyPEM: key, Transport: transport}
	app.reconciler = &Collector{client: client, enrollment: enrollment}
	app.githubResources.localToken = func(context.Context) (string, error) {
		t.Fatal("hosted resource used local credentials")
		return "", nil
	}
	for range 2 {
		response := resourceGet(t, app, "/api/v1/github/repos/owner/repo", "")
		if response.Code != http.StatusOK {
			t.Fatalf("configured hosted resource failed: %d %s", response.Code, response.Body.String())
		}
	}
	if tokenRequests.Load() != 1 {
		t.Fatalf("installation token minting was not cached: %d", tokenRequests.Load())
	}
	app.config.Collector.AdmitOnly = true
	if response := resourceGet(t, app, "/api/v1/github/repos/owner/repo", ""); response.Code != http.StatusServiceUnavailable {
		t.Fatal("admission-only credential boundary was bypassed")
	}
}
