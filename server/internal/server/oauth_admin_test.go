package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

func TestRepositoryAdminAuthorization(t *testing.T) {
	for _, test := range []struct {
		name   string
		status int
		body   string
		admin  bool
		branch string
	}{
		{"admin", 200, `{"id":42,"full_name":"example/control","permissions":{"admin":true}}`, true, "admin.repository_allowed"},
		{"maintainer", 200, `{"id":42,"full_name":"EXAMPLE/CONTROL","permissions":{"maintain":true}}`, true, "admin.repository_allowed"},
		{"writer", 200, `{"id":42,"full_name":"example/control","permissions":{"push":true}}`, false, "admin.repository_denied"},
		{"reader", 200, `{"id":42,"full_name":"example/control","permissions":{"pull":true}}`, false, "admin.repository_denied"},
		{"triage", 200, `{"id":42,"full_name":"example/control","permissions":{"triage":true}}`, false, "admin.repository_denied"},
		{"missing permissions", 200, `{"id":42,"full_name":"example/control"}`, false, "admin.repository_permissions_missing"},
		{"wrong repository", 200, `{"id":42,"full_name":"example/target","permissions":{"admin":true}}`, false, "admin.repository_permissions_missing"},
		{"reused repository name", 200, `{"id":43,"full_name":"example/control","permissions":{"admin":true}}`, false, "admin.repository_permissions_missing"},
		{"missing repository ID", 200, `{"full_name":"example/control","permissions":{"admin":true}}`, false, "admin.repository_permissions_missing"},
		{"unauthorized", 401, `{}`, false, "admin.repository_request_failed"},
		{"forbidden", 403, `{}`, false, "admin.repository_request_failed"},
		{"not found", 404, `{}`, false, "admin.repository_request_failed"},
		{"rate limited", 429, `{}`, false, "admin.repository_request_failed"},
		{"unavailable", 503, `{}`, false, "admin.repository_request_failed"},
		{"malformed", 200, `{`, false, "admin.repository_request_failed"},
		{"invalid permission", 200, `{"id":42,"full_name":"example/control","permissions":{"admin":"true"}}`, false, "admin.repository_request_failed"},
	} {
		t.Run(test.name, func(t *testing.T) {
			github := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				if request.Method != http.MethodGet || request.URL.Path != "/repos/example/control" ||
					request.Header.Get("Authorization") != "Bearer user-token" {
					t.Errorf("unexpected repository permission request: %s %s", request.Method, request.URL.Path)
				}
				response.WriteHeader(test.status)
				_, _ = response.Write([]byte(test.body))
			}))
			defer github.Close()
			config := validOAuthConfig(github.URL)
			config.WorkspaceRepository = "example/control"
			config.WorkspaceRepositoryID = 42
			config.RepositoryURL = github.URL + "/repos/{owner}/{repo}"
			if err := config.validate(); err != nil {
				t.Fatal(err)
			}
			oauth := adminOAuthWithStore(t, config)
			var branch string
			oauth.log = func(value string) { branch = value }
			session := oauthSession{Login: "user", AccessToken: "user-token", Admin: true, AuthorizedAt: time.Now()}
			oauth.updateAdminAuthorization(t.Context(), &session)
			if session.Admin != test.admin || session.AdminRepository != "example/control" || branch != test.branch {
				t.Fatalf("admin=%t repository=%s branch=%s", session.Admin, session.AdminRepository, branch)
			}
			app := &App{oauth: oauth}
			request := httptest.NewRequestWithContext(
				context.WithValue(t.Context(), oauthSessionContextKey{}, session),
				http.MethodGet, "/api/admin/collection/status", nil,
			)
			if app.adminAuthorized(request) != test.admin {
				t.Fatal("admin resource authorization did not use the repository role")
			}
		})
	}
}

func TestRepositoryAdminConfiguration(t *testing.T) {
	for _, repository := range []string{"example/control", " EXAMPLE/control ", ""} {
		config := validOAuthConfig("https://github.test")
		config.WorkspaceRepository = repository
		config.WorkspaceRepositoryID = 42
		if err := config.validate(); err != nil {
			t.Fatalf("valid repository %q rejected: %v", repository, err)
		}
		if config.RepositoryURL != "https://api.github.com/repos/{owner}/{repo}" ||
			config.WorkspaceRepository != strings.TrimSpace(repository) {
			t.Fatal("repository configuration was not normalized")
		}
	}
	for _, repository := range []string{"owner", "/repo", "owner/", "owner/repo/extra", "../repo", "owner/.", "owner/..", "owner/repo?admin=true", "owner/repo#fragment", "owner/re po"} {
		config := validOAuthConfig("https://github.test")
		config.WorkspaceRepository = repository
		config.WorkspaceRepositoryID = 42
		if err := config.validate(); err == nil {
			t.Fatalf("invalid repository %q accepted", repository)
		}
	}
}

func TestRepositoryAdminFailsClosedWithoutAuthority(t *testing.T) {
	oauth := newGitHubOAuth(GitHubOAuthConfig{WorkspaceRepository: "example/control", WorkspaceRepositoryID: 42}, nil)
	oauth.log = nil
	session := oauthSession{Login: "operator", Admin: true, AuthorizedAt: time.Now(), AdminRepository: "example/control", AdminRepositoryID: 42}
	oauth.updateAdminAuthorization(t.Context(), &session)
	if session.Admin {
		t.Fatal("session without a user token retained administrator authority")
	}
	app := &App{oauth: oauth}
	request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/", nil)
	if app.adminAuthorized(request) {
		t.Fatal("missing session granted administrator authority")
	}
	for _, test := range []oauthSession{
		{Admin: true, AuthorizedAt: time.Now(), AdminRepository: "example/other"},
		{Admin: true, AuthorizedAt: time.Now().Add(-authorizationRecheckInterval), AdminRepository: "example/control"},
		{Admin: true, AuthorizedAt: time.Now()},
	} {
		request = request.WithContext(context.WithValue(t.Context(), oauthSessionContextKey{}, test))
		if app.adminAuthorized(request) {
			t.Fatal("stale or unbound repository authority was accepted")
		}
	}
	oauth.config.WorkspaceRepository = ""
	session.Admin = true
	oauth.updateAdminAuthorization(t.Context(), &session)
	request = request.WithContext(context.WithValue(t.Context(), oauthSessionContextKey{}, session))
	if session.Admin || app.adminAuthorized(request) {
		t.Fatal("unconfigured repository granted administrator authority")
	}
	if !(&App{}).adminAuthorized(httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/", nil)) {
		t.Fatal("local bearer capability lost administrator authority")
	}
}

func TestRepositoryAdminRequestCancellationDeniesAccess(t *testing.T) {
	oauth := adminRoleTestOAuth(t)
	session := adminRoleTestSession(t, oauth, "operator", "operator-token")
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	oauth.updateAdminAuthorization(ctx, &session)
	if session.Admin {
		t.Fatal("failed role check retained previously granted administrator authority")
	}
}

func adminRoleTestOAuth(t *testing.T) *githubOAuth {
	t.Helper()
	github := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		body := `{"id":42,"full_name":"example/control","permissions":{"push":true}}`
		if request.Header.Get("Authorization") == "Bearer operator-token" {
			body = `{"id":42,"full_name":"example/control","permissions":{"maintain":true}}`
		}
		_, _ = response.Write([]byte(body))
	}))
	t.Cleanup(github.Close)
	config := validOAuthConfig(github.URL)
	config.WorkspaceRepository = "example/control"
	config.WorkspaceRepositoryID = 42
	config.RepositoryURL = github.URL + "/repos/{owner}/{repo}"
	if err := config.validate(); err != nil {
		t.Fatal(err)
	}
	return adminOAuthWithStore(t, config)
}

func adminOAuthWithStore(t *testing.T, config *GitHubOAuthConfig) *githubOAuth {
	t.Helper()
	address, closeServer := fakeRedis(t)
	t.Cleanup(closeServer)
	client, err := redisx.New("redis://" + address)
	if err != nil {
		t.Fatal(err)
	}
	return newGitHubOAuth(*config, redisx.NewStore(client, "admin-test"))
}

func adminRoleTestSession(t *testing.T, oauth *githubOAuth, login, token string) oauthSession {
	t.Helper()
	session := oauthSession{Login: login, AccessToken: token, AuthorizedAt: time.Now()}
	oauth.updateAdminAuthorization(t.Context(), &session)
	return session
}

func TestOAuthSessionRechecksRepositoryAdminRole(t *testing.T) {
	for _, test := range []struct {
		name    string
		refresh bool
		status  int
		gain    bool
	}{
		{name: "role removed"},
		{name: "role check unavailable", status: http.StatusServiceUnavailable},
		{name: "role removed on token refresh", refresh: true},
		{name: "role gained", gain: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			github := fakeGitHub(t, fakeGitHubOptions{
				membershipState: "active", accessExpiresIn: 3600, refreshSucceeds: true,
			})
			app := newAzureTestApp(t, github.URL)
			app.oauth.config.WorkspaceRepository = "example/control"
			app.oauth.config.WorkspaceRepositoryID = 42
			app.oauth.config.RepositoryURL = github.URL + "/repos/{owner}/{repo}"
			github.repositoryPermissions = map[string]bool{"maintain": true}
			if test.gain {
				github.repositoryPermissions = map[string]bool{"pull": true}
			}
			cookie, csrf := callbackSession(t, app)
			request := azureRequest(t, http.MethodGet, "/api/admin/collection/status")
			request.AddCookie(cookie)
			request.AddCookie(csrf)
			check := func(want int) {
				t.Helper()
				response := httptest.NewRecorder()
				app.Handler().ServeHTTP(response, request)
				if response.Code != want {
					t.Fatalf("admin resource returned %d, want %d: %s", response.Code, want, response.Body.String())
				}
			}
			if test.gain {
				check(http.StatusForbidden)
			} else {
				check(http.StatusOK)
			}
			if github.repositoryRequests != 1 {
				t.Fatal("fresh sessions must reuse their checked repository authority")
			}
			github.repositoryPermissions = map[string]bool{"push": true}
			if test.gain {
				github.repositoryPermissions = map[string]bool{"admin": true}
			}
			github.repositoryStatus = test.status
			session, err := app.oauth.loadSession(t.Context(), cookie.Value)
			if err != nil {
				t.Fatal(err)
			}
			if test.refresh {
				session.AccessExpires = time.Now().Add(-time.Minute)
			} else {
				session.AuthorizedAt = time.Now().Add(-authorizationRecheckInterval)
			}
			if err := app.oauth.saveSession(t.Context(), session); err != nil {
				t.Fatal(err)
			}
			if test.gain {
				check(http.StatusOK)
			} else {
				check(http.StatusForbidden)
			}
			session, err = app.oauth.loadSession(t.Context(), cookie.Value)
			if err != nil || session.Admin != test.gain || github.repositoryRequests != 2 {
				t.Fatalf("repository authority was not refreshed: admin=%t checks=%d err=%v", session.Admin, github.repositoryRequests, err)
			}
			response := httptest.NewRecorder()
			reader := azureRequest(t, http.MethodGet, "/api/auth/session")
			reader.AddCookie(cookie)
			app.Handler().ServeHTTP(response, reader)
			if response.Code != http.StatusOK {
				t.Fatal("repository role denial must preserve ordinary dashboard access")
			}
			if test.refresh && github.repositoryToken != "Bearer access-new" {
				t.Fatal("repository check did not use the refreshed user token")
			}
		})
	}
}

func TestOAuthSessionRechecksChangedAdminRepository(t *testing.T) {
	github := fakeGitHub(t, fakeGitHubOptions{membershipState: "active", accessExpiresIn: 3600})
	app := newAzureTestApp(t, github.URL)
	cookie, csrf := callbackSession(t, app)
	github.repositoryPermissions = map[string]bool{"admin": true}
	app.oauth.config.WorkspaceRepository = "example/control"
	app.oauth.config.WorkspaceRepositoryID = 42
	app.oauth.config.RepositoryURL = github.URL + "/repos/{owner}/{repo}"
	request := azureRequest(t, http.MethodGet, "/api/admin/collection/status")
	request.AddCookie(cookie)
	request.AddCookie(csrf)
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK || github.repositoryRequests != 1 {
		t.Fatal("existing session did not acquire checked repository authority")
	}
	app.oauth.config.WorkspaceRepository = "example/other"
	response = httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatal("changed repository retained the previous repository's administrator authority")
	}
	session, err := app.oauth.loadSession(t.Context(), cookie.Value)
	if err != nil || session.Admin || session.AdminRepository != "example/other" {
		t.Fatal("changed repository was not saved with denied administrator authority")
	}
}
