package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

func TestAzureModeRequiresCompleteGitHubOAuthPolicy(t *testing.T) {
	address, closeServer := fakeRedis(t)
	defer closeServer()
	client, err := redisx.New("redis://" + address)
	if err != nil {
		t.Fatal(err)
	}
	site := t.TempDir()
	if err := os.WriteFile(site+"/index.html", []byte("<html><head></head></html>"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = New(redisx.NewStore(client, "test"), Config{
		HostingMode:   HostingModeAzureFunctions,
		SiteDirectory: site,
		AccessToken:   testAccessToken,
		AzureProxy:    AzureProxyPolicy{AllowedHosts: []string{"dashboard.example.com"}, RequireHTTPS: true},
		GitHubOAuth:   validOAuthConfig("https://github.test"),
	})
	if err == nil || !strings.Contains(err.Error(), "does not support local bearer") {
		t.Fatalf("expected bearer rejection in Azure mode, got %v", err)
	}

	_, err = New(redisx.NewStore(client, "test"), Config{
		HostingMode:   HostingModeAzureFunctions,
		SiteDirectory: site,
		AzureProxy:    AzureProxyPolicy{AllowedHosts: []string{"dashboard.example.com"}, RequireHTTPS: true},
		GitHubOAuth: &GitHubOAuthConfig{
			ClientID:      "client",
			ClientSecret:  "secret",
			RedirectURL:   "https://dashboard.example.com/auth/callback",
			SessionSecret: "0123456789abcdef0123456789abcdef",
		},
	})
	if err == nil || !strings.Contains(err.Error(), "authorization requires") {
		t.Fatalf("expected explicit authorization policy rejection, got %v", err)
	}
}

func TestAzureOAuthLoginCallbackAndAuthorizedAPI(t *testing.T) {
	github := fakeGitHub(t, fakeGitHubOptions{membershipState: "active", accessExpiresIn: 3600})
	app := newAzureTestApp(t, github.URL)

	login := httptest.NewRecorder()
	request := azureRequest(t, http.MethodGet, "/auth/login")
	app.Handler().ServeHTTP(login, request)
	if login.Code != http.StatusFound {
		t.Fatalf("login returned %d: %s", login.Code, login.Body.String())
	}
	stateCookie := firstCookie(t, login.Result(), "cao_oauth_state")
	location, err := url.Parse(login.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	state := location.Query().Get("state")
	if state == "" || location.Query().Get("scope") != "read:org" {
		t.Fatalf("unexpected login redirect: %s", location.String())
	}

	callback := httptest.NewRecorder()
	request = azureRequest(t, http.MethodGet, "/auth/callback?code=code-1&state="+url.QueryEscape(state))
	request.AddCookie(stateCookie)
	app.Handler().ServeHTTP(callback, request)
	if callback.Code != http.StatusFound {
		t.Fatalf("callback returned %d: %s", callback.Code, callback.Body.String())
	}
	forbidden := callback.Header().Values("Set-Cookie")
	if strings.Contains(strings.Join(forbidden, "\n"), "access-") || strings.Contains(strings.Join(forbidden, "\n"), "refresh-") {
		t.Fatalf("token leaked to cookie: %v", forbidden)
	}
	sessionCookie := firstCookie(t, callback.Result(), sessionCookieName)
	if !sessionCookie.HttpOnly || !sessionCookie.Secure || sessionCookie.SameSite != http.SameSiteLaxMode {
		t.Fatalf("session cookie is not secure: %#v", sessionCookie)
	}
	csrfCookie := firstCookie(t, callback.Result(), csrfCookieName)
	if csrfCookie.HttpOnly || !csrfCookie.Secure {
		t.Fatalf("csrf cookie has unexpected flags: %#v", csrfCookie)
	}

	unauthorized := httptest.NewRecorder()
	request = azureRequest(t, http.MethodPost, "/api/v1/refresh")
	request.Header.Set("Authorization", "Bearer "+testAccessToken)
	app.Handler().ServeHTTP(unauthorized, request)
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("Azure mode accepted bearer-only request: %d", unauthorized.Code)
	}

	authorized := httptest.NewRecorder()
	request = azureRequest(t, http.MethodPost, "/api/v1/refresh")
	request.AddCookie(sessionCookie)
	request.AddCookie(csrfCookie)
	request.Header.Set("X-CSRF-Token", csrfCookie.Value)
	app.Handler().ServeHTTP(authorized, request)
	if authorized.Code != http.StatusOK {
		t.Fatalf("authorized refresh returned %d: %s", authorized.Code, authorized.Body.String())
	}
}

func TestAzureOAuthRejectsInvalidStateAndDeniedMembership(t *testing.T) {
	github := fakeGitHub(t, fakeGitHubOptions{membershipState: "active", accessExpiresIn: 3600})
	app := newAzureTestApp(t, github.URL)
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, azureRequest(t, http.MethodGet, "/auth/callback?code=code-1&state=bad"))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid state returned %d", response.Code)
	}

	deniedGitHub := fakeGitHub(t, fakeGitHubOptions{membershipState: "pending", accessExpiresIn: 3600})
	app = newAzureTestApp(t, deniedGitHub.URL)
	stateCookie, state := loginState(t, app)
	response = httptest.NewRecorder()
	request := azureRequest(t, http.MethodGet, "/auth/callback?code=code-1&state="+url.QueryEscape(state))
	request.AddCookie(stateCookie)
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("denied membership returned %d: %s", response.Code, response.Body.String())
	}
	if len(response.Result().Cookies()) != 1 {
		t.Fatalf("denied callback should only clear state cookie, got %#v", response.Result().Cookies())
	}
}

func TestAzureOAuthRefreshRotationLogoutAndRefreshFailure(t *testing.T) {
	github := fakeGitHub(t, fakeGitHubOptions{membershipState: "active", accessExpiresIn: -60, refreshSucceeds: true})
	app := newAzureTestApp(t, github.URL)
	sessionCookie, csrfCookie := callbackSession(t, app)

	refreshed := httptest.NewRecorder()
	request := azureRequest(t, http.MethodPost, "/api/v1/refresh")
	request.AddCookie(sessionCookie)
	request.AddCookie(csrfCookie)
	request.Header.Set("X-CSRF-Token", csrfCookie.Value)
	app.Handler().ServeHTTP(refreshed, request)
	if refreshed.Code != http.StatusOK {
		t.Fatalf("refresh rotation request returned %d: %s", refreshed.Code, refreshed.Body.String())
	}

	logout := httptest.NewRecorder()
	request = azureRequest(t, http.MethodPost, "/auth/logout")
	request.AddCookie(sessionCookie)
	request.AddCookie(csrfCookie)
	request.Header.Set("X-CSRF-Token", csrfCookie.Value)
	app.Handler().ServeHTTP(logout, request)
	if logout.Code != http.StatusNoContent {
		t.Fatalf("logout returned %d", logout.Code)
	}
	if !github.sawRevocation("access-new") || !github.sawRevocation("refresh-new") {
		t.Fatalf("logout did not revoke rotated tokens: %#v", github.revoked)
	}

	failingGitHub := fakeGitHub(t, fakeGitHubOptions{membershipState: "active", accessExpiresIn: -60, refreshSucceeds: false})
	app = newAzureTestApp(t, failingGitHub.URL)
	sessionCookie, csrfCookie = callbackSession(t, app)
	failed := httptest.NewRecorder()
	request = azureRequest(t, http.MethodPost, "/api/v1/refresh")
	request.AddCookie(sessionCookie)
	request.AddCookie(csrfCookie)
	request.Header.Set("X-CSRF-Token", csrfCookie.Value)
	app.Handler().ServeHTTP(failed, request)
	if failed.Code != http.StatusUnauthorized {
		t.Fatalf("refresh failure returned %d: %s", failed.Code, failed.Body.String())
	}
}

func TestAzureProxyPolicyFailsClosed(t *testing.T) {
	app := newAzureTestApp(t, fakeGitHub(t, fakeGitHubOptions{membershipState: "active", accessExpiresIn: 3600}).URL)
	response := httptest.NewRecorder()
	request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "https://evil.example/api/v1/health", nil)
	request.Host = "evil.example"
	request.Header.Set("X-Forwarded-Proto", "https")
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusMisdirectedRequest {
		t.Fatalf("unexpected proxy rejection status: %d", response.Code)
	}
}

type fakeGitHubOptions struct {
	membershipState string
	accessExpiresIn int64
	refreshSucceeds bool
}

type fakeGitHubServer struct {
	*httptest.Server
	revoked []string
}

func fakeGitHub(t *testing.T, options fakeGitHubOptions) *fakeGitHubServer {
	t.Helper()
	server := &fakeGitHubServer{}
	mux := http.NewServeMux()
	mux.HandleFunc("/login/oauth/access_token", func(response http.ResponseWriter, request *http.Request) {
		if err := request.ParseForm(); err != nil {
			t.Error(err)
			response.WriteHeader(http.StatusBadRequest)
			return
		}
		if request.Form.Get("grant_type") == "refresh_token" {
			if !options.refreshSucceeds {
				response.WriteHeader(http.StatusUnauthorized)
				return
			}
			// #nosec G117 -- test fixture intentionally models GitHub's token endpoint JSON.
			_ = json.NewEncoder(response).Encode(tokenResponse{AccessToken: "access-new", RefreshToken: "refresh-new", ExpiresIn: 3600, RefreshTokenExpiresIn: 7200})
			return
		}
		// #nosec G117 -- test fixture intentionally models GitHub's token endpoint JSON.
		_ = json.NewEncoder(response).Encode(tokenResponse{AccessToken: "access-old", RefreshToken: "refresh-old", ExpiresIn: options.accessExpiresIn, RefreshTokenExpiresIn: 7200})
	})
	mux.HandleFunc("/user", func(response http.ResponseWriter, request *http.Request) {
		_ = json.NewEncoder(response).Encode(map[string]string{"login": "octocat"})
	})
	mux.HandleFunc("/user/memberships/orgs/example", func(response http.ResponseWriter, request *http.Request) {
		_ = json.NewEncoder(response).Encode(map[string]string{"state": options.membershipState})
	})
	mux.HandleFunc("/applications/client/token", func(response http.ResponseWriter, request *http.Request) {
		var payload map[string]string
		_ = json.NewDecoder(request.Body).Decode(&payload)
		server.revoked = append(server.revoked, payload["access_token"])
		response.WriteHeader(http.StatusNoContent)
	})
	server.Server = httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server
}

func (server *fakeGitHubServer) sawRevocation(token string) bool {
	for _, candidate := range server.revoked {
		if candidate == token {
			return true
		}
	}
	return false
}

func newAzureTestApp(t *testing.T, githubURL string) *App {
	t.Helper()
	address, closeServer := fakeRedis(t)
	t.Cleanup(closeServer)
	client, err := redisx.New("redis://" + address)
	if err != nil {
		t.Fatal(err)
	}
	site := t.TempDir()
	if err := os.WriteFile(site+"/index.html", []byte("<html><head></head></html>"), 0o600); err != nil {
		t.Fatal(err)
	}
	config := Config{
		HostingMode:   HostingModeAzureFunctions,
		SiteDirectory: site,
		AzureProxy:    AzureProxyPolicy{AllowedHosts: []string{"dashboard.example.com"}, RequireHTTPS: true},
		GitHubOAuth:   validOAuthConfig(githubURL),
	}
	app, err := New(redisx.NewStore(client, "test"), config)
	if err != nil {
		t.Fatal(err)
	}
	return app
}

func validOAuthConfig(baseURL string) *GitHubOAuthConfig {
	return &GitHubOAuthConfig{
		ClientID:             "client",
		ClientSecret:         "secret",
		RedirectURL:          "https://dashboard.example.com/auth/callback",
		SessionSecret:        "0123456789abcdef0123456789abcdef",
		AllowedOrganizations: []string{"example"},
		AuthURL:              baseURL + "/login/oauth/authorize",
		TokenURL:             baseURL + "/login/oauth/access_token",
		UserURL:              baseURL + "/user",
		OrgMembershipURL:     baseURL + "/user/memberships/orgs/{org}",
		RevokeURL:            baseURL + "/applications/{client_id}/token",
	}
}

func azureRequest(t *testing.T, method, path string) *http.Request {
	t.Helper()
	request := httptest.NewRequestWithContext(t.Context(), method, "https://dashboard.example.com"+path, strings.NewReader(""))
	request.Host = "dashboard.example.com"
	request.Header.Set("X-Forwarded-Host", "dashboard.example.com")
	request.Header.Set("X-Forwarded-Proto", "https")
	return request
}

func loginState(t *testing.T, app *App) (*http.Cookie, string) {
	t.Helper()
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, azureRequest(t, http.MethodGet, "/auth/login"))
	location, err := url.Parse(response.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	return firstCookie(t, response.Result(), "cao_oauth_state"), location.Query().Get("state")
}

func callbackSession(t *testing.T, app *App) (*http.Cookie, *http.Cookie) {
	t.Helper()
	stateCookie, state := loginState(t, app)
	response := httptest.NewRecorder()
	request := azureRequest(t, http.MethodGet, "/auth/callback?code=code-1&state="+url.QueryEscape(state))
	request.AddCookie(stateCookie)
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusFound {
		t.Fatalf("callback returned %d: %s", response.Code, response.Body.String())
	}
	return firstCookie(t, response.Result(), sessionCookieName), firstCookie(t, response.Result(), csrfCookieName)
}

func firstCookie(t *testing.T, response *http.Response, name string) *http.Cookie {
	t.Helper()
	for _, cookie := range response.Cookies() {
		if cookie.Name == name {
			return cookie
		}
	}
	t.Fatalf("missing cookie %s in %#v", name, response.Cookies())
	return nil
}
