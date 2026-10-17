package server

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func hostedConsentState(t *testing.T, app *App, session *http.Cookie) (*http.Cookie, string) {
	t.Helper()
	request := azureRequest(t, http.MethodGet, "/auth/login?hosted_cli=1")
	request.AddCookie(session)
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusFound {
		t.Fatalf("hosted consent login = %d: %s", response.Code, response.Body.String())
	}
	location, err := url.Parse(response.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	wantScope := "read:org read:user repo"
	if strings.HasPrefix(app.oauth.config.ClientID, "Iv") {
		wantScope = "offline_access"
	}
	if location.Query().Get("scope") != wantScope || location.Query().Get("prompt") != "select_account" {
		t.Fatalf("incorrect consent scope or account selection: %s", location.Query().Get("scope"))
	}
	if strings.Contains(location.String(), session.Value) || len(location.Query().Get("state")) != 43 {
		t.Fatal("provider redirect must carry only opaque state, never session identity")
	}
	authorizeFakeGitHub(t, app, location.String())
	return firstCookie(t, response.Result(), "cao_oauth_state"), location.Query().Get("state")
}

func TestHostedOAuthOrdinaryLoginNeverRequestsRepositoryScope(t *testing.T) {
	for _, admin := range []string{"octocat", "another-admin"} {
		t.Run(admin, func(t *testing.T) {
			fixture := newHostedCLIFixture(t, []string{admin})
			request := azureRequest(t, http.MethodGet, "/auth/login")
			request.AddCookie(fixture.session)
			response := httptest.NewRecorder()
			fixture.app.Handler().ServeHTTP(response, request)
			location, err := url.Parse(response.Header().Get("Location"))
			if err != nil {
				t.Fatal(err)
			}
			if response.Code != http.StatusFound || location.Query().Get("scope") != "read:org read:user" {
				t.Fatal("ordinary viewer or administrator login requested repository access")
			}
		})
	}
}

func TestHostedOAuthConsentEntryFailsClosed(t *testing.T) {
	for _, name := range []string{"anonymous", "viewer", "missing subject", "invalid flag", "duplicate flag"} {
		t.Run(name, func(t *testing.T) {
			fixture := newHostedCLIFixture(t, []string{"octocat"})
			path, want := "/auth/login?hosted_cli=1", http.StatusUnauthorized
			switch name {
			case "viewer":
				fixture.app.config.AdminUsers = []string{"another-admin"}
				want = http.StatusForbidden
			case "missing subject":
				session := storedSession(t, fixture.app, fixture.session)
				session.GitHubID = 0
				if err := fixture.app.oauth.saveSession(t.Context(), session); err != nil {
					t.Fatal(err)
				}
			case "invalid flag":
				path, want = "/auth/login?hosted_cli=true", http.StatusBadRequest
			case "duplicate flag":
				path, want = "/auth/login?hosted_cli=1&hosted_cli=1", http.StatusBadRequest
			}
			request := azureRequest(t, http.MethodGet, path)
			if name != "anonymous" {
				request.AddCookie(fixture.session)
			}
			response := httptest.NewRecorder()
			fixture.app.Handler().ServeHTTP(response, request)
			if response.Code != want || response.Header().Get("Location") != "" {
				t.Fatalf("consent entry = %d, want %d without a provider redirect", response.Code, want)
			}
		})
	}
	t.Run("disabled", func(t *testing.T) {
		github := fakeGitHub(t, fakeGitHubOptions{membershipState: "active", accessExpiresIn: 3600})
		app := memoryOAuthApp(t, github.URL)
		app.config.AdminUsers = []string{"octocat"}
		cookie, _ := callbackSession(t, app)
		request := azureRequest(t, http.MethodGet, "/auth/login?hosted_cli=1")
		request.AddCookie(cookie)
		response := httptest.NewRecorder()
		app.Handler().ServeHTTP(response, request)
		if response.Code != http.StatusForbidden || response.Header().Get("Location") != "" {
			t.Fatal("disabled hosted CLI permitted repository consent")
		}
	})
}

func TestHostedOAuthConsentBindsAdministratorSubject(t *testing.T) {
	for _, clientID := range []string{"client", "Iv23liGitHubApp"} {
		t.Run(clientID, func(t *testing.T) {
			fixture := newHostedCLIFixtureWithOAuth(t, []string{"octocat"}, hostedCLITestOAuth{
				clientID: clientID, sso: strings.HasPrefix(clientID, "Iv"),
			})
			previous := storedSession(t, fixture.app, fixture.session)
			previous.AuthenticatedAt = time.Now().Add(-time.Hour)
			if err := fixture.app.oauth.saveSession(t.Context(), previous); err != nil {
				t.Fatal(err)
			}
			stateCookie, state := hostedConsentState(t, fixture.app, fixture.session)
			response := oauthCallbackResponse(t, fixture.app, stateCookie, state, fixture.session)
			if response.Code != http.StatusFound {
				t.Fatalf("authorized administrator consent = %d", response.Code)
			}
			current := storedSession(t, fixture.app, firstCookie(t, response.Result(), sessionCookieName))
			if current.ID == previous.ID || current.GitHubID != previous.GitHubID || current.Login != previous.Login ||
				!fixture.app.oauth.adminAssured(current, time.Now()) {
				t.Fatal("consent did not establish a new assured session for the same administrator")
			}
		})
	}
}

func TestHostedOAuthConsentRejectsChangedAuthority(t *testing.T) {
	for _, name := range []string{
		"other allowlisted account", "reused login", "changed login", "missing account ID",
		"missing session cookie", "deleted session", "different session", "removed administrator",
		"disabled feature", "missing factor", "membership denied",
	} {
		t.Run(name, func(t *testing.T) {
			fixture := newHostedCLIFixture(t, []string{"octocat", "other-admin"})
			stateCookie, state := hostedConsentState(t, fixture.app, fixture.session)
			previous := storedSession(t, fixture.app, fixture.session)
			callbackCookie := fixture.session
			fixture.github.grantMu.Lock()
			fixture.github.accessToken, fixture.github.refreshToken = "access-elevated", "refresh-elevated"
			switch name {
			case "other allowlisted account":
				fixture.github.login, fixture.github.accountID = "other-admin", 2
			case "reused login":
				fixture.github.accountID = 2
			case "changed login":
				fixture.github.login = "other-admin"
			case "missing account ID":
				fixture.github.accountID = 0
			}
			fixture.github.grantMu.Unlock()
			switch name {
			case "missing session cookie":
				callbackCookie = nil
			case "deleted session":
				if err := fixture.app.oauth.deleteSession(t.Context(), previous.ID); err != nil {
					t.Fatal(err)
				}
			case "different session":
				another := previous
				another.ID = "different-session"
				if err := fixture.app.oauth.saveSession(t.Context(), another); err != nil {
					t.Fatal(err)
				}
				callbackCookie = &http.Cookie{
					Name: sessionCookieName, Value: another.ID, Path: "/",
					Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode,
				}
			case "removed administrator":
				fixture.app.config.AdminUsers = []string{"other-admin"}
			case "disabled feature":
				fixture.app.oauth.repositoryConsentAllowed = nil
			case "missing factor":
				fixture.github.twoFactor = nil
			case "membership denied":
				fixture.github.membershipState = "inactive"
			}
			response := oauthCallbackResponse(t, fixture.app, stateCookie, state, callbackCookie)
			if response.Code != http.StatusForbidden {
				t.Fatalf("changed consent authority = %d, want 403", response.Code)
			}
			for _, cookie := range response.Result().Cookies() {
				if cookie.Name == sessionCookieName {
					t.Fatal("rejected callback replaced the browser session")
				}
			}
			if !fixture.github.sawRevocation("access-elevated") || !fixture.github.sawRevocation("refresh-elevated") {
				t.Fatal("rejected callback left elevated credentials active")
			}
			if fixture.github.sawRevocation(previous.AccessToken) {
				t.Fatal("rejected callback revoked the original access token")
			}
		})
	}
}

func TestHostedOAuthConsentStateCannotBeAlteredOrReusedAfterExpiry(t *testing.T) {
	for _, name := range []string{"tampered subject", "stripped binding", "downgraded state", "expired", "different state"} {
		t.Run(name, func(t *testing.T) {
			fixture := newHostedCLIFixture(t, []string{"octocat"})
			cookie, state := hostedConsentState(t, fixture.app, fixture.session)
			parts := strings.Split(cookie.Value, ".")
			switch name {
			case "tampered subject":
				parts[1] = base64.RawURLEncoding.EncodeToString([]byte(`{"githubId":2}`))
				cookie.Value = strings.Join(parts, ".")
			case "stripped binding":
				cookie.Value = parts[0] + "." + parts[2]
			case "downgraded state":
				state = parts[0] + "." + parts[1]
			case "expired":
				data, err := base64.RawURLEncoding.DecodeString(parts[1])
				if err != nil {
					t.Fatal(err)
				}
				var consent oauthConsentState
				if err := json.Unmarshal(data, &consent); err != nil {
					t.Fatal(err)
				}
				consent.ExpiresAt = time.Now().Add(-time.Second).Unix()
				data, err = json.Marshal(consent)
				if err != nil {
					t.Fatal(err)
				}
				cookie.Value = fixture.app.oauth.sign(state + "." + base64.RawURLEncoding.EncodeToString(data))
			case "different state":
				state = "another-flow"
			}
			response := oauthCallbackResponse(t, fixture.app, cookie, state, fixture.session)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("invalid consent state = %d, want 400", response.Code)
			}
		})
	}
}
