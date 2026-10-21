package simulator

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v4"
)

func TestLocalActionsOIDCBroker(t *testing.T) {
	now := time.Unix(1800000000, 0)
	trace := &Trace{}
	broker, err := NewOIDCBroker(func() time.Time { return now }, trace)
	if err != nil {
		t.Fatal(err)
	}
	claims := map[string]string{"repository": "simulator/repo-00001", "run_id": "1234"}
	bootstrap, err := broker.Register(claims)
	if err != nil {
		t.Fatal(err)
	}
	claims["run_id"] = "mutated"
	server := httptest.NewServer(broker)
	defer server.Close()
	action := Actions{TokenURL: server.URL + "/token", Bootstrap: bootstrap, Audience: "local-admission", Trace: trace}
	env := action.Environment()
	if env["ACTIONS_ID_TOKEN_REQUEST_URL"] != server.URL+"/token?api-version=2.0" ||
		env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"] != bootstrap {
		t.Fatal("simulator runner environment is invalid")
	}
	raw, err := action.token(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	token, err := jwt.Parse(raw, func(*jwt.Token) (any, error) { return &broker.key.PublicKey, nil },
		jwt.WithValidMethods([]string{"RS256"}), jwt.WithoutClaimsValidation())
	if err != nil || !token.Valid {
		t.Fatal("broker did not produce a signed RS256 token")
	}
	got := token.Claims.(jwt.MapClaims)
	if got["iss"] != actionsIssuer || got["aud"] != "local-admission" || got["run_id"] != "1234" ||
		got["iat"] != float64(now.Unix()) || got["exp"] != float64(now.Unix()+300) {
		t.Fatal("broker lost immutable run identity, audience, or injected clock")
	}
	second, err := action.token(t.Context())
	if err != nil || second != raw {
		t.Fatal("fixed-clock exchanges are not deterministic")
	}
	for _, test := range []struct {
		name, credential, query string
	}{
		{"missing credential", "", "?audience=x"},
		{"wrong credential", "wrong-bootstrap", "?audience=x"},
		{"missing audience", bootstrap, ""},
		{"duplicate audience", bootstrap, "?audience=x&audience=y"},
	} {
		t.Run(test.name, func(t *testing.T) {
			r, err := http.NewRequestWithContext(t.Context(), http.MethodGet, server.URL+"/token"+test.query, nil)
			if err != nil {
				t.Fatal(err)
			}
			r.Header.Set("Authorization", "Bearer "+test.credential)
			response, err := server.Client().Do(r)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = response.Body.Close() }()
			if response.StatusCode != http.StatusForbidden {
				t.Fatal("invalid bootstrap or audience accepted")
			}
		})
	}
	for _, reserved := range []string{"aud", "iss", "exp", "iat", "nbf"} {
		if _, err := broker.Register(map[string]string{reserved: "override"}); err == nil {
			t.Fatal("reserved claim override accepted")
		}
	}
	encoded, err := json.Marshal(trace.Events())
	if err != nil || strings.Contains(string(encoded), bootstrap) || strings.Contains(string(encoded), raw) ||
		strings.Contains(string(encoded), "repository") {
		t.Fatal("trace exposed token material or claims")
	}
}

func TestLocalActionsJobGate(t *testing.T) {
	broker, err := NewOIDCBroker(time.Now, &Trace{})
	if err != nil {
		t.Fatal(err)
	}
	bootstrap, err := broker.Register(map[string]string{"run_id": "1"})
	if err != nil {
		t.Fatal(err)
	}
	issuer := httptest.NewServer(broker)
	defer issuer.Close()
	for _, test := range []struct {
		name, allowance string
		status          int
		workFails       bool
		wantWork        int
		wantConclusion  int
	}{
		{"allowed", `{"max_ai_credits":1}`, 200, false, 1, 1},
		{"denied", "", 403, false, 0, 0},
		{"outage", "", 503, false, 0, 0},
		{"zero budget", `{"max_ai_credits":0}`, 200, false, 0, 0},
		{"missing budget", `{}`, 200, false, 0, 0},
		{"wrong budget type", `{"max_ai_credits":"1"}`, 200, false, 0, 0},
		{"failed job", `{"max_ai_credits":1}`, 200, true, 1, 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			work, conclusions := 0, 0
			endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/conclusion" {
					conclusions++
					w.WriteHeader(http.StatusNoContent)
					return
				}
				w.WriteHeader(test.status)
				_, _ = w.Write([]byte(test.allowance))
			}))
			defer endpoint.Close()
			action := Actions{TokenURL: issuer.URL + "/token", Bootstrap: bootstrap, Audience: endpoint.URL}
			err := action.Run(t.Context(), ActionJob{
				AdmissionURL: endpoint.URL, ConclusionURL: endpoint.URL + "/conclusion",
				Admission: json.RawMessage(`{}`), Conclusion: json.RawMessage(`{}`),
				Work: func(context.Context) error {
					work++
					if test.workFails {
						return errors.New("must-not-log-work-secret")
					}
					return nil
				},
			})
			if work != test.wantWork || conclusions != test.wantConclusion ||
				(err == nil) != (test.name == "allowed") || err != nil && strings.Contains(err.Error(), "must-not-log") {
				t.Fatalf("job gate: work=%d conclusions=%d err=%v", work, conclusions, err)
			}
		})
	}
}

func TestLocalActionsAPIComposition(t *testing.T) {
	api, err := NewActionsAPI(Scenario{Name: "actions-api", Repositories: 1}, 1, time.Now, &Trace{})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(api)
	defer server.Close()
	client, closeClient, err := localClient(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer closeClient()
	for _, path := range []string{"/healthz", "/repos/simulator/repo-00001/actions/runs", "/.well-known/jwks"} {
		request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, server.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		if response.StatusCode != 200 && response.StatusCode != 204 {
			t.Fatal("composed simulator route failed")
		}
	}
	if api.GitHub.Stats().Requests != 1 {
		t.Fatal("broker routes leaked into GitHub REST accounting")
	}
	request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/.well-known/jwks", nil)
	request.RemoteAddr = "192.0.2.1:1234"
	response := httptest.NewRecorder()
	api.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatal("broker accepted a non-loopback caller")
	}
	if _, err := NewOIDCBroker(nil, nil); err == nil {
		t.Fatal("broker accepted a missing clock")
	}
	trace := &Trace{}
	for range 10002 {
		trace.record("actions.token", 200)
	}
	events := trace.Events()
	if len(events) != 10001 || events[10000].Stage != "trace.truncated" {
		t.Fatal("trace overflow was unbounded or silent")
	}
}

func TestLocalActionsRequests(t *testing.T) {
	trace := &Trace{}
	broker, err := NewOIDCBroker(time.Now, trace)
	if err != nil {
		t.Fatal(err)
	}
	bootstrap, err := broker.Register(map[string]string{"run_id": "1"})
	if err != nil {
		t.Fatal(err)
	}
	issuer := httptest.NewServer(broker)
	defer issuer.Close()
	body := json.RawMessage(`{"run_id":"1"}`)
	calls := 0
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		data, err := io.ReadAll(r.Body)
		if err != nil || string(data) != string(body) || r.Method != http.MethodPost ||
			r.Header.Get("Content-Type") != "application/json" || !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ey") {
			t.Error("runner changed the request or omitted authentication")
		}
		switch r.URL.Path {
		case "/allow":
			_, _ = w.Write([]byte(`{"max_ai_credits":1}`))
		case "/conclude":
			w.WriteHeader(http.StatusNoContent)
		case "/redirect":
			w.Header().Set("Location", issuer.URL+"/token")
			w.WriteHeader(http.StatusTemporaryRedirect)
		default:
			w.WriteHeader(http.StatusForbidden)
		}
	}))
	defer endpoint.Close()
	action := Actions{TokenURL: issuer.URL + "/token", Bootstrap: bootstrap, Audience: endpoint.URL + "/allow", Trace: trace}
	for _, test := range []struct {
		path, stage string
		status      int
	}{
		{"/allow", "admission", 200}, {"/conclude", "conclusion_admission", 204},
		{"/deny", "admission", 403}, {"/redirect", "admission", 307},
	} {
		result, err := action.Post(t.Context(), test.stage, endpoint.URL+test.path, body)
		if result.Status != test.status || (err == nil) != (test.status < 300) {
			t.Fatalf("unexpected action outcome: %d, %v", result.Status, err)
		}
	}
	if calls != 4 {
		t.Fatal("runner followed redirect or retried a POST")
	}
	for _, target := range []string{"https://api.github.com/api/admission", "http://localhost:8080/api/admission",
		"http://192.0.2.1:8080/api/admission", "http://127.0.0.1:8080/api/admission?token=secret"} {
		if _, err := action.Post(t.Context(), "admission", target, body); err == nil {
			t.Fatal("runner accepted a non-local or ambiguous endpoint")
		}
	}
	expected := []TraceEvent{
		{1, "oidc.token", 200}, {2, "actions.token", 200}, {3, "actions.admission", 200},
		{4, "oidc.token", 200}, {5, "actions.token", 200}, {6, "actions.conclusion_admission", 204},
		{7, "oidc.token", 200}, {8, "actions.token", 200}, {9, "actions.admission", 403},
		{10, "oidc.token", 200}, {11, "actions.token", 200}, {12, "actions.admission", 307},
	}
	if !reflect.DeepEqual(trace.Events(), expected) {
		t.Fatalf("unexpected deterministic trace: %+v", trace.Events())
	}
}
