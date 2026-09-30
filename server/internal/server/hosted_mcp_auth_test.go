package server

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v4"
)

type mcpRoundTrip func(*http.Request) (*http.Response, error)

func (fn mcpRoundTrip) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func TestHostedMCPAuthentication(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	jwks, err := json.Marshal(map[string]any{"keys": []map[string]string{{
		"kid": "test-key", "kty": "RSA", "alg": "RS256", "use": "sig",
		"n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
		"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes()),
	}}})
	if err != nil {
		t.Fatal(err)
	}
	permissionStatus := http.StatusOK
	client := &http.Client{Transport: mcpRoundTrip(func(request *http.Request) (*http.Response, error) {
		status, body := permissionStatus, []byte("{}")
		if request.URL.String() == actionsOIDCJWKS {
			status, body = http.StatusOK, jwks
		} else if request.Header.Get("Authorization") != "Bearer "+"job-token" ||
			!strings.HasPrefix(request.URL.Path, "/repos/githubnext/gh-aw-cao/") {
			status = http.StatusForbidden
		}
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(string(body))), Request: request, Header: make(http.Header)}, nil
	})}
	app := &App{config: Config{
		MCPEnabled:            true,
		HostProfile:           HostProfile{Name: "coolify", Authentication: HostAuthenticationOAuth},
		HostedMCPRepositoryID: "1302952722",
		ActionsRepository:     "githubnext/gh-aw-cao",
		ActionsHTTPClient:     client,
		Proxy:                 ProxyPolicy{AllowedHosts: []string{"localhost"}},
	}}
	baseClaims := jwt.MapClaims{
		"iss": actionsOIDCIssuer, "aud": actionsMCPAudience,
		"repository": "githubnext/gh-aw-cao", "repository_id": "1302952722",
		"workflow_ref": "githubnext/gh-aw-cao/.github/workflows/cao-remote-mcp-explorer.lock.yml@refs/heads/main", "event_name": "schedule", "run_id": "123",
		"iat": time.Now().Add(-time.Minute).Unix(), "exp": time.Now().Add(time.Minute).Unix(),
	}
	sign := func(claims jwt.MapClaims, signingKey *rsa.PrivateKey) string {
		t.Helper()
		token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
		token.Header["kid"] = "test-key"
		signed, err := token.SignedString(signingKey)
		if err != nil {
			t.Fatal(err)
		}
		return signed
	}
	check := func(claims jwt.MapClaims, signingKey *rsa.PrivateKey, githubToken string) bool {
		t.Helper()
		request := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/mcp", nil)
		request.Header.Set("Authorization", "Bearer "+sign(claims, signingKey))
		request.Header.Set("X-GitHub-Actions-Token", githubToken)
		return app.authorizeHostedMCP(request)
	}
	copyClaims := func() jwt.MapClaims {
		claims := jwt.MapClaims{}
		for key, value := range baseClaims {
			claims[key] = value
		}
		return claims
	}
	if !check(copyClaims(), key, "job-token") {
		t.Fatal("authorized workflow was rejected")
	}
	app.mcp = http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})
	request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "http://localhost/mcp", nil)
	request.Header.Set("Authorization", "Bearer "+sign(copyClaims(), key))
	request.Header.Set("X-GitHub-Actions-Token", "job-token")
	route := app.requireGitHubAccess(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusNoContent)
	}))
	response := httptest.NewRecorder()
	route.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("authorized MCP route returned %d", response.Code)
	}
	request.Header.Del("Authorization")
	response = httptest.NewRecorder()
	route.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unsigned MCP route returned %d", response.Code)
	}
	for _, change := range []struct {
		name  string
		field string
		value any
	}{
		{"repository", "repository", "another/repo"},
		{"repository ID", "repository_id", "999"},
		{"audience", "aud", "https://untrusted.example/mcp"},
		{"issuer", "iss", "https://untrusted.example"},
		{"workflow", "workflow_ref", "another/workflow@refs/heads/main"},
		{"missing run", "run_id", ""},
		{"expired", "exp", time.Now().Add(-time.Minute).Unix()},
		{"future", "iat", time.Now().Add(time.Hour).Unix()},
	} {
		t.Run(change.name, func(t *testing.T) {
			claims := copyClaims()
			claims[change.field] = change.value
			if check(claims, key, "job-token") {
				t.Fatal("untrusted assertion was accepted")
			}
		})
	}
	otherKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	if check(copyClaims(), otherKey, "job-token") || check(copyClaims(), key, "") ||
		check(copyClaims(), key, "different-token") {
		t.Fatal("missing or unrelated credentials were accepted")
	}
	permissionStatus = http.StatusForbidden
	if check(copyClaims(), key, "job-token") {
		t.Fatal("denied repository probe was accepted")
	}
}
