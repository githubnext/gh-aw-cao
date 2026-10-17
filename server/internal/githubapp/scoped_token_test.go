package githubapp

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func testScopedClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	pemKey := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	client, err := New(Config{AppID: 1, PrivateKeyPEM: pemKey, BaseURL: server.URL + "/api/v3/"})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func TestMintScopedTokenRequestsExplicitRepositoryAndPermissions(t *testing.T) {
	var body map[string]any
	client := testScopedClient(t, func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/api/v3/app/installations/9/access_tokens" {
			t.Errorf("unexpected request %s %s", request.Method, request.URL.Path)
		}
		if !strings.HasPrefix(request.Header.Get("Authorization"), "Bearer ") {
			t.Errorf("mint request must use the App JWT")
		}
		raw, _ := io.ReadAll(request.Body)
		_ = json.Unmarshal(raw, &body)
		response.Header().Set("Content-Type", "application/json")
		response.WriteHeader(http.StatusCreated)
		_, _ = fmt.Fprintf(response, `{"token":"ghs_scopedvalue","expires_at":%q,"permissions":{"contents":"write","metadata":"read"},"repositories":[{"name":"api"}]}`, time.Now().Add(time.Hour).UTC().Format(time.RFC3339))
	})
	token, err := client.MintScopedToken(context.Background(), 9, TokenScope{
		Repositories: []string{"api"},
		Permissions:  map[string]string{"contents": "write", "metadata": "read"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if token.Secret() != "ghs_scopedvalue" || token.InstallationID != 9 || token.ExpiresAt.IsZero() {
		t.Fatalf("token = %#v", token)
	}
	if repositories, _ := body["repositories"].([]any); len(repositories) != 1 || repositories[0] != "api" {
		t.Fatalf("repositories = %#v", body["repositories"])
	}
	permissions, _ := body["permissions"].(map[string]any)
	if len(permissions) != 2 || permissions["contents"] != "write" || permissions["metadata"] != "read" {
		t.Fatalf("permissions = %#v", body["permissions"])
	}
	for _, rendered := range []string{token.String(), fmt.Sprintf("%v", token), fmt.Sprintf("%#v", token)} {
		if strings.Contains(rendered, "ghs_scopedvalue") {
			t.Fatalf("formatted token leaked secret: %s", rendered)
		}
	}
	encoded, _ := json.Marshal(token)
	if strings.Contains(string(encoded), "ghs_scopedvalue") {
		t.Fatalf("JSON token leaked secret: %s", encoded)
	}
}

func TestTokenScopeRejectsUnscopedRequests(t *testing.T) {
	for name, scope := range map[string]TokenScope{
		"no repositories":    {Permissions: map[string]string{"contents": "read"}},
		"owner in name":      {Repositories: []string{"octo/api"}, Permissions: map[string]string{"contents": "read"}},
		"no permissions":     {Repositories: []string{"api"}},
		"unknown permission": {Repositories: []string{"api"}, Permissions: map[string]string{"administration": "write"}},
		"invalid level":      {Repositories: []string{"api"}, Permissions: map[string]string{"contents": "admin"}},
	} {
		if err := scope.Validate(); err == nil {
			t.Errorf("%s: Validate() succeeded", name)
		}
	}
	a := TokenScope{Repositories: []string{"B", "a"}, Permissions: map[string]string{"x": "read", "y": "write"}}
	b := TokenScope{Repositories: []string{"a", "b"}, Permissions: map[string]string{"y": "write", "x": "read"}}
	if a.Key(1) != b.Key(1) || a.Key(1) == a.Key(2) {
		t.Fatalf("scope keys are not canonical: %q %q", a.Key(1), b.Key(1))
	}
}

func TestRevokeTokenUsesTheTokenItselfAndToleratesExpiredTokens(t *testing.T) {
	var mutex sync.Mutex
	var authorizations []string
	status := http.StatusNoContent
	client := testScopedClient(t, func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodDelete || request.URL.Path != "/api/v3/installation/token" {
			t.Errorf("unexpected request %s %s", request.Method, request.URL.Path)
		}
		mutex.Lock()
		authorizations = append(authorizations, request.Header.Get("Authorization"))
		mutex.Unlock()
		response.WriteHeader(status)
	})
	token := NewScopedToken("ghs_revoke", 9, time.Now().Add(time.Hour))
	if err := client.RevokeToken(context.Background(), token); err != nil {
		t.Fatal(err)
	}
	status = http.StatusUnauthorized
	if err := client.RevokeToken(context.Background(), token); err != nil {
		t.Fatalf("revoking an already invalid token: %v", err)
	}
	status = http.StatusInternalServerError
	if err := client.RevokeToken(context.Background(), token); err == nil || strings.Contains(err.Error(), "ghs_revoke") {
		t.Fatalf("server failure error = %v", err)
	}
	if len(authorizations) != 3 || authorizations[0] != "token ghs_revoke" {
		t.Fatalf("authorizations = %#v", authorizations)
	}
	if err := client.RevokeToken(context.Background(), ScopedToken{}); err != nil {
		t.Fatalf("empty token revoke: %v", err)
	}
}

func TestFindRepositoryInstallationAndCollaboratorPermission(t *testing.T) {
	client := testScopedClient(t, func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/api/v3/repos/octo/api/installation":
			_, _ = response.Write([]byte(`{"id":77}`))
		case "/api/v3/repos/octo/missing/installation":
			response.WriteHeader(http.StatusNotFound)
			_, _ = response.Write([]byte(`{"message":"Not Found"}`))
		case "/api/v3/repos/octo/api/collaborators/mona/permission":
			if request.Header.Get("Authorization") != "token ghs_read" {
				t.Errorf("permission read must use the scoped token")
			}
			_, _ = response.Write([]byte(`{"permission":"write","role_name":"maintain"}`))
		case "/api/v3/app":
			_, _ = response.Write([]byte(`{"slug":"cao-app"}`))
		case "/api/v3/users/cao-app[bot]":
			_, _ = response.Write([]byte(`{"id":4242,"login":"cao-app[bot]"}`))
		default:
			t.Errorf("unexpected path %s", request.URL.Path)
			response.WriteHeader(http.StatusNotFound)
		}
	})
	id, err := client.FindRepositoryInstallation(context.Background(), "octo/api")
	if err != nil || id != 77 {
		t.Fatalf("installation = %d, %v", id, err)
	}
	if _, err := client.FindRepositoryInstallation(context.Background(), "octo/missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing installation error = %v", err)
	}
	if _, err := client.FindRepositoryInstallation(context.Background(), "octo"); err == nil {
		t.Fatal("invalid repository accepted")
	}
	role, err := client.CollaboratorPermission(context.Background(), NewScopedToken("ghs_read", 77, time.Now().Add(time.Hour)), "octo/api", "mona")
	if err != nil || role != "write" {
		t.Fatalf("role = %q, %v", role, err)
	}
	identity, err := client.BotIdentity(context.Background())
	if err != nil || identity.Name != "cao-app[bot]" || identity.Email != "4242+cao-app[bot]@users.noreply.github.com" {
		t.Fatalf("identity = %#v, %v", identity, err)
	}
}

func TestMintScopedTokenRevokesAndRejectsOverBroadGrants(t *testing.T) {
	for name, granted := range map[string]string{
		"extra permission":   `"permissions":{"contents":"read","administration":"write"},"repositories":[{"name":"api"}]`,
		"escalated level":    `"permissions":{"contents":"write"},"repositories":[{"name":"api"}]`,
		"extra repository":   `"permissions":{"contents":"read"},"repositories":[{"name":"api"},{"name":"other"}]`,
		"missing grant info": `"repositories":[{"name":"api"}]`,
		"all repositories":   `"permissions":{"contents":"read"}`,
	} {
		t.Run(name, func(t *testing.T) {
			revoked := false
			client := testScopedClient(t, func(response http.ResponseWriter, request *http.Request) {
				if request.Method == http.MethodDelete && request.URL.Path == "/api/v3/installation/token" {
					revoked = request.Header.Get("Authorization") == "token ghs_broad"
					response.WriteHeader(http.StatusNoContent)
					return
				}
				response.Header().Set("Content-Type", "application/json")
				response.WriteHeader(http.StatusCreated)
				_, _ = fmt.Fprintf(response, `{"token":"ghs_broad","expires_at":%q,%s}`, time.Now().Add(time.Hour).UTC().Format(time.RFC3339), granted)
			})
			_, err := client.MintScopedToken(context.Background(), 9, TokenScope{
				Repositories: []string{"api"}, Permissions: map[string]string{"contents": "read"},
			})
			if err == nil || strings.Contains(err.Error(), "ghs_broad") {
				t.Fatalf("over-broad grant must fail without leaking: %v", err)
			}
			if !revoked {
				t.Fatal("over-broad token must be revoked immediately")
			}
		})
	}
}

func TestScopedTokenHashedMatchesGitHubAuditFormat(t *testing.T) {
	token := NewScopedToken("ghs_example", 1, time.Now())
	// base64(sha256("ghs_example"))
	if got := token.Hashed(); got == "" || strings.Contains(got, "ghs_example") || len(got) != 44 {
		t.Fatalf("hashed = %q", got)
	}
	if (ScopedToken{}).Hashed() != "" {
		t.Fatal("empty token must hash to empty")
	}
}
