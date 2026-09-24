package server

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

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

	removedGitHub := fakeGitHub(t, fakeGitHubOptions{
		membershipState:          "active",
		refreshedMembershipState: "inactive",
		accessExpiresIn:          -60,
		refreshSucceeds:          true,
	})
	app = newAzureTestApp(t, removedGitHub.URL)
	sessionCookie, csrfCookie = callbackSession(t, app)
	removed := httptest.NewRecorder()
	request = azureRequest(t, http.MethodPost, "/api/v1/refresh")
	request.AddCookie(sessionCookie)
	request.AddCookie(csrfCookie)
	request.Header.Set("X-CSRF-Token", csrfCookie.Value)
	app.Handler().ServeHTTP(removed, request)
	if removed.Code != http.StatusUnauthorized {
		t.Fatalf("removed member refresh returned %d: %s", removed.Code, removed.Body.String())
	}
	if !removedGitHub.sawRevocation("access-new") {
		t.Fatalf("removed member's refreshed token was not revoked: %#v", removedGitHub.revoked)
	}
}

func TestLogoutStagesCredentialsWithoutRefreshing(t *testing.T) {
	github := fakeGitHub(t, fakeGitHubOptions{
		membershipState: "active",
		accessExpiresIn: -60,
		refreshSucceeds: false,
	})
	app := newAzureTestApp(t, github.URL)
	sessionCookie, csrfCookie := callbackSession(t, app)

	logout := httptest.NewRecorder()
	request := azureRequest(t, http.MethodPost, "/auth/logout")
	request.AddCookie(sessionCookie)
	request.AddCookie(csrfCookie)
	request.Header.Set("X-CSRF-Token", csrfCookie.Value)
	app.Handler().ServeHTTP(logout, request)
	if logout.Code != http.StatusNoContent {
		t.Fatalf("logout returned %d: %s", logout.Code, logout.Body.String())
	}
	if !github.sawRevocation("access-old") || !github.sawRevocation("refresh-old") {
		t.Fatalf("logout did not revoke unrefreshed credentials: %#v", github.revoked)
	}
}

func TestSessionEncryptionSupportsControlledKeyRotation(t *testing.T) {
	oldSecret := "old-session-secret-0123456789abcdef"
	newSecret := "new-session-secret-0123456789abcdef"
	oldOAuth := newGitHubOAuth(GitHubOAuthConfig{SessionSecret: oldSecret}, nil)
	sealed, err := oldOAuth.seal([]byte("encrypted session"))
	if err != nil {
		t.Fatal(err)
	}

	rotated := newGitHubOAuth(GitHubOAuthConfig{
		SessionSecret:         newSecret,
		PreviousSessionSecret: oldSecret,
	}, nil)
	plain, err := rotated.open(sealed)
	if err != nil || string(plain) != "encrypted session" {
		t.Fatalf("rotated key ring could not decrypt prior session: %q, %v", plain, err)
	}
	legacy := strings.SplitN(sealed, ".", 2)[1]
	plain, err = rotated.open(legacy)
	if err != nil || string(plain) != "encrypted session" {
		t.Fatalf("rotated key ring could not decrypt legacy session: %q, %v", plain, err)
	}

	withoutPrevious := newGitHubOAuth(GitHubOAuthConfig{SessionSecret: newSecret}, nil)
	if _, err := withoutPrevious.open(sealed); err == nil {
		t.Fatal("session encrypted with an unavailable key was accepted")
	}
}

func TestRefreshedSessionCannotResurrectAfterRevocationStaging(t *testing.T) {
	address, closeServer := fakeRedis(t)
	t.Cleanup(closeServer)
	client, err := redisx.New("redis://" + address)
	if err != nil {
		t.Fatal(err)
	}
	oauth := newGitHubOAuth(GitHubOAuthConfig{
		SessionSecret: "session-secret-0123456789abcdef",
	}, redisx.NewStore(client, "oauth-cas-test"))
	session := oauthSession{
		ID: "session-id", Login: "octocat", AccessToken: "old",
		AccessExpires: time.Now().Add(time.Hour), RefreshExpires: time.Now().Add(24 * time.Hour),
	}
	if err := oauth.saveSession(t.Context(), session); err != nil {
		t.Fatal(err)
	}
	_, expected, err := oauth.loadSessionRecord(t.Context(), session.ID)
	if err != nil {
		t.Fatal(err)
	}
	refreshed := session
	refreshed.AccessToken = "refreshed"
	saved, err := oauth.saveSessionIfUnchanged(t.Context(), refreshed, expected)
	if err != nil || !saved {
		t.Fatalf("could not simulate concurrent refresh: saved=%t err=%v", saved, err)
	}
	staged, sealed, err := oauth.stageRevocation(t.Context(), session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if staged.AccessToken != "refreshed" {
		t.Fatalf("logout queued stale credentials: %#v", staged)
	}
	session.AccessToken = "late-refresh"
	saved, err = oauth.saveSessionIfUnchanged(t.Context(), session, expected)
	if err != nil {
		t.Fatal(err)
	}
	if saved {
		t.Fatal("refresh restored a session after revocation staging")
	}
	if _, err := oauth.loadSession(t.Context(), session.ID); err == nil {
		t.Fatal("revoked session remained active")
	}

	replacement := staged
	replacement.AccessToken = "newer-queued-token"
	data, _ := json.Marshal(replacement) // #nosec G117 -- test fixture is immediately encrypted to exercise queued credential replacement.
	replacementSealed, _ := oauth.seal(data)
	if _, err := oauth.configStore(t.Context(), "SET", oauth.revocationKey(session.ID), replacementSealed); err != nil {
		t.Fatal(err)
	}
	if err := oauth.completeRevocation(t.Context(), session.ID, sealed); err != nil {
		t.Fatal(err)
	}
	value, err := oauth.configStore(t.Context(), "GET", oauth.revocationKey(session.ID))
	if err != nil || value == nil {
		t.Fatal("stale completion deleted a newer queued credential record")
	}
}

func TestHostedOAuthExposesAndSwitchesCurrentAccount(t *testing.T) {
	github := fakeGitHub(t, fakeGitHubOptions{membershipState: "active", accessExpiresIn: 3600})
	app := newAzureTestApp(t, github.URL)
	sessionCookie, csrfCookie := callbackSession(t, app)

	current := httptest.NewRecorder()
	request := azureRequest(t, http.MethodGet, "/api/auth/session")
	request.AddCookie(sessionCookie)
	app.Handler().ServeHTTP(current, request)
	if current.Code != http.StatusOK || !strings.Contains(current.Body.String(), `"login":"octocat"`) {
		t.Fatalf("current account returned %d: %s", current.Code, current.Body.String())
	}

	switched := httptest.NewRecorder()
	request = azureRequest(t, http.MethodPost, "/auth/switch-account")
	request.AddCookie(sessionCookie)
	request.AddCookie(csrfCookie)
	request.Header.Set("X-CSRF-Token", csrfCookie.Value)
	app.Handler().ServeHTTP(switched, request)
	if switched.Code != http.StatusOK || !strings.Contains(switched.Body.String(), `/auth/login?select_account=1`) {
		t.Fatalf("account switch returned %d: %s", switched.Code, switched.Body.String())
	}
	if firstCookie(t, switched.Result(), sessionCookieName).MaxAge >= 0 {
		t.Fatal("account switch did not clear the existing session cookie")
	}

	login := httptest.NewRecorder()
	app.Handler().ServeHTTP(login, azureRequest(t, http.MethodGet, "/auth/login?select_account=1"))
	location, err := url.Parse(login.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if location.Query().Get("prompt") != "select_account" {
		t.Fatalf("account switch did not request GitHub account selection: %s", location.String())
	}
}

func TestHostedOAuthLoggedOutPageRequiresExplicitLogin(t *testing.T) {
	app := newAzureTestApp(t, fakeGitHub(t, fakeGitHubOptions{membershipState: "active", accessExpiresIn: 3600}).URL)
	response := httptest.NewRecorder()

	app.Handler().ServeHTTP(response, azureRequest(t, http.MethodGet, "/auth/logged-out"))

	if response.Code != http.StatusOK {
		t.Fatalf("logged-out page returned %d: %s", response.Code, response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("logged-out page may be cached")
	}
	if !strings.Contains(response.Body.String(), `href="/auth/login"`) {
		t.Fatal("logged-out page does not offer explicit GitHub sign-in")
	}
	if response.Header().Get("Location") != "" {
		t.Fatal("logged-out page unexpectedly restarted OAuth")
	}
}

func TestHostedOAuthLogsBranchesWithoutCredentialValues(t *testing.T) {
	github := fakeGitHub(t, fakeGitHubOptions{membershipState: "active", accessExpiresIn: 3600})
	app := newAzureTestApp(t, github.URL)
	var branches []string
	app.oauth.log = func(branch string) {
		branches = append(branches, branch)
	}

	sessionCookie, csrfCookie := callbackSession(t, app)
	current := httptest.NewRecorder()
	request := azureRequest(t, http.MethodGet, "/api/auth/session")
	request.AddCookie(sessionCookie)
	app.Handler().ServeHTTP(current, request)

	app.Handler().ServeHTTP(httptest.NewRecorder(), azureRequest(t, http.MethodGet, "/api/health"))
	health := httptest.NewRecorder()
	request = azureRequest(t, http.MethodGet, "/api/health")
	request.AddCookie(sessionCookie)
	app.Handler().ServeHTTP(health, request)

	rejected := httptest.NewRecorder()
	request = azureRequest(t, http.MethodPost, "/auth/logout")
	request.AddCookie(sessionCookie)
	app.Handler().ServeHTTP(rejected, request)

	logout := authenticatedAuthMutation(t, app, "/auth/logout", sessionCookie, csrfCookie)
	if logout.Code != http.StatusNoContent {
		t.Fatalf("logout returned %d: %s", logout.Code, logout.Body.String())
	}
	app.Handler().ServeHTTP(httptest.NewRecorder(), azureRequest(t, http.MethodGet, "/auth/logged-out"))

	for _, expected := range []string{
		"access.public_allowed",
		"login.default_account_requested",
		"exchange.succeeded",
		"identity.loaded",
		"organization_membership.active",
		"authorization.organization_allowed",
		"callback.succeeded",
		"access.safe_method",
		"current_account.succeeded",
		"health.details_redacted",
		"health.details_authorized",
		"access.csrf_rejected",
		"session_clear.revocation_staged",
		"session_clear.revocation_completed",
		"logout.succeeded",
		"logged_out.rendered",
	} {
		if !slices.Contains(branches, expected) {
			t.Errorf("missing authentication branch log %q in %v", expected, branches)
		}
	}
	logged := strings.Join(branches, "\n")
	for _, secret := range []string{
		sessionCookie.Value,
		csrfCookie.Value,
		"access-old",
		"refresh-old",
		"octocat",
		app.oauth.config.ClientSecret,
		app.oauth.config.SessionSecret,
	} {
		if secret != "" && strings.Contains(logged, secret) {
			t.Errorf("authentication branch logs contain sensitive value %q", secret)
		}
	}
}

func TestOAuthBranchLogsUseFixedIdentifiers(t *testing.T) {
	for _, path := range []string{"oauth.go", "operations.go", "server.go"} {
		file, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(file, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok {
				return true
			}
			selector, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || (selector.Sel.Name != "logBranch" && selector.Sel.Name != "logAuthBranch") {
				return true
			}
			if len(call.Args) != 1 {
				t.Errorf("%s logBranch call must have exactly one argument", path)
				return true
			}
			literal, ok := call.Args[0].(*ast.BasicLit)
			if !ok || literal.Kind != token.STRING {
				t.Errorf("%s logBranch argument must be a fixed string literal", path)
				return true
			}
			branch, err := strconv.Unquote(literal.Value)
			if err != nil || branch == "" || strings.ContainsAny(branch, " \t\r\n%") {
				t.Errorf("%s logBranch identifier %q is invalid", path, literal.Value)
			}
			return true
		})
	}
}

func TestHostedOAuthQueuesFailedCredentialRevocation(t *testing.T) {
	github := fakeGitHub(t, fakeGitHubOptions{
		membershipState:  "active",
		accessExpiresIn:  3600,
		rejectRevocation: true,
	})
	app := newAzureTestApp(t, github.URL)
	sessionCookie, csrfCookie := callbackSession(t, app)

	switched := httptest.NewRecorder()
	request := azureRequest(t, http.MethodPost, "/auth/switch-account")
	request.AddCookie(sessionCookie)
	request.AddCookie(csrfCookie)
	request.Header.Set("X-CSRF-Token", csrfCookie.Value)
	app.Handler().ServeHTTP(switched, request)
	if switched.Code != http.StatusOK {
		t.Fatalf("failed account revocation returned %d: %s", switched.Code, switched.Body.String())
	}
	if firstCookie(t, switched.Result(), sessionCookieName).MaxAge >= 0 {
		t.Fatal("failed account revocation did not clear the active session cookie")
	}

	current := httptest.NewRecorder()
	request = azureRequest(t, http.MethodGet, "/api/auth/session")
	request.AddCookie(sessionCookie)
	app.Handler().ServeHTTP(current, request)
	if current.Code != http.StatusUnauthorized {
		t.Fatalf("failed account revocation retained an active server session: %d", current.Code)
	}

	github.rejectRevocation = false
	login := httptest.NewRecorder()
	app.Handler().ServeHTTP(login, azureRequest(t, http.MethodGet, "/auth/login"))
	if !github.sawRevocation("access-old") || !github.sawRevocation("refresh-old") {
		t.Fatalf("queued credentials were not revoked on retry: %#v", github.revoked)
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
	membershipState          string
	refreshedMembershipState string
	accessExpiresIn          int64
	refreshSucceeds          bool
	rejectRevocation         bool
}

type fakeGitHubServer struct {
	*httptest.Server
	revoked          []string
	rejectRevocation bool
}

func fakeGitHub(t *testing.T, options fakeGitHubOptions) *fakeGitHubServer {
	t.Helper()
	server := &fakeGitHubServer{}
	server.rejectRevocation = options.rejectRevocation
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
		state := options.membershipState
		if options.refreshedMembershipState != "" && request.Header.Get("Authorization") == "Bearer "+"access-new" {
			state = options.refreshedMembershipState
		}
		_ = json.NewEncoder(response).Encode(map[string]string{"state": state})
	})
	mux.HandleFunc("/applications/client/token", func(response http.ResponseWriter, request *http.Request) {
		clientID, clientSecret, ok := request.BasicAuth()
		if !ok || clientID != "client" || clientSecret != "secret" {
			response.WriteHeader(http.StatusUnauthorized)
			return
		}
		if server.rejectRevocation {
			response.WriteHeader(http.StatusServiceUnavailable)
			return
		}
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
