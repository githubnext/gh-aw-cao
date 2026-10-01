package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/query"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

func TestRepositoryRoleAuthorizationCachesAndRevalidatesETag(t *testing.T) {
	var calls atomic.Int32
	role := "admin"
	tag := `"version-1"`
	api := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		if request.URL.Path != "/repos/owner/control/collaborators/reader/permission" ||
			strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer ") != "test-token" {
			t.Errorf("unexpected permission request: %s", request.URL.Path)
			response.WriteHeader(http.StatusForbidden)
			return
		}
		if request.Header.Get("If-None-Match") == tag {
			response.WriteHeader(http.StatusNotModified)
			return
		}
		response.Header().Set("ETag", tag)
		_, _ = response.Write([]byte(`{"permission":"` + role + `"}`))
	}))
	defer api.Close()
	oauth := newGitHubOAuth(GitHubOAuthConfig{
		SessionSecret:           strings.Repeat("s", 32),
		RepositoryPermissionURL: api.URL + "/repos/{owner}/{repo}/collaborators/{user}/permission",
	}, nil)
	app := &App{oauth: oauth, config: Config{AdminRepository: "owner/control"}}
	request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/v1/query", nil)
	request = request.WithContext(context.WithValue(request.Context(), oauthSessionContextKey{},
		oauthSession{ID: "session-1", Login: "reader", AccessToken: "test-token"}))
	first := app.adminAuthorized(request)
	second := app.adminAuthorized(request)
	if !first || !second || calls.Load() != 1 {
		t.Fatalf("admin role was not cached: calls=%d", calls.Load())
	}
	oauth.roleMu.Lock()
	entry := oauth.roles["session-1:owner/control"]
	entry.expires = time.Now().Add(-time.Second)
	oauth.roles["session-1:owner/control"] = entry
	oauth.roleMu.Unlock()
	if !app.adminAuthorized(request) || calls.Load() != 2 {
		t.Fatalf("ETag revalidation failed: calls=%d", calls.Load())
	}
	role, tag = "write", `"version-2"`
	oauth.roleMu.Lock()
	entry = oauth.roles["session-1:owner/control"]
	entry.expires = time.Now().Add(-time.Second)
	oauth.roles["session-1:owner/control"] = entry
	oauth.roleMu.Unlock()
	if app.adminAuthorized(request) || calls.Load() != 3 {
		t.Fatalf("revoked role remained authorized: calls=%d", calls.Load())
	}
}

func TestRepositoryRoleAuthorizationFailClosedAndQueryAvailability(t *testing.T) {
	role := "maintain"
	status := http.StatusOK
	api := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(status)
		_, _ = response.Write([]byte(`{"role_name":"` + role + `"}`))
	}))
	defer api.Close()
	address, closeRedis := fakeRedis(t)
	defer closeRedis()
	client, err := redisx.New("redis://" + address)
	if err != nil {
		t.Fatal(err)
	}
	oauth := newGitHubOAuth(GitHubOAuthConfig{
		SessionSecret:           strings.Repeat("s", 32),
		RepositoryPermissionURL: api.URL + "/repos/{owner}/{repo}/collaborators/{user}/permission",
	}, nil)
	app := &App{
		oauth: oauth, config: Config{AdminRepository: "owner/control"},
		store: redisx.NewStore(client, "repository-role-query"),
		quota: newUsageQuota(t, usageQuotaStore{samples: usageSamples(), now: usageNow}),
	}
	input := queryRequest{
		Queries: []query.Definition{
			{Name: "ingestion-queue-sizes", From: collectionHealthSourceName},
			{Name: "github-api-usage", From: gitHubQuotaUsageSourceName},
		},
		SourceNames: []string{"ingestion-queue-sizes", "github-api-usage"},
	}
	for _, test := range []struct {
		name, role string
		status     int
		available  bool
	}{
		{"maintainer", "maintain", http.StatusOK, true},
		{"administrator", "admin", http.StatusOK, true},
		{"writer", "write", http.StatusOK, false},
		{"not a collaborator", "", http.StatusNotFound, false},
		{"GitHub failure", "", http.StatusServiceUnavailable, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			role, status = test.role, test.status
			request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/api/v1/query", nil)
			request = request.WithContext(context.WithValue(request.Context(), oauthSessionContextKey{},
				oauthSession{ID: test.name, Login: "reader", AccessToken: "test-token"}))
			body, err := json.Marshal(input)
			if err != nil {
				t.Fatal(err)
			}
			request.Body = io.NopCloser(bytes.NewReader(body))
			response := httptest.NewRecorder()
			app.query(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("query status=%d body=%s", response.Code, response.Body.String())
			}
			var result queryResponse
			if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			for _, name := range input.SourceNames {
				want := "unavailable"
				if test.available {
					want = "available"
				}
				if got := result.Sources[name].Metadata["availability"]; got != want {
					t.Errorf("%s availability=%v, want %s", name, got, want)
				}
			}
		})
	}
}
