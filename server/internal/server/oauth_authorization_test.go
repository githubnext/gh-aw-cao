package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

func TestAuthorizationWebhookScopes(t *testing.T) {
	oauth := adminRoleTestOAuth(t)
	for _, test := range []struct {
		name, event, payload, user string
		invalidate, invalid        bool
	}{
		{"collaborator removed", "member", `{"action":"removed","repository":{"id":42},"member":{"login":"user"}}`, "user", true, false},
		{"collaborator edited", "member", `{"action":"edited","repository":{"id":42},"member":{"login":"user"}}`, "user", true, false},
		{"collaborator added", "member", `{"action":"added","repository":{"id":42},"member":{"login":"user"}}`, "user", true, false},
		{"replacement at same name", "member", `{"action":"removed","repository":{"id":43,"full_name":"example/control"},"member":{"login":"user"}}`, "user", false, false},
		{"missing affected user", "member", `{"action":"removed","repository":{"id":42},"sender":{"login":"actor"}}`, "", false, true},
		{"team membership removed", "membership", `{"action":"removed","organization":{"login":"example"},"member":{"login":"user"}}`, "user", true, false},
		{"other organization", "membership", `{"action":"removed","organization":{"login":"other"},"member":{"login":"user"}}`, "user", false, false},
		{"organization member removed", "organization", `{"action":"member_removed","organization":{"login":"example"},"membership":{"user":{"login":"user"}}}`, "user", true, false},
		{"organization member added", "organization", `{"action":"member_added","organization":{"login":"example"},"membership":{"user":{"login":"user"}}}`, "user", true, false},
		{"organization renamed", "organization", `{"action":"renamed","organization":{"login":"new"},"changes":{"login":{"from":"example"}}}`, "", true, false},
		{"team role edited", "team", `{"action":"edited","repository":{"id":42},"organization":{"login":"example"}}`, "", true, false},
		{"team removed from repository", "team", `{"action":"removed_from_repository","repository":{"id":42}}`, "", true, false},
		{"team added to repository", "team", `{"action":"added_to_repository","repository":{"id":42}}`, "", true, false},
		{"other repository team edit", "team", `{"action":"edited","repository":{"id":43},"organization":{"login":"example"}}`, "", false, false},
		{"team deleted", "team", `{"action":"deleted","organization":{"login":"example"}}`, "", true, false},
		{"team access added", "team_add", `{"repository":{"id":42}}`, "", true, false},
		{"workspace renamed", "repository", `{"action":"renamed","repository":{"id":42,"full_name":"example/new"}}`, "", true, false},
		{"workspace transferred", "repository", `{"action":"transferred","repository":{"id":42,"full_name":"other/control"}}`, "", true, false},
		{"ordinary repository edit", "repository", `{"action":"edited","repository":{"id":42}}`, "", false, false},
		{"malformed", "member", `{`, "", false, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			handled, login, invalidate, err := oauth.authorizationWebhookScope(t.Context(), GitHubWebhook{
				Event: test.event, Payload: json.RawMessage(test.payload),
			})
			if !handled || (err != nil) != test.invalid {
				t.Fatalf("handled=%t err=%v", handled, err)
			}
			if err == nil && (login != test.user || invalidate != test.invalidate) {
				t.Fatalf("user=%q invalidated=%t", login, invalidate)
			}
		})
	}
}

func TestHostedPermissionWebhooksRejectWeakSecrets(t *testing.T) {
	github := fakeGitHub(t, fakeGitHubOptions{membershipState: "active", accessExpiresIn: 3600})
	app := newAzureTestApp(t, github.URL)
	config := app.config
	config.WebhookSecret = "weak"
	if _, err := New(t.Context(), app.store, config); err == nil || !strings.Contains(err.Error(), "32 characters") {
		t.Fatalf("weak permission webhook signing secret accepted: %v", err)
	}
}

func authorizationTestApp(t *testing.T) (*App, *fakeGitHubServer, *http.Cookie, *http.Cookie) {
	t.Helper()
	github := fakeGitHub(t, fakeGitHubOptions{
		membershipState: "active", accessExpiresIn: 3600, refreshSucceeds: true,
	})
	app := newAzureTestApp(t, github.URL)
	app.oauth.config.WorkspaceRepository = "example/control"
	app.oauth.config.RepositoryURL = github.URL + "/repos/{owner}/{repo}"
	app.webhookSecret = []byte("test-authorization-webhook-secret")
	github.repositoryPermissions = map[string]bool{"maintain": true}
	cookie, csrf := callbackSession(t, app)
	return app, github, cookie, csrf
}

func authorizationWebhookRequest(t *testing.T, app *App, event, delivery, payload string, signed bool) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/api/github/webhook", strings.NewReader(payload))
	request.Header.Set("X-GitHub-Event", event)
	request.Header.Set("X-GitHub-Delivery", delivery)
	if signed {
		mac := hmac.New(sha256.New, app.webhookSecret)
		_, _ = mac.Write([]byte(payload))
		request.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	}
	response := httptest.NewRecorder()
	app.githubWebhook(response, request)
	return response
}

const memberPermissionPayload = `{"action":"edited","repository":{"id":42,"full_name":"example/control"},"member":{"login":"OcToCaT"},"sender":{"login":"other-user"}}`

func TestSignedPermissionWebhookInvalidatesAcrossReplicas(t *testing.T) {
	app, github, cookie, csrf := authorizationTestApp(t)
	session, err := app.oauth.loadSession(t.Context(), cookie.Value)
	if err != nil {
		t.Fatal(err)
	}
	otherUser := session
	otherUser.Login = "other-user"
	otherUser.ID = "other-session"
	if err := app.oauth.saveSession(t.Context(), otherUser); err != nil {
		t.Fatal(err)
	}
	replica := &App{store: app.store, oauth: newGitHubOAuth(app.oauth.config, app.store)}
	cached := httptest.NewRequestWithContext(context.WithValue(t.Context(), oauthSessionContextKey{}, session), http.MethodGet, "/", nil)
	unaffected := cached.WithContext(context.WithValue(t.Context(), oauthSessionContextKey{}, otherUser))
	if !replica.adminAuthorized(cached) {
		t.Fatal("workspace maintainer was not initially authorized")
	}
	for _, test := range []struct {
		name, payload string
		signed        bool
		status        int
	}{
		{"unsigned", memberPermissionPayload, false, http.StatusUnauthorized},
		{"unrelated", strings.Replace(memberPermissionPayload, `"id":42`, `"id":43`, 1), true, http.StatusAccepted},
		{"malformed", `{`, true, http.StatusBadRequest},
	} {
		response := authorizationWebhookRequest(t, app, "member", test.name, test.payload, test.signed)
		if response.Code != test.status || !replica.adminAuthorized(cached) {
			t.Fatalf("%s changed cached authority or returned %d", test.name, response.Code)
		}
	}
	held, err := app.store.TryLock(t.Context(), "projection", "held", time.Minute)
	if err != nil || !held {
		t.Fatal("could not hold the unrelated projection lease")
	}
	github.repositoryPermissions = map[string]bool{"pull": true}
	response := authorizationWebhookRequest(t, app, "member", "permission-change", memberPermissionPayload, true)
	if response.Code != http.StatusAccepted {
		t.Fatalf("permission webhook returned %d: %s", response.Code, response.Body.String())
	}
	if replica.adminAuthorized(cached) || !replica.adminAuthorized(unaffected) {
		t.Fatal("invalidation did not target the affected user across replicas")
	}
	request := azureRequest(t, http.MethodGet, "/api/admin/collection/status")
	request.AddCookie(cookie)
	request.AddCookie(csrf)
	response = httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("revoked maintainer retained access: %d", response.Code)
	}
	refreshed, ok := replica.oauth.session(httptest.NewRecorder(), request)
	if !ok || refreshed.Admin || refreshed.AuthorizationRevision == session.AuthorizationRevision {
		t.Fatal("replica did not preserve the reader session with freshly denied administrator authority")
	}
	checks := github.repositoryRequests
	response = authorizationWebhookRequest(t, app, "member", "permission-change", memberPermissionPayload, true)
	if response.Code != http.StatusAccepted || !strings.Contains(response.Body.String(), `"duplicate":true`) {
		t.Fatal("duplicate permission delivery was not deduplicated")
	}
	if _, ok := replica.oauth.session(httptest.NewRecorder(), request); !ok || github.repositoryRequests != checks {
		t.Fatal("duplicate delivery invalidated freshly rechecked authority")
	}
	response = authorizationWebhookRequest(t, app, "member", "delayed-add",
		strings.Replace(memberPermissionPayload, `"action":"edited"`, `"action":"added"`, 1), true)
	if response.Code != http.StatusAccepted {
		t.Fatal("out-of-order permission delivery was rejected")
	}
	current, ok := replica.oauth.session(httptest.NewRecorder(), request)
	if !ok || current.Admin {
		t.Fatal("a delayed grant restored authority instead of checking current GitHub permissions")
	}
}

func TestTeamPermissionWebhookInvalidatesWorkspaceAndWakesStreams(t *testing.T) {
	app, _, cookie, _ := authorizationTestApp(t)
	first, err := app.oauth.loadSession(t.Context(), cookie.Value)
	if err != nil {
		t.Fatal(err)
	}
	second := first
	second.Login = "other-user"
	channel := make(chan eventObservation, 1)
	app.hub.clients[channel] = true
	response := authorizationWebhookRequest(t, app, "team", "team-role-edited",
		`{"action":"edited","repository":{"id":42},"organization":{"login":"example"}}`, true)
	if response.Code != http.StatusAccepted || app.oauth.authorizationCurrent(t.Context(), first) ||
		app.oauth.authorizationCurrent(t.Context(), second) {
		t.Fatal("team permission change did not invalidate all workspace decisions")
	}
	select {
	case <-channel:
	default:
		t.Fatal("permission change did not wake local event streams to recheck authorization")
	}
}

func TestOrganizationPermissionWebhookRevokesRemovedMembers(t *testing.T) {
	app, github, cookie, _ := authorizationTestApp(t)
	github.membershipState = "inactive"
	response := authorizationWebhookRequest(t, app, "organization", "member-removed",
		`{"action":"member_removed","organization":{"login":"example"},"membership":{"user":{"login":"octocat"}}}`, true)
	if response.Code != http.StatusAccepted {
		t.Fatal("organization membership webhook was rejected")
	}
	request := azureRequest(t, http.MethodGet, "/api/auth/session")
	request.AddCookie(cookie)
	response = httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized || !github.sawRevocation("access-old") {
		t.Fatal("removed organization member retained an active session or credentials")
	}
}

func TestPermissionWebhookCannotBeOverwrittenByInFlightChecks(t *testing.T) {
	for _, refresh := range []bool{false, true} {
		name := "revalidation"
		if refresh {
			name = "token refresh"
		}
		t.Run(name, func(t *testing.T) {
			app, github, cookie, csrf := authorizationTestApp(t)
			session, err := app.oauth.loadSession(t.Context(), cookie.Value)
			if err != nil {
				t.Fatal(err)
			}
			if refresh {
				session.AccessExpires = time.Now().Add(-time.Minute)
			} else {
				session.AuthorizedAt = time.Now().Add(-authorizationRecheckInterval)
			}
			if err := app.oauth.saveSession(t.Context(), session); err != nil {
				t.Fatal(err)
			}
			github.onRepositoryRequest = func() {
				github.onRepositoryRequest = nil
				github.repositoryPermissions = map[string]bool{"pull": true}
				response := authorizationWebhookRequest(t, app, "member", "during-check", memberPermissionPayload, true)
				if response.Code != http.StatusAccepted {
					t.Errorf("racing webhook returned %d", response.Code)
				}
			}
			request := azureRequest(t, http.MethodGet, "/api/admin/collection/status")
			request.AddCookie(cookie)
			request.AddCookie(csrf)
			response := httptest.NewRecorder()
			app.Handler().ServeHTTP(response, request)
			if response.Code != http.StatusUnauthorized {
				t.Fatalf("in-flight obsolete permission result was admitted: %d", response.Code)
			}
			response = httptest.NewRecorder()
			app.Handler().ServeHTTP(response, request)
			if response.Code != http.StatusForbidden {
				t.Fatalf("retry retained revoked administrator access: %d", response.Code)
			}
			if refresh {
				current, err := app.oauth.loadSession(t.Context(), cookie.Value)
				if err != nil || current.AccessToken != "access-new" {
					t.Fatal("invalidation discarded refreshed reader credentials")
				}
			}
		})
	}
}

type failingAuthorizationClient struct {
	redisx.CommandClient
}

func (client failingAuthorizationClient) Do(ctx context.Context, command ...string) (any, error) {
	if command[0] == "EVAL" && strings.Contains(strings.Join(command[3:], " "), "oauth-authorization:") {
		return nil, errors.New("authorization Redis unavailable")
	}
	return client.CommandClient.Do(ctx, command...)
}

func TestPermissionWebhookRetriesAfterInvalidationFailure(t *testing.T) {
	app, _, cookie, _ := authorizationTestApp(t)
	client := app.store.Client
	app.store.Client = failingAuthorizationClient{CommandClient: client}
	response := authorizationWebhookRequest(t, app, "member", "retryable", memberPermissionPayload, true)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatal("failed invalidation acknowledged success")
	}
	app.store.Client = client
	response = authorizationWebhookRequest(t, app, "member", "retryable", memberPermissionPayload, true)
	if response.Code != http.StatusAccepted || !strings.Contains(response.Body.String(), `"invalidated":true`) {
		t.Fatal("failed delivery could not publish its invalidation on retry")
	}
	session, err := app.oauth.loadSession(t.Context(), cookie.Value)
	if err != nil {
		t.Fatal(err)
	}
	if app.oauth.authorizationCurrent(t.Context(), session) {
		t.Fatal("retried permission webhook did not invalidate cached authority")
	}
}

func TestWorkspaceIdentityPinRejectsNameReuseAfterRestart(t *testing.T) {
	app, github, cookie, _ := authorizationTestApp(t)
	if app.oauth.config.WorkspaceRepositoryID != 0 {
		t.Fatal("test must automatically resolve the workspace ID, not configure it")
	}
	if id, err := app.oauth.workspaceRepositoryID(t.Context()); err != nil || id != 42 {
		t.Fatalf("workspace identity was not automatically pinned: %d %v", id, err)
	}
	github.repositoryID = 43
	github.repositoryPermissions = map[string]bool{"admin": true}
	config := app.oauth.config
	config.RevocationKeyPrefix = app.oauth.revocationPrefix()
	restarted := newGitHubOAuth(config, redisx.NewStore(app.store.Client, "new-process"))
	session := oauthSession{Login: "octocat", AccessToken: "access-old", AuthorizedAt: time.Now()}
	restarted.updateAdminAuthorization(t.Context(), &session)
	if session.Admin || session.AdminRepositoryID != 42 {
		t.Fatal("a replacement inherited authority after a process namespace change")
	}
	previous, err := app.oauth.loadSession(t.Context(), cookie.Value)
	if err != nil {
		t.Fatal(err)
	}
	response := authorizationWebhookRequest(t, app, "repository", "workspace-removed",
		`{"action":"deleted","repository":{"id":42,"full_name":"example/control"}}`, true)
	if response.Code != http.StatusAccepted || app.oauth.authorizationCurrent(t.Context(), previous) {
		t.Fatal("workspace lifecycle event did not invalidate the original immutable identity")
	}
}
