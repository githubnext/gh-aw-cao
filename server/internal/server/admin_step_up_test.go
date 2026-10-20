package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-cao/server/internal/audit"
)

func storedSession(t *testing.T, app *App, cookie *http.Cookie) oauthSession {
	t.Helper()
	request := azureRequest(t, http.MethodGet, "/")
	request.AddCookie(cookie)
	session, ok := app.oauth.session(httptest.NewRecorder(), request)
	if !ok {
		t.Fatal("session was not loaded")
	}
	return session
}

func TestAdminStepUpRecordsVerifiedTwoFactor(t *testing.T) {
	github := fakeGitHub(t, fakeGitHubOptions{membershipState: "active"})
	app := newAzureTestApp(t, github.URL)
	before := time.Now().UTC()
	sessionCookie, _ := callbackSession(t, app)
	session := storedSession(t, app, sessionCookie)
	if !slices.Equal(session.Assurance, []string{assuranceTwoFactor}) {
		t.Fatalf("assurance = %v", session.Assurance)
	}
	if session.AuthenticatedAt.Before(before.Add(-time.Second)) {
		t.Fatalf("authenticatedAt = %v", session.AuthenticatedAt)
	}

	response := httptest.NewRecorder()
	request := azureRequest(t, http.MethodGet, "/api/auth/session")
	request.AddCookie(sessionCookie)
	app.Handler().ServeHTTP(response, request)
	var account map[string]string
	if err := json.Unmarshal(response.Body.Bytes(), &account); err != nil {
		t.Fatal(err)
	}
	if account["adminAssuranceExpiresAt"] == "" {
		t.Fatalf("account did not expose step-up expiry: %v", account)
	}
}

func TestAdminStepUpFailsClosedWithoutDisclosedFactor(t *testing.T) {
	github := fakeGitHub(t, fakeGitHubOptions{membershipState: "active"})
	github.twoFactor = nil
	app := newAzureTestApp(t, github.URL)
	app.config.AdminUsers = []string{"octocat"}
	sessionCookie, _ := callbackSession(t, app)
	session := storedSession(t, app, sessionCookie)
	if len(session.Assurance) != 0 {
		t.Fatalf("absent 2FA field produced assurance %v", session.Assurance)
	}
	request := azureRequest(t, http.MethodGet, "/")
	request = request.WithContext(context.WithValue(request.Context(), oauthSessionContextKey{}, session))
	if app.adminAuthorized(request) {
		t.Fatal("administrator without verified factor was authorized")
	}

	disabled := false
	github.twoFactor = &disabled
	sessionCookie, _ = callbackSession(t, app)
	if assurance := storedSession(t, app, sessionCookie).Assurance; len(assurance) != 0 {
		t.Fatalf("disabled 2FA produced assurance %v", assurance)
	}
}

func TestAdminStepUpAcceptsAttestedSSOOrganization(t *testing.T) {
	github := fakeGitHub(t, fakeGitHubOptions{membershipState: "active"})
	github.twoFactor = nil
	app := newAzureTestApp(t, github.URL)
	app.oauth.config.SSOOrganizations = []string{"example"}
	sessionCookie, _ := callbackSession(t, app)
	if assurance := storedSession(t, app, sessionCookie).Assurance; !slices.Equal(assurance, []string{"sso:example"}) {
		t.Fatalf("assurance = %v", assurance)
	}
}

func TestAdminStepUpOAuthProviderPermissionContract(t *testing.T) {
	for _, test := range []struct {
		name      string
		clientID  string
		scopes    []string
		appFactor bool
		sso       bool
		assurance []string
	}{
		{name: "fresh classic grant", clientID: "Ov23liOAuthClient", assurance: []string{assuranceTwoFactor}},
		{name: "classic declined read user", clientID: "client", scopes: []string{"read:org"}},
		{name: "classic broader user grant", clientID: "client", scopes: []string{"read:org", "user"}, assurance: []string{assuranceTwoFactor}},
		{name: "GitHub App undisclosed factor", clientID: "Iv23liGitHubApp"},
		{name: "GitHub App disclosed factor", clientID: "Iv23liGitHubApp", appFactor: true, assurance: []string{assuranceTwoFactor}},
		{name: "GitHub App attested SSO", clientID: "Iv23liGitHubApp", sso: true, assurance: []string{"sso:example"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			github := fakeGitHub(t, fakeGitHubOptions{
				membershipState: "active", accessExpiresIn: 3600,
				grantedScopes: test.scopes, appDisclosesTwoFactor: test.appFactor,
			})
			app := newAzureTestApp(t, github.URL)
			app.config.AdminUsers = []string{"octocat"}
			app.oauth.config.ClientID = test.clientID
			if test.sso {
				app.oauth.config.SSOOrganizations = []string{"example"}
			}
			cookie, _ := callbackSession(t, app)
			session := storedSession(t, app, cookie)
			if !slices.Equal(session.Assurance, test.assurance) {
				t.Fatalf("assurance = %v, want %v", session.Assurance, test.assurance)
			}
			request := azureRequest(t, http.MethodGet, "/api/v1/ingestion/health")
			request = request.WithContext(context.WithValue(request.Context(), oauthSessionContextKey{}, session))
			if app.adminAuthorized(request) != (len(test.assurance) > 0) {
				t.Fatal("administrator authorization did not match provider evidence")
			}
		})
	}
}

func TestAdminStepUpIsNotExtendedByTokenRefresh(t *testing.T) {
	github := fakeGitHub(t, fakeGitHubOptions{
		membershipState: "active", accessExpiresIn: -60, refreshSucceeds: true,
		appDisclosesTwoFactor: true,
	})
	app := newAzureTestApp(t, github.URL)
	app.oauth.config.ClientID = "Iv23liGitHubApp"
	sessionCookie, _ := callbackSession(t, app)
	// Read raw records: storedSession would itself refresh the expired token.
	original, err := app.oauth.loadSession(t.Context(), sessionCookie.Value)
	if err != nil || original.AccessToken != "access-old" {
		t.Fatalf("original session = %q, %v", original.AccessToken, err)
	}

	refreshed := httptest.NewRecorder()
	request := azureRequest(t, http.MethodGet, "/api/auth/session")
	request.AddCookie(sessionCookie)
	app.Handler().ServeHTTP(refreshed, request)
	if refreshed.Code != http.StatusOK {
		t.Fatalf("refresh returned %d: %s", refreshed.Code, refreshed.Body.String())
	}
	after, err := app.oauth.loadSession(t.Context(), sessionCookie.Value)
	if err != nil {
		t.Fatal(err)
	}
	if after.AccessToken == original.AccessToken {
		t.Fatal("refresh did not rotate the access token")
	}
	if !after.AuthenticatedAt.Equal(original.AuthenticatedAt) || !slices.Equal(after.Assurance, original.Assurance) {
		t.Fatalf("refresh changed step-up: %v %v -> %v %v",
			original.AuthenticatedAt, original.Assurance, after.AuthenticatedAt, after.Assurance)
	}
}

func TestAdminStepUpExpiresAndRequestsReauthentication(t *testing.T) {
	var auditLog bytes.Buffer
	app := &App{
		oauth:  &githubOAuth{config: GitHubOAuthConfig{AdminReauthenticationMaxAge: 10 * time.Minute}},
		config: Config{AdminUsers: []string{"operator"}, Audit: audit.New(&auditLog)},
	}
	stale := assuredSession("operator")
	stale.AuthenticatedAt = time.Now().UTC().Add(-11 * time.Minute)
	future := assuredSession("operator")
	future.AuthenticatedAt = time.Now().UTC().Add(time.Hour)
	for name, session := range map[string]oauthSession{"stale": stale, "future": future} {
		t.Run(name, func(t *testing.T) {
			request := httptest.NewRequestWithContext(
				context.WithValue(t.Context(), oauthSessionContextKey{}, session),
				http.MethodGet, "/api/v1/ingestion/health", nil,
			)
			response := httptest.NewRecorder()
			app.collectionStatus(response, request)
			if response.Code != http.StatusUnauthorized {
				t.Fatalf("%s administrator returned %d", name, response.Code)
			}
			if !strings.Contains(response.Header().Get("WWW-Authenticate"), "max_age=600") ||
				!strings.Contains(response.Body.String(), `"admin_step_up_required"`) {
				t.Fatalf("missing step-up challenge: %v %s", response.Header(), response.Body.String())
			}
		})
	}

	request := httptest.NewRequestWithContext(
		context.WithValue(t.Context(), oauthSessionContextKey{}, assuredSession("reader")),
		http.MethodGet, "/api/v1/ingestion/health", nil,
	)
	response := httptest.NewRecorder()
	app.collectionStatus(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("non-administrator returned %d, want 403 without step-up challenge", response.Code)
	}
	if strings.Count(auditLog.String(), `"reason":"step_up_required"`) != 2 || strings.Count(auditLog.String(), `"reason":"not_admin"`) != 1 {
		t.Fatalf("admin denials must be audited with their reason: %s", auditLog.String())
	}
}

func TestAdminReauthenticationMaxAgeIsBounded(t *testing.T) {
	for _, value := range []time.Duration{-1, 30 * time.Second, 2 * time.Hour} {
		config := validOAuthConfig("https://github.example")
		config.AdminReauthenticationMaxAge = value
		if err := config.validate(); err == nil {
			t.Fatalf("max age %v was accepted", value)
		}
	}
	config := validOAuthConfig("https://github.example")
	if err := config.validate(); err != nil || config.AdminReauthenticationMaxAge != defaultAdminReauthenticationMaxAge {
		t.Fatalf("default max age = %v, %v", config.AdminReauthenticationMaxAge, err)
	}
	config.SSOOrganizations = []string{"org/team"}
	if err := config.validate(); err == nil {
		t.Fatal("invalid SSO organization was accepted")
	}
}
