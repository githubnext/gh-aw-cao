package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

type serverRateLimitClient struct {
	result      []any
	command     []string
	callCount   int
	maxDeadline time.Duration
}

func (client *serverRateLimitClient) Do(ctx context.Context, command ...string) (any, error) {
	client.command = append([]string{}, command...)
	client.callCount++
	if deadline, ok := ctx.Deadline(); ok {
		client.maxDeadline = time.Until(deadline)
	}
	return client.result, nil
}

func (*serverRateLimitClient) DoMany(context.Context, [][]string) ([]any, error) {
	return nil, nil
}

func TestRateLimitReturnsStandardHeaders(t *testing.T) {
	client := &serverRateLimitClient{result: []any{int64(1), int64(28), int64(0), int64(4000)}}
	app := &App{store: redisx.NewStore(client, "test")}
	nextCalled := false
	handler := app.rateLimit(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		nextCalled = true
		response.WriteHeader(http.StatusNoContent)
	}))
	request := httptest.NewRequestWithContext(
		t.Context(), http.MethodPost, "https://dashboard.example/api/v1/query", nil)
	request.RemoteAddr = "192.0.2.10:4321"
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if !nextCalled || response.Code != http.StatusNoContent {
		t.Fatalf("allowed request did not reach handler: status=%d", response.Code)
	}
	for name, expected := range map[string]string{
		"RateLimit-Limit":     "30",
		"RateLimit-Remaining": "28",
		"RateLimit-Reset":     "4",
		"RateLimit-Policy":    "30;w=60",
	} {
		if actual := response.Header().Get(name); actual != expected {
			t.Errorf("%s = %q, want %q", name, actual, expected)
		}
	}
	if retry := response.Header().Get("Retry-After"); retry != "" {
		t.Fatalf("allowed request returned Retry-After %q", retry)
	}
}

func TestRateLimitRejectsExhaustedBucketWithCooldown(t *testing.T) {
	client := &serverRateLimitClient{result: []any{int64(0), int64(0), int64(1500), int64(60000)}}
	app := &App{store: redisx.NewStore(client, "test")}
	handler := app.rateLimit(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("limited request reached handler")
	}))
	response := httptest.NewRecorder()

	handler.ServeHTTP(
		response,
		httptest.NewRequestWithContext(t.Context(), http.MethodGet, "https://dashboard.example/api/repositories", nil),
	)

	if response.Code != http.StatusTooManyRequests {
		t.Fatalf("rate-limited request returned %d: %s", response.Code, response.Body.String())
	}
	if retry := response.Header().Get("Retry-After"); retry != "2" {
		t.Fatalf("Retry-After = %q, want 2", retry)
	}
	if remaining := response.Header().Get("RateLimit-Remaining"); remaining != "0" {
		t.Fatalf("RateLimit-Remaining = %q, want 0", remaining)
	}
}

func TestRateLimitUsesHashedAuthenticatedIdentity(t *testing.T) {
	client := &serverRateLimitClient{result: []any{int64(1), int64(119), int64(0), int64(500)}}
	app := &App{store: redisx.NewStore(client, "test")}
	handler := app.rateLimit(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusNoContent)
	}))
	request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "https://dashboard.example/api/repositories", nil)
	request = request.WithContext(context.WithValue(
		request.Context(), oauthSessionContextKey{}, oauthSession{Login: "OctoCat"}))
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	sum := sha256.Sum256([]byte("user:octocat"))
	expectedKey := "cao:test:rate-limit:general:" + hex.EncodeToString(sum[:])
	if len(client.command) < 4 || client.command[3] != expectedKey {
		t.Fatalf("rate limit key = %#v, want %q", client.command, expectedKey)
	}
	if strings.Contains(strings.Join(client.command, " "), "octocat") {
		t.Fatal("Redis rate limit command exposed the GitHub login")
	}
}

func TestRateLimitExemptsServiceProbesAndWebhooks(t *testing.T) {
	for _, path := range []string{"/api/v1/health", "/api/health", "/api/readiness", "/api/github/webhook", "/assets/app.js"} {
		client := &serverRateLimitClient{}
		app := &App{store: redisx.NewStore(client, "test")}
		handler := app.rateLimit(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
			response.WriteHeader(http.StatusNoContent)
		}))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequestWithContext(t.Context(), http.MethodGet, path, nil))
		if response.Code != http.StatusNoContent || len(client.command) != 0 {
			t.Errorf("%s was rate limited", path)
		}
	}
}

func TestRateLimitUsesForwardedClientOnlyAtTrustedBoundary(t *testing.T) {
	request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "https://dashboard.example/auth/login", nil)
	request.RemoteAddr = "127.0.0.1:4321"
	request.Header.Add("X-Forwarded-For", "203.0.113.9")
	request.Header.Add("X-Forwarded-For", "198.51.100.8:4567")

	untrusted := &App{}
	if got := untrusted.clientIP(request); got != "127.0.0.1" {
		t.Fatalf("untrusted forwarded address selected: %q", got)
	}
	trusted := &App{config: Config{Proxy: ProxyPolicy{
		AllowedHosts: []string{"dashboard.example"}, TrustForwarded: true,
	}}}
	if got := trusted.clientIP(request); got != "198.51.100.8" {
		t.Fatalf("trusted forwarded address not selected: %q", got)
	}

	request.Header.Set("X-Forwarded-For", "203.0.113.9, unknown")
	if got := trusted.clientIP(request); got != "127.0.0.1" {
		t.Fatalf("malformed trusted address fell back to caller input: %q", got)
	}
}

func TestForwardedBoundaryUsesTrustedFinalHeaderValues(t *testing.T) {
	request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "https://internal.example/", nil)
	request.Host = "internal.example"
	request.Header.Add("X-Forwarded-Host", "attacker.example")
	request.Header.Add("X-Forwarded-Host", "dashboard.example")
	request.Header.Add("X-Forwarded-Proto", "http")
	request.Header.Add("X-Forwarded-Proto", "https")
	policy := ProxyPolicy{
		AllowedHosts:   []string{"dashboard.example"},
		RequireHTTPS:   true,
		TrustForwarded: true,
	}

	if !validAzureProxyRequest(request, policy) {
		t.Fatal("trusted final forwarded header values were not selected")
	}
}

func TestPreAuthRateLimitBoundsRejectedRequests(t *testing.T) {
	client := &serverRateLimitClient{result: []any{int64(1), int64(1199), int64(0), int64(50)}}
	app := hostedRateLimitApp(client)
	handler := app.preAuthRateLimit(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		http.Error(response, "unauthorized", http.StatusUnauthorized)
	}))
	request := httptest.NewRequestWithContext(
		t.Context(), http.MethodGet, "https://dashboard.example/api/repositories", nil)
	request.RemoteAddr = "192.0.2.10:4321"
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("rejected request returned %d", response.Code)
	}
	if client.callCount != 1 || len(client.command) < 6 ||
		!strings.Contains(client.command[3], ":rate-limit:edge:") ||
		client.command[4] != "1200" || client.command[5] != "60000" {
		t.Fatalf("pre-authentication limiter command = %#v", client.command)
	}
	if client.maxDeadline <= 0 || client.maxDeadline > rateLimitTimeout {
		t.Fatalf("limiter deadline = %s, want at most %s", client.maxDeadline, rateLimitTimeout)
	}
}

func TestPreAuthRateLimitSkipsInvalidRequestBoundary(t *testing.T) {
	client := &serverRateLimitClient{result: []any{int64(1), int64(1199), int64(0), int64(50)}}
	app := hostedRateLimitApp(client)
	handler := app.preAuthRateLimit(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusMisdirectedRequest)
	}))
	request := httptest.NewRequestWithContext(
		t.Context(), http.MethodGet, "https://attacker.example/api/repositories", nil)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusMisdirectedRequest || client.callCount != 0 {
		t.Fatalf("invalid request boundary reached Redis: status=%d calls=%d", response.Code, client.callCount)
	}
}

func TestPreAuthRateLimitCoversHostedStaticRequests(t *testing.T) {
	client := &serverRateLimitClient{result: []any{int64(1), int64(1199), int64(0), int64(50)}}
	app := hostedRateLimitApp(client)
	handler := app.preAuthRateLimit(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusNoContent)
	}))
	request := httptest.NewRequestWithContext(
		t.Context(), http.MethodGet, "https://dashboard.example/assets/app.js", nil)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusNoContent || client.callCount != 1 {
		t.Fatalf("hosted static request was not edge limited: status=%d calls=%d", response.Code, client.callCount)
	}
}

func hostedRateLimitApp(client *serverRateLimitClient) *App {
	return &App{
		store: redisx.NewStore(client, "test"),
		oauth: &githubOAuth{},
		config: Config{Proxy: ProxyPolicy{
			AllowedHosts: []string{"dashboard.example"},
			RequireHTTPS: true,
		}},
	}
}
