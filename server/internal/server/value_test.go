package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-cao/server/internal/model"
	"github.com/githubnext/gh-cao/server/internal/postgresx"
)

type testValuePublisher struct {
	result postgresx.ValuePublication
	err    error
	rows   []model.Row
}

func (publisher *testValuePublisher) PublishOperationalValue(_ context.Context, row model.Row) (postgresx.ValuePublication, error) {
	publisher.rows = append(publisher.rows, row)
	return publisher.result, publisher.err
}

const testValueEnvelope = `{"schema_version":2,"kind":"operational_value_evidence","operational_value_evidence":{"id":"packet","observedAt":"2026-10-20T11:13:27.410Z","facts":[{"value":9007199254740993}]}}`

func TestValuePublicationValidatesEnvelopeBeforeWrites(t *testing.T) {
	for _, scenario := range []struct {
		name, body, contentType string
		status                  int
	}{
		{"missing", "", "application/json", http.StatusBadRequest},
		{"malformed", "{", "application/json", http.StatusBadRequest},
		{"trailing", testValueEnvelope + "{}", "application/json", http.StatusBadRequest},
		{"trailing malformed", testValueEnvelope + "broken", "application/json", http.StatusBadRequest},
		{"wrong version", strings.Replace(testValueEnvelope, `"schema_version":2`, `"schema_version":3`, 1), "application/json", http.StatusBadRequest},
		{"wrong kind", strings.Replace(testValueEnvelope, "operational_value_evidence", "other", 1), "application/json", http.StatusBadRequest},
		{"null packet", `{"schema_version":2,"kind":"operational_value_evidence","operational_value_evidence":null}`, "application/json", http.StatusBadRequest},
		{"unknown field", strings.Replace(testValueEnvelope, `{"schema_version"`, `{"unknown":true,"schema_version"`, 1), "application/json", http.StatusBadRequest},
		{"wrong media type", testValueEnvelope, "text/plain", http.StatusUnsupportedMediaType},
		{"oversized", `{"padding":"` + strings.Repeat("x", valuePublicationMaxBytes) + `"}`, "application/json", http.StatusRequestEntityTooLarge},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			publisher := &testValuePublisher{}
			app := &App{valuePublisher: publisher}
			request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/api/v1/value", strings.NewReader(scenario.body))
			request.Header.Set("Content-Type", scenario.contentType)
			response := httptest.NewRecorder()
			app.publishValue(response, request)
			if response.Code != scenario.status || len(publisher.rows) != 0 {
				t.Fatalf("status=%d writes=%d, want %d and none", response.Code, len(publisher.rows), scenario.status)
			}
		})
	}
}

func TestValuePublicationMapsStorageFailuresWithoutPayloads(t *testing.T) {
	for _, scenario := range []struct {
		err    error
		status int
	}{
		{postgresx.ErrValueInvalid, http.StatusBadRequest},
		{postgresx.ErrValueConflict, http.StatusConflict},
		{postgresx.ErrValueParentMissing, http.StatusNotFound},
		{errors.New("private-payload-or-credentials"), http.StatusServiceUnavailable},
	} {
		publisher := &testValuePublisher{err: scenario.err}
		app := &App{valuePublisher: publisher}
		request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/api/v1/value", strings.NewReader(testValueEnvelope))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		app.publishValue(response, request)
		if response.Code != scenario.status || strings.Contains(response.Body.String(), "private-payload") {
			t.Fatalf("unsafe or incorrect failure response: %d %s", response.Code, response.Body.String())
		}
	}
}

func TestValuePublicationAdvancesSubscriptionsOnlyForNewCaptures(t *testing.T) {
	for _, updated := range []bool{false, true} {
		publisher := &testValuePublisher{result: postgresx.ValuePublication{
			ID: "packet", Revision: 7, Updated: updated, ObservedAt: "2026-10-20T11:13:27.410Z",
		}}
		hub := newEventHub()
		channel := make(chan eventObservation, 1)
		hub.clients[channel] = false
		app := &App{valuePublisher: publisher, hub: hub}
		request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/api/v1/value", strings.NewReader(testValueEnvelope))
		request.Header.Set("Content-Type", "application/x-ndjson")
		response := httptest.NewRecorder()
		app.publishValue(response, request)
		var result postgresx.ValuePublication
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &result) != nil || result != publisher.result {
			t.Fatalf("incorrect publication response: %d %s", response.Code, response.Body.String())
		}
		if len(publisher.rows) != 1 || publisher.rows[0]["observedAt"] != result.ObservedAt {
			t.Fatal("publication changed the original capture timestamp")
		}
		facts := publisher.rows[0]["facts"].([]any)
		if facts[0].(map[string]any)["value"] != json.Number("9007199254740993") {
			t.Fatal("publication rounded an original native fact")
		}
		select {
		case event := <-channel:
			if !updated || event.revision != 7 {
				t.Fatalf("unexpected publication event: %+v", event)
			}
		default:
			if updated {
				t.Fatal("new publication did not notify active subscriptions")
			}
		}
	}
}

func TestValuePublicationRequiresDatabaseAndLocalCapability(t *testing.T) {
	app := &App{accessToken: strings.Repeat("a", 32)}
	for _, authenticated := range []bool{false, true} {
		request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "http://127.0.0.1/api/v1/value", strings.NewReader(testValueEnvelope))
		if authenticated {
			request.Header.Set("Authorization", "Bearer "+app.accessToken)
		}
		response := httptest.NewRecorder()
		app.requireAccess(http.HandlerFunc(app.publishValue)).ServeHTTP(response, request)
		want := http.StatusUnauthorized
		if authenticated {
			want = http.StatusServiceUnavailable
		}
		if response.Code != want {
			t.Fatalf("status=%d, want %d", response.Code, want)
		}
	}
}

func TestValuePublicationHostedAdministratorAndCSRF(t *testing.T) {
	github := fakeGitHub(t, fakeGitHubOptions{membershipState: "active"})
	app := newAzureTestApp(t, github.URL)
	publisher := &testValuePublisher{result: postgresx.ValuePublication{
		ID: "packet", Revision: 7, Updated: true, ObservedAt: "2026-10-20T11:13:27.410Z",
	}}
	app.valuePublisher = publisher
	session, csrf := callbackSession(t, app)
	for _, scenario := range []struct {
		name          string
		authenticated bool
		csrf          bool
		admin         bool
		status        int
	}{
		{"anonymous", false, false, false, http.StatusUnauthorized},
		{"read-only", true, true, false, http.StatusForbidden},
		{"missing csrf", true, false, true, http.StatusForbidden},
		{"administrator", true, true, true, http.StatusOK},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			app.config.AdminUsers = nil
			if scenario.admin {
				app.config.AdminUsers = []string{"octocat"}
			}

			request := azureRequest(t, http.MethodPost, "/api/v1/value")
			request.Body = io.NopCloser(strings.NewReader(testValueEnvelope))
			request.Header.Set("Content-Type", "application/json")
			if scenario.authenticated {
				request.AddCookie(session)
			}
			if scenario.csrf {
				request.Header.Set("X-CSRF-Token", csrf.Value)
			}
			response := httptest.NewRecorder()
			app.Handler().ServeHTTP(response, request)
			if response.Code != scenario.status {
				t.Fatalf("status=%d, want %d: %s", response.Code, scenario.status, response.Body.String())
			}
		})
	}
	if len(publisher.rows) != 1 {
		t.Fatalf("unauthorized requests reached the database: %d writes", len(publisher.rows))
	}
}

func TestValuePublicationRejectsExpiredAdministratorAssurance(t *testing.T) {
	github := fakeGitHub(t, fakeGitHubOptions{membershipState: "active"})
	app := newAzureTestApp(t, github.URL)
	app.config.AdminUsers = []string{"octocat"}
	publisher := &testValuePublisher{}
	app.valuePublisher = publisher
	session := assuredSession("octocat")
	session.AuthenticatedAt = time.Now().Add(-2 * time.Hour)
	request := azureRequest(t, http.MethodPost, "/api/v1/value")
	request = request.WithContext(context.WithValue(request.Context(), oauthSessionContextKey{}, session))
	response := httptest.NewRecorder()
	app.publishValue(response, request)
	if response.Code != http.StatusUnauthorized || !strings.Contains(response.Body.String(), "admin_step_up_required") ||
		len(publisher.rows) != 0 {
		t.Fatalf("expired assurance reached publication: %d %s", response.Code, response.Body.String())
	}
}
