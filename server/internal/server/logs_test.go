package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/logger"
)

func TestServerLogsAuthorization(t *testing.T) {
	app := &App{logs: logger.EnableBuffer(), config: Config{AdminUsers: []string{"operator"}}, oauth: &githubOAuth{}}
	for _, test := range []struct {
		name   string
		ctx    context.Context
		status int
	}{
		{"no session", context.Background(), http.StatusForbidden},
		{"non admin", context.WithValue(context.Background(), oauthSessionContextKey{}, oauthSession{Login: "viewer"}), http.StatusForbidden},
		{"admin", context.WithValue(context.Background(), oauthSessionContextKey{}, oauthSession{Login: "operator"}), http.StatusOK},
		{"actions", context.WithValue(context.Background(), githubActionsActorContextKey{}, "workflow"), http.StatusOK},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequestWithContext(test.ctx, http.MethodGet, "/api/admin/logs", nil)
			response := httptest.NewRecorder()
			app.serverLogs(response, request)
			if response.Code != test.status {
				t.Fatalf("status = %d, want %d", response.Code, test.status)
			}
			if test.status == http.StatusOK {
				if got := response.Header().Get("Content-Type"); got != "application/json" {
					t.Fatalf("Content-Type = %q", got)
				}
				if got := response.Header().Get("Content-Disposition"); got != `attachment; filename="cao-server-logs.json"` {
					t.Fatalf("Content-Disposition = %q", got)
				}
				if got := response.Header().Get("Cache-Control"); got != "no-store" {
					t.Fatalf("Cache-Control = %q", got)
				}
				var records []struct {
					Timestamp string `json:"timestamp"`
					Namespace string `json:"namespace"`
					Message   string `json:"message"`
				}
				if err := json.Unmarshal(response.Body.Bytes(), &records); err != nil || records == nil {
					t.Fatalf("response is not a JSON array: %s (%v)", response.Body.String(), err)
				}
			}
		})
	}
}

func TestServerLogsRouteRequiresAuthenticationAndOptIn(t *testing.T) {
	const token = "local-dashboard-access-token-with-32-characters"
	const actionsToken = "local-actions-access-token-with-32-characters"
	for _, test := range []struct {
		name    string
		bearer  string
		actor   string
		enabled bool
		status  int
	}{
		{"anonymous", "", "", true, http.StatusUnauthorized},
		{"invalid token", "invalid", "", true, http.StatusUnauthorized},
		{"local administrator", token, "", true, http.StatusOK},
		{"actions without actor", actionsToken, "", true, http.StatusUnauthorized},
		{"actions actor", actionsToken, "workflow", true, http.StatusOK},
		{"disabled route", token, "", false, http.StatusNotFound},
	} {
		t.Run(test.name, func(t *testing.T) {
			current := &App{accessToken: token, actionsToken: actionsToken, actionsActor: "workflow"}
			if test.enabled {
				current.logs = logger.EnableBuffer()
			}
			request := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://localhost/api/admin/logs", nil)
			if test.bearer != "" {
				request.Header.Set("Authorization", "Bearer "+test.bearer)
			}
			if test.actor != "" {
				request.Header.Set("X-GitHub-Actor", test.actor)
			}
			response := httptest.NewRecorder()
			handler := http.HandlerFunc(current.serverLogs)
			if !test.enabled {
				handler = http.NotFound
			}
			current.requireAccess(handler).ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("status = %d, want %d: %s", response.Code, test.status, response.Body.String())
			}
		})
	}
}
