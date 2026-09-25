package server

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type authModelState string

const (
	authModelAnonymous     authModelState = "anonymous"
	authModelAuthenticated authModelState = "authenticated"
)

type authModelTransition struct {
	name string
	from authModelState
	to   authModelState
}

var authModelTransitions = []authModelTransition{
	{name: "login", from: authModelAnonymous, to: authModelAuthenticated},
	{name: "switch-account", from: authModelAuthenticated, to: authModelAnonymous},
	{name: "logout", from: authModelAuthenticated, to: authModelAnonymous},
}

func generateAuthModelCases(state authModelState, depth int) [][]authModelTransition {
	if depth == 0 {
		return nil
	}
	var cases [][]authModelTransition
	for _, transition := range authModelTransitions {
		if transition.from != state {
			continue
		}
		cases = append(cases, []authModelTransition{transition})
		for _, suffix := range generateAuthModelCases(transition.to, depth-1) {
			path := append([]authModelTransition{transition}, suffix...)
			cases = append(cases, path)
		}
	}
	return cases
}

func TestGeneratedAuthenticationModel(t *testing.T) {
	cases := generateAuthModelCases(authModelAnonymous, 3)
	if len(cases) != 5 {
		t.Fatalf("generated %d authentication paths, want 5", len(cases))
	}
	for _, transitions := range cases {
		transitions := transitions
		t.Run(authModelCaseName(transitions), func(t *testing.T) {
			github := fakeGitHub(t, fakeGitHubOptions{
				membershipState: "active",
				accessExpiresIn: 3600,
			})
			app := newAzureTestApp(t, github.URL)
			state := authModelAnonymous
			var sessionCookie, csrfCookie *http.Cookie

			for _, transition := range transitions {
				if transition.from != state {
					t.Fatalf("transition %s cannot run from %s", transition.name, state)
				}
				switch transition.name {
				case "login":
					sessionCookie, csrfCookie = callbackSession(t, app)
				case "switch-account":
					response := authenticatedAuthMutation(t, app, "/auth/switch-account", sessionCookie, csrfCookie)
					if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "select_account=1") {
						t.Fatalf("switch-account returned %d: %s", response.Code, response.Body.String())
					}
				case "logout":
					response := authenticatedAuthMutation(t, app, "/auth/logout", sessionCookie, csrfCookie)
					if response.Code != http.StatusNoContent {
						t.Fatalf("logout returned %d: %s", response.Code, response.Body.String())
					}
				default:
					t.Fatalf("unknown model transition %q", transition.name)
				}
				state = transition.to
				assertAuthModelState(t, app, state, sessionCookie)
			}
		})
	}
}

func authenticatedAuthMutation(
	t *testing.T,
	app *App,
	path string,
	sessionCookie *http.Cookie,
	csrfCookie *http.Cookie,
) *httptest.ResponseRecorder {
	t.Helper()
	response := httptest.NewRecorder()
	request := azureRequest(t, http.MethodPost, path)
	request.AddCookie(sessionCookie)
	request.AddCookie(csrfCookie)
	request.Header.Set("X-CSRF-Token", csrfCookie.Value)
	app.Handler().ServeHTTP(response, request)
	return response
}

func assertAuthModelState(t *testing.T, app *App, state authModelState, sessionCookie *http.Cookie) {
	t.Helper()
	response := httptest.NewRecorder()
	request := azureRequest(t, http.MethodGet, "/api/auth/session")
	if sessionCookie != nil {
		request.AddCookie(sessionCookie)
	}
	app.Handler().ServeHTTP(response, request)
	want := http.StatusUnauthorized
	if state == authModelAuthenticated {
		want = http.StatusOK
	}
	if response.Code != want {
		t.Fatalf("state %s returned %d from session endpoint, want %d", state, response.Code, want)
	}
}

func authModelCaseName(transitions []authModelTransition) string {
	names := make([]string, len(transitions))
	for index, transition := range transitions {
		names[index] = transition.name
	}
	return fmt.Sprintf("%02d_%s", len(transitions), strings.Join(names, "_then_"))
}
