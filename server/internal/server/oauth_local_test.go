package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-cao/server/internal/operational/memory"
)

func localOAuthConfig(t *testing.T, githubURL string) Config {
	t.Helper()
	profile := hostedHostProfile()
	profile.SingleProcess, profile.SingleReplica = true, true
	oauth := validOAuthConfig(githubURL)
	oauth.LocalDevelopmentUser = "octocat"
	oauth.AllowedOrganizations = nil
	oauth.RedirectURL = "https://127.0.0.1:8443/auth/callback"
	return Config{
		Database: constructorDatabase(), SiteDirectory: hostedTestSite(t), HostProfile: profile,
		Listen: "127.0.0.1:8443", CertFile: "certificate.pem", KeyFile: "key.pem",
		SingleReplicaConfirmed: true, AllowVolatile: true,
		Proxy:       ProxyPolicy{AllowedHosts: []string{"127.0.0.1"}, RequireHTTPS: true},
		GitHubOAuth: oauth, AdminUsers: []string{"octocat"},
	}
}

func localOAuthApp(t *testing.T, githubURL string) *App {
	t.Helper()
	return localOAuthAppWithConfig(t, localOAuthConfig(t, githubURL))
}

func localOAuthAppWithConfig(t *testing.T, config Config) *App {
	t.Helper()
	store, err := memory.New(memory.Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	app, err := New(t.Context(), focusedTestStore(store), config)
	if err != nil {
		t.Fatal(err)
	}
	return app
}

func localOAuthRequest(t *testing.T, path string) *http.Request {
	t.Helper()
	request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "https://127.0.0.1:8443"+path, nil)
	request.RemoteAddr = "127.0.0.1:12345"
	return request
}

func localOAuthCallback(t *testing.T, app *App, consent bool, session *http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	path := "/auth/login"
	if consent {
		path += "?hosted_cli=1"
	}
	request := localOAuthRequest(t, path)
	if session != nil {
		request.AddCookie(session)
	}
	login := httptest.NewRecorder()
	app.Handler().ServeHTTP(login, request)
	if login.Code != http.StatusFound {
		t.Fatalf("local login = %d: %s", login.Code, login.Body.String())
	}
	location, err := url.Parse(login.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	want := "read:user"
	if consent {
		want += " repo"
	}
	if strings.HasPrefix(app.oauth.config.ClientID, "Iv") {
		want = "offline_access"
	}
	if location.Query().Get("scope") != want {
		t.Fatalf("local OAuth scope = %q, want %q", location.Query().Get("scope"), want)
	}
	authorizeFakeGitHub(t, app, location.String())
	callback := localOAuthRequest(t, "/auth/callback?code=code-1&state="+url.QueryEscape(location.Query().Get("state")))
	callback.AddCookie(firstCookie(t, login.Result(), "cao_oauth_state"))
	if session != nil {
		callback.AddCookie(session)
	}
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, callback)
	return response
}

func TestLocalOAuthDeveloperNeedsNoOrganizationAccess(t *testing.T) {
	for _, clientID := range []string{"client", "Iv23liGitHubApp"} {
		t.Run(clientID, func(t *testing.T) {
			github := fakeGitHub(t, fakeGitHubOptions{
				membershipState: "inactive", accessExpiresIn: 3600, appDisclosesTwoFactor: true,
			})
			app := localOAuthApp(t, github.URL)
			app.oauth.config.ClientID = clientID
			response := localOAuthCallback(t, app, false, nil)
			if response.Code != http.StatusFound {
				t.Fatalf("developer with no organization access could not log in: %d", response.Code)
			}
			cookie := firstCookie(t, response.Result(), sessionCookieName)
			session, err := app.oauth.loadSession(t.Context(), cookie.Value)
			if err != nil {
				t.Fatal(err)
			}
			if session.Login != "octocat" || session.GitHubID != 1 || session.LocalDevelopmentUser != "octocat" {
				t.Fatal("local OAuth did not bind the configured developer identity")
			}
			session.AuthorizedAt = time.Now().Add(-authorizationRecheckInterval)
			if err := app.oauth.saveSession(t.Context(), session); err != nil {
				t.Fatal(err)
			}
			request := localOAuthRequest(t, "/api/auth/session")
			request.AddCookie(cookie)
			account := httptest.NewRecorder()
			app.Handler().ServeHTTP(account, request)
			if account.Code != http.StatusOK {
				t.Fatalf("local session revalidation = %d", account.Code)
			}
			app.oauth.repositoryConsentAllowed = app.adminListed
			consent := localOAuthCallback(t, app, true, cookie)
			if consent.Code != http.StatusFound {
				t.Fatalf("local administrator consent = %d", consent.Code)
			}
			github.grantMu.Lock()
			defer github.grantMu.Unlock()
			if github.membershipRequests != 0 {
				t.Fatal("local developer login, revalidation, or consent queried organization membership")
			}
		})
	}
}

func TestLocalOAuthRejectsOtherAccountsAndPreservesAssurance(t *testing.T) {
	for _, test := range []struct {
		name, login string
		id          int64
	}{
		{name: "different developer", login: "another-user", id: 1},
		{name: "missing numeric identity", login: "octocat"},
	} {
		t.Run(test.name, func(t *testing.T) {
			github := fakeGitHub(t, fakeGitHubOptions{membershipState: "active", accessExpiresIn: 3600})
			app := localOAuthApp(t, github.URL)
			github.login, github.accountID = test.login, test.id
			response := localOAuthCallback(t, app, false, nil)
			if response.Code != http.StatusForbidden || !github.sawRevocation("access-old") {
				t.Fatal("local mode accepted an account other than the identified configured developer")
			}
		})
	}
	t.Run("no disclosed factor", func(t *testing.T) {
		github := fakeGitHub(t, fakeGitHubOptions{membershipState: "inactive", accessExpiresIn: 3600})
		github.twoFactor = nil
		app := localOAuthApp(t, github.URL)
		response := localOAuthCallback(t, app, false, nil)
		if response.Code != http.StatusFound {
			t.Fatal("ordinary local login must not require administrator assurance")
		}
		session, err := app.oauth.loadSession(t.Context(), firstCookie(t, response.Result(), sessionCookieName).Value)
		if err != nil {
			t.Fatal(err)
		}
		if app.adminAuthorizedContext(context.WithValue(t.Context(), oauthSessionContextKey{}, session)) {
			t.Fatal("local mode bypassed administrator assurance")
		}
	})
}

func TestLocalOAuthRefreshChecksDeveloperWithoutExtendingAssurance(t *testing.T) {
	github := fakeGitHub(t, fakeGitHubOptions{
		membershipState: "inactive", accessExpiresIn: -60, refreshSucceeds: true,
		appDisclosesTwoFactor: true,
	})
	app := localOAuthApp(t, github.URL)
	app.oauth.config.ClientID = "Iv23liGitHubApp"
	app.oauth.config.LocalDevelopmentUser = "OctoCat"
	callback := localOAuthCallback(t, app, false, nil)
	if callback.Code != http.StatusFound {
		t.Fatalf("local GitHub App login = %d", callback.Code)
	}
	cookie := firstCookie(t, callback.Result(), sessionCookieName)
	before, err := app.oauth.loadSession(t.Context(), cookie.Value)
	if err != nil {
		t.Fatal(err)
	}
	request := localOAuthRequest(t, "/api/auth/session")
	request.AddCookie(cookie)
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("local GitHub App token refresh = %d", response.Code)
	}
	after, err := app.oauth.loadSession(t.Context(), cookie.Value)
	if err != nil {
		t.Fatal(err)
	}
	if after.AccessToken != "access-new" || !after.AuthenticatedAt.Equal(before.AuthenticatedAt) ||
		after.LocalDevelopmentUser != before.LocalDevelopmentUser {
		t.Fatal("refresh did not preserve local identity and original authentication time")
	}
	github.grantMu.Lock()
	defer github.grantMu.Unlock()
	if github.membershipRequests != 0 {
		t.Fatal("local GitHub App token refresh queried organization membership")
	}
}

func TestLocalOAuthSessionsCannotCrossAuthorizationModes(t *testing.T) {
	for _, target := range []string{"", "another-user"} {
		t.Run("target="+target, func(t *testing.T) {
			github := fakeGitHub(t, fakeGitHubOptions{membershipState: "inactive", accessExpiresIn: 3600})
			app := localOAuthApp(t, github.URL)
			response := localOAuthCallback(t, app, false, nil)
			cookie := firstCookie(t, response.Result(), sessionCookieName)
			app.oauth.config.LocalDevelopmentUser = target
			if _, err := app.oauth.loadSession(t.Context(), cookie.Value); err == nil {
				t.Fatal("local session survived a change to hosted mode or another developer")
			}
			app.oauth.config.LocalDevelopmentUser = "octocat"
			session, err := app.oauth.loadSession(t.Context(), cookie.Value)
			if err != nil {
				t.Fatal(err)
			}
			session.LocalDevelopmentUser = ""
			if err := app.oauth.saveSession(t.Context(), session); err != nil {
				t.Fatal(err)
			}
			if _, err := app.oauth.loadSession(t.Context(), cookie.Value); err == nil {
				t.Fatal("ordinary hosted session was accepted as a local development session")
			}
		})
	}
}

func TestLocalOAuthConfigurationFailsClosed(t *testing.T) {
	for name, mutate := range map[string]func(*Config){
		"public listener":      func(c *Config) { c.Listen = "0.0.0.0:8443" },
		"private listener":     func(c *Config) { c.Listen = "192.168.1.2:8443" },
		"missing certificate":  func(c *Config) { c.CertFile = "" },
		"plaintext":            func(c *Config) { c.CertFile, c.KeyFile = "", "" },
		"HTTPS disabled":       func(c *Config) { c.Proxy.RequireHTTPS = false },
		"external host":        func(c *Config) { c.HostProfile.Listener = HostListenerExternal },
		"platform host":        func(c *Config) { c.HostProfile.Listener = HostListenerPlatform },
		"forwarded headers":    func(c *Config) { c.Proxy.TrustForwarded = true },
		"trusted proxy":        func(c *Config) { c.Proxy.TrustedProxyPrefixes = loopbackProxyPrefixes() },
		"public callback":      func(c *Config) { c.GitHubOAuth.RedirectURL = "https://dashboard.example.com/auth/callback" },
		"callback port":        func(c *Config) { c.GitHubOAuth.RedirectURL = "https://127.0.0.1:9443/auth/callback" },
		"callback path":        func(c *Config) { c.GitHubOAuth.RedirectURL = "https://127.0.0.1:8443/elsewhere" },
		"callback query":       func(c *Config) { c.GitHubOAuth.RedirectURL += "?x=1" },
		"callback credentials": func(c *Config) { c.GitHubOAuth.RedirectURL = "https://user@127.0.0.1:8443/auth/callback" },
		"public allowed host":  func(c *Config) { c.Proxy.AllowedHosts = []string{"dashboard.example.com"} },
		"multiple hosts":       func(c *Config) { c.Proxy.AllowedHosts = []string{"127.0.0.1", "localhost"} },
		"CORS":                 func(c *Config) { c.CORS.AllowedOrigins = []string{"https://example.com"} },
		"dynamic listen port":  func(c *Config) { c.Listen = "127.0.0.1:0" },
	} {
		t.Run(name, func(t *testing.T) {
			config := localOAuthConfig(t, "https://github.test")
			mutate(&config)
			if err := validateLocalDevelopmentOAuth(config); err == nil {
				t.Fatal("accepted unsafe local development OAuth configuration")
			}
		})
	}
	for _, host := range []string{"127.0.0.1", "localhost"} {
		config := localOAuthConfig(t, "https://github.test")
		config.Listen = host + ":8443"
		config.GitHubOAuth.RedirectURL = "https://" + config.Listen + "/auth/callback"
		config.Proxy.AllowedHosts = []string{host}
		if err := validateLocalDevelopmentOAuth(config); err != nil {
			t.Fatal(err)
		}
	}
	for name, mutate := range map[string]func(*GitHubOAuthConfig){
		"multiple users":  func(c *GitHubOAuthConfig) { c.LocalDevelopmentUser = "octocat,another-user" },
		"wildcard":        func(c *GitHubOAuthConfig) { c.LocalDevelopmentUser = "*" },
		"user policy":     func(c *GitHubOAuthConfig) { c.AllowedUsers = []string{"another-user"} },
		"org policy":      func(c *GitHubOAuthConfig) { c.AllowedOrganizations = []string{"example"} },
		"team policy":     func(c *GitHubOAuthConfig) { c.AllowedTeams = []string{"example/team"} },
		"SSO attestation": func(c *GitHubOAuthConfig) { c.SSOOrganizations = []string{"example"} },
		"missing opt in":  func(c *GitHubOAuthConfig) { c.LocalDevelopmentUser = "" },
	} {
		t.Run(name, func(t *testing.T) {
			config := localOAuthConfig(t, "https://github.test").GitHubOAuth
			mutate(config)
			if err := config.validate(); err == nil {
				t.Fatal("accepted missing or ambiguous OAuth authorization policy")
			}
		})
	}
}

func TestLocalOAuthRejectsRemoteOrForwardedAccess(t *testing.T) {
	github := fakeGitHub(t, fakeGitHubOptions{membershipState: "inactive", accessExpiresIn: 3600})
	app := localOAuthApp(t, github.URL)
	for name, mutate := range map[string]func(*http.Request){
		"remote peer":      func(r *http.Request) { r.RemoteAddr = "203.0.113.1:12345" },
		"private peer":     func(r *http.Request) { r.RemoteAddr = "192.168.1.2:12345" },
		"missing peer":     func(r *http.Request) { r.RemoteAddr = "" },
		"wrong port":       func(r *http.Request) { r.Host = "127.0.0.1:9443" },
		"forwarded host":   func(r *http.Request) { r.Host = "example.com"; r.Header.Set("X-Forwarded-Host", "127.0.0.1:8443") },
		"forwarded scheme": func(r *http.Request) { r.TLS = nil; r.Header.Set("X-Forwarded-Proto", "https") },
	} {
		t.Run(name, func(t *testing.T) {
			request := localOAuthRequest(t, "/auth/login")
			mutate(request)
			response := httptest.NewRecorder()
			app.Handler().ServeHTTP(response, request)
			if response.Code < 400 || response.Header().Get("Location") != "" {
				t.Fatal("local development OAuth accepted a nonlocal or non-TLS request")
			}
		})
	}
}

func TestLocalOAuthServesThroughDirectHTTPS(t *testing.T) {
	github := fakeGitHub(t, fakeGitHubOptions{membershipState: "inactive", accessExpiresIn: 3600})
	listener := httptest.NewUnstartedServer(nil)
	t.Cleanup(listener.Close)
	config := localOAuthConfig(t, github.URL)
	config.Listen = listener.Listener.Addr().String()
	config.GitHubOAuth.RedirectURL = "https://" + config.Listen + "/auth/callback"
	app := localOAuthAppWithConfig(t, config)
	listener.Config.Handler = app.Handler()
	listener.StartTLS()
	client := listener.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	get := func(path string, cookies ...*http.Cookie) *http.Response {
		t.Helper()
		request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, listener.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		for _, cookie := range cookies {
			request.AddCookie(cookie)
		}
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}
	login := get("/auth/login")
	defer func() { _ = login.Body.Close() }()
	if login.StatusCode != http.StatusFound {
		t.Fatalf("HTTPS login = %d", login.StatusCode)
	}
	location, err := url.Parse(login.Header.Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if location.Query().Get("scope") != "read:user" {
		t.Fatal("local HTTPS server requested organization access")
	}
	authorizeFakeGitHub(t, app, location.String())
	callback := get("/auth/callback?code=code-1&state="+url.QueryEscape(location.Query().Get("state")), firstCookie(t, login, "cao_oauth_state"))
	defer func() { _ = callback.Body.Close() }()
	if callback.StatusCode != http.StatusFound {
		t.Fatalf("HTTPS callback = %d", callback.StatusCode)
	}
	account := get("/api/auth/session", firstCookie(t, callback, sessionCookieName))
	defer func() { _ = account.Body.Close() }()
	if account.StatusCode != http.StatusOK {
		t.Fatalf("HTTPS authenticated request = %d", account.StatusCode)
	}
}
