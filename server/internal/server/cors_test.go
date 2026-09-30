package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestCORSPolicyNormalizesExactOrigins(t *testing.T) {
	policy, err := CORSPolicy{AllowedOrigins: []string{
		"https://Dashboard.Example.com",
		"https://dashboard.example.com:443/",
		"https://tools.example.com:8443",
		"http://localhost:5173",
		"http://[::1]:8080",
	}}.normalize()
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"https://dashboard.example.com",
		"https://tools.example.com:8443",
		"http://localhost:5173",
		"http://[::1]:8080",
	}
	if !slices.Equal(policy.AllowedOrigins, want) || policy.MaxAge != defaultCORSMaxAge {
		t.Fatalf("unexpected normalized policy: %+v", policy)
	}
}

func TestCORSPolicyRejectsUnsafeOrigins(t *testing.T) {
	for _, origin := range []string{
		"*", "null", "https://*.example.com", "http://dashboard.example.com",
		"https://dashboard.example.com/path", "https://user@dashboard.example.com",
		"https://dashboard.example.com?x=1", "https://dashboard.example.com#x",
		"ftp://dashboard.example.com", "dashboard.example.com", "",
	} {
		if _, err := (CORSPolicy{AllowedOrigins: []string{origin}}).normalize(); err == nil {
			t.Errorf("origin %q was accepted", origin)
		}
	}
	if _, err := (CORSPolicy{AllowCredentials: true}).normalize(); err == nil {
		t.Error("allow-credentials without origins was accepted")
	}
	if _, err := (CORSPolicy{AllowedOrigins: []string{"https://a.example"}, MaxAge: maxCORSMaxAge + 1}).normalize(); err == nil {
		t.Error("oversized max-age was accepted")
	}
}

func TestHostPolicyReadsCORSFromCaoJSON(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cao.json")
	document := `{
		"version": 1,
		"control-plane": {
			"scope": {"allowed-owners": ["example"]},
			"web": {
				"host": {
					"target": {"module": "container", "name": "render"},
					"redis": {"module": "render", "tls": {"mode": "required"}},
					"cors": {
						"allowed-origins": ["https://Tools.Example.com"],
						"allow-credentials": true,
						"max-age": 120
					}
				}
			}
		}
	}`
	if err := os.WriteFile(path, []byte(document), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CAO_POLICY_PATH", path)
	t.Setenv("REDIS_URL", "rediss://cache.example.com:6379")
	resolved, err := loadHostPolicyFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(resolved.CORS.AllowedOrigins, []string{"https://tools.example.com"}) ||
		!resolved.CORS.AllowCredentials || resolved.CORS.MaxAge != 120 {
		t.Fatalf("unexpected CORS policy: %+v", resolved.CORS)
	}

	zeroAge := strings.Replace(document, `"max-age": 120`, `"max-age": 0`, 1)
	if err := os.WriteFile(path, []byte(zeroAge), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadHostPolicyFromEnv(); err == nil || !strings.Contains(err.Error(), "max-age") {
		t.Fatalf("expected explicit zero max-age rejection, got %v", err)
	}

	invalid := strings.Replace(document, `"https://Tools.Example.com"`, `"*"`, 1)
	if err := os.WriteFile(path, []byte(invalid), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadHostPolicyFromEnv(); err == nil || !strings.Contains(err.Error(), "cors") {
		t.Fatalf("expected wildcard CORS rejection, got %v", err)
	}
}

func TestSameOriginDefaultEmitsNoCORSHeaders(t *testing.T) {
	github := fakeGitHub(t, fakeGitHubOptions{membershipState: "active", accessExpiresIn: 3600})
	app := newAzureTestApp(t, github.URL)
	request := azureRequest(t, http.MethodGet, "/api/v1/health")
	request.Header.Set("Origin", "https://evil.example")
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	for _, header := range []string{"Access-Control-Allow-Origin", "Access-Control-Allow-Credentials"} {
		if response.Header().Get(header) != "" {
			t.Fatalf("same-origin default emitted %s", header)
		}
	}
}

func TestConfiguredCORSAllowsOnlyListedOrigins(t *testing.T) {
	github := fakeGitHub(t, fakeGitHubOptions{membershipState: "active", accessExpiresIn: 3600})
	app := newAzureTestApp(t, github.URL)
	app.config.CORS = CORSPolicy{
		AllowedOrigins:   []string{"https://tools.example.com"},
		AllowCredentials: true,
		MaxAge:           120,
	}

	preflight := azureRequest(t, http.MethodOptions, "/api/v1/query")
	preflight.Header.Set("Origin", "https://tools.example.com")
	preflight.Header.Set("Access-Control-Request-Method", http.MethodPost)
	preflight.Header.Set("Access-Control-Request-Headers", "content-type, x-csrf-token")
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, preflight)
	if response.Code != http.StatusNoContent ||
		response.Header().Get("Access-Control-Allow-Origin") != "https://tools.example.com" ||
		response.Header().Get("Access-Control-Allow-Credentials") != "true" ||
		response.Header().Get("Access-Control-Max-Age") != "120" ||
		!strings.Contains(response.Header().Get("Access-Control-Allow-Headers"), "X-CSRF-Token") {
		t.Fatalf("unexpected preflight response %d: %v", response.Code, response.Header())
	}

	unsupported := azureRequest(t, http.MethodOptions, "/api/v1/query")
	unsupported.Header.Set("Origin", "https://tools.example.com")
	unsupported.Header.Set("Access-Control-Request-Method", http.MethodDelete)
	response = httptest.NewRecorder()
	app.Handler().ServeHTTP(response, unsupported)
	if response.Header().Get("Access-Control-Allow-Methods") != "" {
		t.Fatalf("unsupported preflight method was allowed: %v", response.Header())
	}

	denied := azureRequest(t, http.MethodOptions, "/api/v1/query")
	denied.Header.Set("Origin", "https://evil.example")
	denied.Header.Set("Access-Control-Request-Method", http.MethodPost)
	response = httptest.NewRecorder()
	app.Handler().ServeHTTP(response, denied)
	if response.Header().Get("Access-Control-Allow-Origin") != "" ||
		!slices.Contains(response.Header().Values("Vary"), "Origin") {
		t.Fatalf("unlisted origin received CORS headers: %v", response.Header())
	}

	unauthenticated := azureRequest(t, http.MethodGet, "/api/v1/diagnostics")
	unauthenticated.Header.Set("Origin", "https://tools.example.com")
	unauthenticated.Header.Set("Sec-Fetch-Mode", "cors")
	response = httptest.NewRecorder()
	app.Handler().ServeHTTP(response, unauthenticated)
	if response.Code != http.StatusUnauthorized ||
		response.Header().Get("Access-Control-Allow-Origin") != "https://tools.example.com" {
		t.Fatalf("expected readable 401 for allowed origin, got %d: %v", response.Code, response.Header())
	}
}

func TestUnauthenticatedSubresourceIsNotRedirectedToGitHub(t *testing.T) {
	github := fakeGitHub(t, fakeGitHubOptions{membershipState: "active", accessExpiresIn: 3600})
	app := newAzureTestApp(t, github.URL)

	for _, mode := range []string{"cors", "no-cors", "same-origin"} {
		request := azureRequest(t, http.MethodGet, "/manifest.webmanifest")
		request.Header.Set("Sec-Fetch-Mode", mode)
		response := httptest.NewRecorder()
		app.Handler().ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized || response.Header().Get("Location") != "" {
			t.Fatalf("mode %s: expected 401 without redirect, got %d location=%q",
				mode, response.Code, response.Header().Get("Location"))
		}
	}

	for _, mode := range []string{"navigate", ""} {
		request := azureRequest(t, http.MethodGet, "/")
		if mode != "" {
			request.Header.Set("Sec-Fetch-Mode", mode)
		}
		response := httptest.NewRecorder()
		app.Handler().ServeHTTP(response, request)
		if response.Code != http.StatusFound || response.Header().Get("Location") != "/auth/login" {
			t.Fatalf("mode %q: expected login redirect, got %d location=%q",
				mode, response.Code, response.Header().Get("Location"))
		}
	}
}
