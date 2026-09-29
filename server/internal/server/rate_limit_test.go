package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
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

func TestQueryRateLimitCostChargesLongRunningQueries(t *testing.T) {
	for _, testCase := range []struct {
		name    string
		metrics model.Metrics
		want    int
	}{
		{"minimum", model.Metrics{}, 1},
		{"duration", model.Metrics{DurationMS: 5000}, 5},
		{"operations", model.Metrics{Operations: 1_000_000}, 4},
		{"redis work", model.Metrics{RedisRows: 750_000}, 3},
		{"working rows", model.Metrics{PeakWorkingRows: 500_000}, 5},
		{"bytes", model.Metrics{PeakWorkingBytes: 64 << 20}, 4},
		{"highest signal wins", model.Metrics{DurationMS: 2000, Operations: 1_000_000, PeakWorkingRows: 300_000}, 4},
		{"capacity cap", model.Metrics{DurationMS: 60000, Operations: query.MaxOperations}, queryRateLimit},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if got := queryRateLimitCost(testCase.metrics); got != testCase.want {
				t.Errorf("queryRateLimitCost(%#v) = %d, want %d", testCase.metrics, got, testCase.want)
			}
		})
	}
}

func TestChargeQueryRateLimitUsesReservedSubjectAndAdditionalCost(t *testing.T) {
	client := &serverRateLimitClient{result: []any{int64(1), int64(24), int64(0), int64(12000)}}
	app := &App{store: redisx.NewStore(client, "test")}
	reservation := rateLimitReservation{
		key:    "query:opaque-subject",
		policy: requestRatePolicy{name: "query", capacity: queryRateLimit, window: queryRateWindow},
	}
	ctx := context.WithValue(t.Context(), rateLimitReservationContextKey{}, reservation)
	response := httptest.NewRecorder()

	status, err := app.chargeQueryRateLimit(ctx, response, 7)
	if err != nil || status != http.StatusOK {
		t.Fatalf("weighted query charge failed: status=%d err=%v", status, err)
	}
	if len(client.command) != 7 || client.command[3] != "cao:test:rate-limit:query:opaque-subject" ||
		client.command[6] != "6" {
		t.Fatalf("unexpected weighted query charge: %#v", client.command)
	}
	if response.Header().Get("RateLimit-Remaining") != "24" ||
		response.Header().Get("RateLimit-Reset") != "12" {
		t.Fatalf("weighted query charge did not refresh headers: %#v", response.Header())
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

func TestMCPUsesQueryRateLimitBeforeHandler(t *testing.T) {
	client := &serverRateLimitClient{result: []any{int64(0), int64(0), int64(1500), int64(60000)}}
	app := &App{
		store:       redisx.NewStore(client, "test"),
		accessToken: testAccessToken,
		mcp: http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
			t.Fatal("rate-limited MCP request reached handler")
		}),
	}
	request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "http://localhost/mcp", nil)
	authorize(request)
	response := httptest.NewRecorder()

	app.Handler().ServeHTTP(response, request)

	if response.Code != http.StatusTooManyRequests {
		t.Fatalf("rate-limited MCP returned %d, want 429", response.Code)
	}
	if len(client.command) < 6 ||
		!strings.HasPrefix(client.command[3], "cao:test:rate-limit:query:") ||
		client.command[4] != "30" ||
		client.command[5] != "60000" {
		t.Fatalf("MCP rate limiter command = %#v, want query policy", client.command)
	}
}

func TestMCPRateLimitUsesValidatedGitHubActionsActor(t *testing.T) {
	client := &serverRateLimitClient{result: []any{int64(0), int64(0), int64(1500), int64(60000)}}
	app := &App{
		store:        redisx.NewStore(client, "test"),
		accessToken:  testAccessToken,
		actionsToken: testActionsToken,
		actionsActor: testActionsActor,
		mcp: http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
			t.Fatal("rate-limited MCP request reached handler")
		}),
	}
	request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "http://localhost/mcp", nil)
	request.Header.Set("Authorization", "Bearer "+testActionsToken)
	request.Header.Set("X-GitHub-Actor", "OctoCat")
	response := httptest.NewRecorder()

	app.Handler().ServeHTTP(response, request)

	if response.Code != http.StatusTooManyRequests {
		t.Fatalf("rate-limited MCP returned %d, want 429", response.Code)
	}
	sum := sha256.Sum256([]byte("actions-actor:" + testActionsActor))
	expectedKey := "cao:test:rate-limit:query:" + hex.EncodeToString(sum[:])
	if len(client.command) < 4 || client.command[3] != expectedKey {
		t.Fatalf("MCP rate limit key = %#v, want %q", client.command, expectedKey)
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

func TestRateLimitSeparatesOAuthCallbacksBehindEnterpriseProxy(t *testing.T) {
	oauth := &githubOAuth{key: []byte("test-signing-key")}
	for _, state := range []string{"state-one", "state-two"} {
		client := &serverRateLimitClient{result: []any{int64(1), int64(9), int64(0), int64(500)}}
		app := &App{store: redisx.NewStore(client, "test"), oauth: oauth}
		handler := app.rateLimit(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
			response.WriteHeader(http.StatusNoContent)
		}))
		request := httptest.NewRequestWithContext(
			t.Context(), http.MethodGet, "https://dashboard.example/auth/callback?state="+state, nil)
		request.RemoteAddr = "192.0.2.10:4321"
		signedState := oauth.sign(state)
		request.AddCookie(&http.Cookie{
			Name: "cao_oauth_state", Value: signedState, Secure: true,
			HttpOnly: true, SameSite: http.SameSiteLaxMode,
		})
		response := httptest.NewRecorder()

		handler.ServeHTTP(response, request)

		sum := sha256.Sum256([]byte("oauth-state:" + signedState))
		expectedKey := "cao:test:rate-limit:auth:" + hex.EncodeToString(sum[:])
		if len(client.command) < 4 || client.command[3] != expectedKey {
			t.Fatalf("OAuth callback key = %#v, want %q", client.command, expectedKey)
		}
	}
}

func TestInnerRateLimitExemptsServiceProbesWebhooksAndAssets(t *testing.T) {
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

func TestPreAuthRateLimitBoundsWebhookBeforeSignatureValidation(t *testing.T) {
	client := &serverRateLimitClient{result: []any{int64(1), int64(1199), int64(0), int64(50)}}
	app := hostedRateLimitApp(client)
	handler := app.preAuthRateLimit(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusUnauthorized)
	}))
	request := httptest.NewRequestWithContext(
		t.Context(), http.MethodPost, "https://dashboard.example/api/github/webhook", nil)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusUnauthorized || client.callCount != 1 ||
		len(client.command) < 4 || !strings.Contains(client.command[3], ":rate-limit:edge:") {
		t.Fatalf("webhook was not edge limited: status=%d command=%#v", response.Code, client.command)
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

	trusted.config.Proxy.TrustedProxyPrefixes = []netip.Prefix{netip.MustParsePrefix("10.42.0.0/24")}
	if got := trusted.clientIP(request); got != "127.0.0.1" {
		t.Fatalf("forwarded address from a peer outside the trusted CIDR was selected: %q", got)
	}
	request.RemoteAddr = "10.42.0.5:4321"
	if got := trusted.clientIP(request); got != "198.51.100.8" {
		t.Fatalf("forwarded address from a trusted CIDR was rejected: %q", got)
	}

	request.Header.Set("X-Forwarded-For", "203.0.113.9, unknown")
	if got := trusted.clientIP(request); got != "10.42.0.5" {
		t.Fatalf("malformed trusted address fell back to caller input: %q", got)
	}
}

func TestRateLimitSupportsRFC7239EnterpriseProxyAddress(t *testing.T) {
	request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "https://dashboard.example/auth/login", nil)
	request.RemoteAddr = "127.0.0.1:4321"
	request.Header.Add("Forwarded", `for=203.0.113.9;proto=http`)
	request.Header.Add("Forwarded", `for="[2001:db8::8]:4567";proto=https`)
	app := &App{config: Config{Proxy: ProxyPolicy{
		AllowedHosts: []string{"dashboard.example"}, TrustForwarded: true,
	}}}

	if got := app.clientIP(request); got != "2001:db8::8" {
		t.Fatalf("RFC 7239 forwarded address = %q, want 2001:db8::8", got)
	}

	request.Header.Set("Forwarded", `for=unknown;proto=https`)
	if got := app.clientIP(request); got != "127.0.0.1" {
		t.Fatalf("obfuscated forwarded address fell back to caller input: %q", got)
	}

	request.Header.Set("X-Forwarded-For", "unknown")
	request.Header.Set("Forwarded", `for=203.0.113.9;proto=https`)
	if got := app.clientIP(request); got != "127.0.0.1" {
		t.Fatalf("malformed preferred address fell through to secondary header: %q", got)
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

	if !validProxyRequest(request, policy) {
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

func TestPreAuthRateLimitCoversOAuthEntryAtSharedEnterpriseEdge(t *testing.T) {
	client := &serverRateLimitClient{result: []any{int64(1), int64(1199), int64(0), int64(50)}}
	app := hostedRateLimitApp(client)
	handler := app.preAuthRateLimit(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusFound)
	}))
	request := httptest.NewRequestWithContext(
		t.Context(), http.MethodGet, "https://dashboard.example/auth/login", nil)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusFound || client.callCount != 1 ||
		len(client.command) < 4 || !strings.Contains(client.command[3], ":rate-limit:edge:") {
		t.Fatalf("OAuth entry was not edge limited: status=%d command=%#v", response.Code, client.command)
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

func TestRateLimitConfigOverridesPolicies(t *testing.T) {
	limits := RateLimitConfig{
		General: RateLimitPolicy{Capacity: 5, Window: 2 * time.Second},
		Query:   RateLimitPolicy{Capacity: 3},
	}
	for path, want := range map[string]requestRatePolicy{
		"/api/repositories": {name: "general", capacity: 5, window: 2 * time.Second},
		"/api/v1/query":     {name: "query", capacity: 3, window: queryRateWindow},
		"/auth/login":       {name: "auth", capacity: authRateLimit, window: authRateWindow},
	} {
		request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "https://dashboard.example"+path, nil)
		got, limited := ratePolicy(request, limits)
		if !limited || got != want {
			t.Errorf("ratePolicy(%s) = %#v, %t; want %#v", path, got, limited, want)
		}
	}
	if got := limits.policy("edge"); got.capacity != edgeRateLimit || got.window != edgeRateWindow {
		t.Errorf("edge policy = %#v, want defaults", got)
	}
}

func TestRateLimitConfigRejectsInvalidPolicies(t *testing.T) {
	for _, limits := range []RateLimitConfig{
		{General: RateLimitPolicy{Capacity: -1}},
		{Query: RateLimitPolicy{Window: time.Microsecond}},
	} {
		if err := limits.validate(); err == nil {
			t.Errorf("limits %#v must be rejected", limits)
		}
	}
	if err := (RateLimitConfig{}).validate(); err != nil {
		t.Errorf("zero limits must select defaults: %v", err)
	}
}

func TestQueryChargeIsCappedAtConfiguredCapacity(t *testing.T) {
	client := &serverRateLimitClient{result: []any{int64(1), int64(0), int64(0), int64(1000)}}
	app := &App{store: redisx.NewStore(client, "test")}
	ctx := context.WithValue(t.Context(), rateLimitReservationContextKey{}, rateLimitReservation{
		key: "query:subject", policy: requestRatePolicy{name: "query", capacity: 4, window: time.Second},
	})
	if status, err := app.chargeQueryRateLimit(ctx, httptest.NewRecorder(), 30); err != nil || status != http.StatusOK {
		t.Fatalf("capped charge failed: status=%d err=%v", status, err)
	}
	if got := client.command[len(client.command)-1]; got != "3" {
		t.Fatalf("charged cost = %q, want capacity minus the admitted token (3)", got)
	}
}
