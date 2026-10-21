package githubapp

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/githubnext/gh-cao/server/internal/githubquota"
	"github.com/githubnext/gh-cao/server/internal/webhookgateway"
)

func gatewayTestSubscription(kind string) webhookgateway.Subscription {
	subscription := webhookgateway.Subscription{
		SchemaVersion: "gh-aw.webhook-subscription/v1", Provider: "github", ID: "example", TenantID: "tenant", AppID: 11,
		Source:   webhookgateway.Source{ID: "source", Event: "issues", InstallationID: 7, RepositoryID: 42},
		Delivery: webhookgateway.DeliveryPolicy{TTLSeconds: 60, LeaseSeconds: 30, MaxAttempts: 2, RetryDelaySeconds: 1},
		Destination: webhookgateway.Destination{
			Kind: kind, InstallationID: 7, RepositoryID: 42, Workflow: "123", Ref: "main",
			GatewayInput: true, BatchInput: true,
			Fields: []webhookgateway.PayloadField{
				{Name: "delivery", Literal: json.RawMessage(`"abc"`)},
				{Name: "number", Literal: json.RawMessage(`12`)},
			},
		},
	}
	if kind == "repository_dispatch" {
		subscription.Destination.Workflow, subscription.Destination.Ref = "", ""
		subscription.Destination.EventType = "gateway-event"
	}
	return subscription
}

func gatewayTestEnvelope(subscription webhookgateway.Subscription, fields json.RawMessage) json.RawMessage {
	properties := map[string]any{"schema_version": 2, "event": subscription.Source.Event,
		"delivery_ids": []string{"delivery"}, "aw_context": []json.RawMessage{fields},
		"_gateway": map[string]any{"version": "cao.webhook-batch/v1", "sourceId": subscription.Source.ID,
			"subscriptionId": subscription.ID, "batchId": strings.Repeat("b", 64),
			"revision": webhookgateway.Revision{RepositoryID: 42, CommitSHA: strings.Repeat("c", 40),
				MetadataPath: "compiled/subscription.json", Digest: strings.Repeat("a", 64), CompilerID: "fixture"}}}
	body := map[string]any{"event_type": subscription.Destination.EventType, "client_payload": properties}
	if subscription.Destination.Kind == "workflow_dispatch" {
		for _, key := range []string{"schema_version", "delivery_ids", "aw_context", "_gateway"} {
			encoded, _ := json.Marshal(properties[key])
			properties[key] = string(encoded)
		}
		body = map[string]any{"ref": subscription.Destination.Ref, "inputs": properties}
	}
	encoded, _ := json.Marshal(body)
	return encoded
}

func gatewayReceivedContext(t *testing.T, kind string, raw json.RawMessage) string {
	t.Helper()
	var properties map[string]json.RawMessage
	if err := json.Unmarshal(raw, &properties); err != nil {
		t.Fatal(err)
	}
	context := properties["aw_context"]
	if kind == "workflow_dispatch" {
		var text string
		if err := json.Unmarshal(context, &text); err != nil {
			t.Fatal(err)
		}
		context = []byte(text)
	}
	return string(context)
}

func TestWorkflowDispatchRequiresExplicitBatchInput(t *testing.T) {
	subscription := gatewayTestSubscription("workflow_dispatch")
	payload := gatewayTestEnvelope(subscription, json.RawMessage(`{}`))
	if err := webhookgateway.ValidateBatchDispatchPayload(subscription, payload, webhookgateway.DefaultLimits()); err != nil {
		t.Fatal("invalid positive workflow batch fixture", err)
	}
	subscription.Destination.BatchInput = false
	if webhookgateway.ValidateBatchDispatchPayload(subscription, payload, webhookgateway.DefaultLimits()) == nil {
		t.Fatal("workflow without explicit batch input capability accepted")
	}
}

func TestWebhookGatewayDispatchDomainPayloadIsNotDoubleWrapped(t *testing.T) {
	for _, kind := range []string{"workflow_dispatch", "repository_dispatch"} {
		t.Run(kind, func(t *testing.T) {
			var received map[string]json.RawMessage
			client := gatewayTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				if gatewayAuthorityResponse(w, r) {
					return
				}
				if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
					t.Error(err)
				}
				w.WriteHeader(http.StatusNoContent)
			})
			subscription := gatewayTestSubscription(kind)
			subscription.Destination.Fields = []webhookgateway.PayloadField{{Name: "delivery", Literal: json.RawMessage(`"abc"`)}}
			payload := gatewayTestEnvelope(subscription, json.RawMessage(`{"delivery":"abc"}`))
			response := (WebhookGatewayDispatcher{Client: client}).Dispatch(context.Background(), subscription, payload)
			field := "inputs"
			if kind == "repository_dispatch" {
				field = "client_payload"
			}
			if response.StatusCode != http.StatusNoContent || len(received) != 2 || gatewayReceivedContext(t, kind, received[field]) != `[{"delivery":"abc"}]` {
				t.Fatalf("response=%+v received=%v", response, received)
			}
		})
	}
}

var gatewayKeyOnce sync.Once
var gatewayKeyPEM []byte
var gatewayKeyError error

func gatewayTestKey(t *testing.T) []byte {
	t.Helper()
	gatewayKeyOnce.Do(func() {
		var key *rsa.PrivateKey
		key, gatewayKeyError = rsa.GenerateKey(rand.Reader, 2048)
		if gatewayKeyError == nil {
			gatewayKeyPEM = pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
		}
	})
	if gatewayKeyError != nil {
		t.Fatal(gatewayKeyError)
	}
	return gatewayKeyPEM
}

func gatewayTestClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/app/installations/7/access_tokens" {
			if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
				t.Error("scoped token mint did not authenticate as App")
			}
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("X-RateLimit-Limit", "5000")
			w.Header().Set("X-RateLimit-Remaining", "4999")
			w.Header().Set("X-RateLimit-Reset", "1800000000")
			_, _ = fmt.Fprintf(w, `{"token":"scoped-test-token","expires_at":%q}`, time.Now().Add(time.Hour).UTC().Format(time.RFC3339))
			return
		}
		r.URL.Path = strings.TrimPrefix(r.URL.Path, "/api/v3")
		handler(w, r)
	}))
	t.Cleanup(server.Close)
	base, err := url.Parse(server.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	client, err := New(Config{AppID: 11, PrivateKeyPEM: gatewayTestKey(t), BaseURL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	client.appClient.BaseURL = base
	installation, err := client.installationClient(7)
	if err != nil {
		t.Fatal(err)
	}
	installation.BaseURL = base
	return client
}

func gatewayAuthorityResponse(w http.ResponseWriter, r *http.Request) bool {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-RateLimit-Limit", "5000")
	w.Header().Set("X-RateLimit-Remaining", "4999")
	w.Header().Set("X-RateLimit-Reset", "1800000000")
	switch r.URL.Path {
	case "/repositories/42":
		_, _ = w.Write([]byte(`{"id":42,"full_name":"current/renamed","owner":{"id":99},"visibility":"private","private":true,"permissions":{"push":true}}`))
	default:
		return false
	}
	return true
}

func TestWebhookGatewayDispatchRequests(t *testing.T) {
	for _, kind := range []string{"workflow_dispatch", "repository_dispatch"} {
		t.Run(kind, func(t *testing.T) {
			var posts, observations int
			client := gatewayTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				if gatewayAuthorityResponse(w, r) {
					return
				}
				posts++
				wantPath := "/repos/current/renamed/dispatches"
				if kind == "workflow_dispatch" {
					wantPath = "/repos/current/renamed/actions/workflows/123/dispatches"
				}
				if r.Method != http.MethodPost || r.URL.Path != wantPath {
					t.Errorf("request %s %s; want POST %s", r.Method, r.URL.Path, wantPath)
				}
				if r.Header.Get("X-GitHub-Api-Version") != "2026-03-10" {
					t.Errorf("dispatch API version=%q", r.Header.Get("X-GitHub-Api-Version"))
				}
				var body map[string]json.RawMessage
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				field, selector, wantSelector := "client_payload", "event_type", `"gateway-event"`
				if kind == "workflow_dispatch" {
					field, selector, wantSelector = "inputs", "ref", `"main"`
				}
				if gatewayReceivedContext(t, kind, body[field]) != `[{"delivery":"abc","number":12}]` || string(body[selector]) != wantSelector {
					t.Errorf("unexpected payload: %v", body)
				}
				w.WriteHeader(http.StatusNoContent)
			})
			dispatcher := WebhookGatewayDispatcher{Client: client, ObserveQuota: func(_ context.Context, id int64, quota githubquota.ResponseQuota) error {
				observations++
				if id != 7 || !quota.HasObservation {
					t.Errorf("observation id=%d quota=%+v", id, quota)
				}
				if posts > 0 {
					return errors.New("storage down")
				}
				return nil
			}}
			subscription := gatewayTestSubscription(kind)
			response, quota := dispatcher.DispatchWithQuota(context.Background(), subscription, gatewayTestEnvelope(subscription, json.RawMessage(`{"delivery":"abc","number":12}`)))
			if response.StatusCode != 204 || response.TransportOutcome != "response" || posts != 1 || observations != 3 || !quota.HasObservation {
				t.Fatalf("response=%+v posts=%d observations=%d quota=%+v", response, posts, observations, quota)
			}
		})
	}
}

func TestWebhookGatewayDispatchErrorMetadata(t *testing.T) {
	for _, test := range []struct {
		name       string
		status     int
		body, wait string
		wantBody   bool
	}{
		{"ambiguous-not-found", 404, `{"message":"Not Found","documentation_url":"https://secret.example/token"}`, "", true},
		{"disabled", 422, `{"message":"Workflow is disabled"}`, "", true},
		{"missing-trigger", 422, `{"message":"Workflow does not have 'workflow_dispatch' trigger"}`, "", true},
		{"rate-seconds", 429, `{"message":"API rate limit exceeded"}`, "120", true},
		{"rate-date", 429, `{"message":"API rate limit exceeded"}`, time.Now().Add(time.Minute).UTC().Format(http.TimeFormat), true},
		{"rate-reflection-stripped", 403, `{"message":"API rate limit exceeded for secret-token-value https://private.example"}`, "", true},
		{"abuse", 403, `{"message":"You have triggered an abuse detection mechanism. sensitive details"}`, "", true},
		{"server-ambiguous", 503, `{"message":"backend unavailable"}`, "30", false},
		{"reflection", 422, `{"message":"secret bearer credential https://private.example"}`, "", false},
		{"oversized", 500, `{"message":"` + strings.Repeat("x", webhookGatewayResponseLimit) + `"}`, "", false},
		{"invalid-json", 502, `<html>upstream token</html>`, "", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := gatewayTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				if gatewayAuthorityResponse(w, r) {
					return
				}
				w.Header().Set("Retry-After", test.wait)
				w.WriteHeader(test.status)
				_, _ = w.Write([]byte(test.body))
			})
			subscription := gatewayTestSubscription("workflow_dispatch")
			response, quota := (WebhookGatewayDispatcher{Client: client}).DispatchWithQuota(context.Background(), subscription, gatewayTestEnvelope(subscription, json.RawMessage(`{}`)))
			if response.StatusCode != test.status || response.TransportOutcome != "response" || response.RetryAfter != test.wait || response.WorkflowRunID != 0 ||
				(len(response.Body) > 0) != test.wantBody || len(response.Body) > webhookGatewayResponseLimit ||
				strings.Contains(string(response.Body), "https:") || strings.Contains(string(response.Body), "secret-token-value") || !quota.HasResponse {
				t.Fatalf("response=%+v quota=%+v", response, quota)
			}
			if test.wait != "" && quota.ParkUntil.IsZero() {
				t.Fatal("Retry-After did not produce quota backoff")
			}
		})
	}
}

func TestWebhookGatewayDispatchRejectsInvalidRequestsBeforeHTTP(t *testing.T) {
	requests := 0
	client := gatewayTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		requests++
		t.Errorf("invalid input made HTTP request %s", r.URL.Path)
	})
	dispatcher := WebhookGatewayDispatcher{Client: client}
	for _, payload := range []json.RawMessage{nil, json.RawMessage(`null`), json.RawMessage(`[]`), json.RawMessage(`{"broken"`), json.RawMessage(`{"large":"` + strings.Repeat("a", 1<<20) + `"}`)} {
		response := dispatcher.Dispatch(context.Background(), gatewayTestSubscription("workflow_dispatch"), payload)
		if response.TransportOutcome != "not-sent" || response.StatusCode != 0 {
			t.Fatalf("invalid payload response=%+v", response)
		}
	}
	subscription := gatewayTestSubscription("workflow_dispatch")
	subscription.Destination.Ref = ""
	response := dispatcher.Dispatch(context.Background(), subscription, json.RawMessage(`{}`))
	if response.TransportOutcome != "not-sent" || requests != 0 {
		t.Fatalf("missing ref response=%+v requests=%d", response, requests)
	}
	for _, field := range []string{"app", "provider"} {
		subscription := gatewayTestSubscription("workflow_dispatch")
		if field == "app" {
			subscription.AppID = 12
		} else {
			subscription.Provider = "unsupported"
		}
		response := dispatcher.Dispatch(context.Background(), subscription, gatewayTestEnvelope(subscription, json.RawMessage(`{}`)))
		if response.TransportOutcome != "not-sent" || requests != 0 {
			t.Fatalf("incorrect %s authority response=%+v requests=%d", field, response, requests)
		}
	}
}

func TestWebhookGatewayDispatchDocumentedLimits(t *testing.T) {
	for _, test := range []struct {
		name, kind string
		fields     int
		eventType  string
		size       int
		wantPost   bool
	}{
		{"workflow-context-10", "workflow_dispatch", 10, "", 0, true},
		{"workflow-context-11", "workflow_dispatch", 11, "", 0, false},
		{"repository-10", "repository_dispatch", 10, "", 0, true},
		{"repository-11", "repository_dispatch", 11, "", 0, false},
		{"event-type-100", "repository_dispatch", 1, strings.Repeat("x", 100), 0, true},
		{"event-type-101", "repository_dispatch", 1, strings.Repeat("x", 101), 0, false},
		{"repository-under-64KiB", "repository_dispatch", 1, "", 64000, true},
		{"repository-over-64KiB", "repository_dispatch", 1, "", 65536, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			posts := 0
			client := gatewayTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				if gatewayAuthorityResponse(w, r) {
					return
				}
				posts++
				if test.kind == "workflow_dispatch" {
					w.WriteHeader(http.StatusOK)
					_, _ = w.Write([]byte(`{"workflow_run_id":12,"run_url":"https://api.github.com/repos/current/renamed/actions/runs/12","html_url":"https://github.com/current/renamed/actions/runs/12"}`))
					return
				}
				w.WriteHeader(http.StatusNoContent)
			})
			fields := map[string]string{}
			for i := 0; i < test.fields; i++ {
				fields[strconv.Itoa(i)] = strings.Repeat("a", test.size)
			}
			payload, err := json.Marshal(fields)
			if err != nil {
				t.Fatal(err)
			}
			subscription := gatewayTestSubscription(test.kind)
			subscription.Destination.Fields = nil
			path := "/safe"
			for name := range fields {
				subscription.Destination.Fields = append(subscription.Destination.Fields,
					webhookgateway.PayloadField{Name: name, Path: &path})
			}
			if test.eventType != "" {
				subscription.Destination.EventType = test.eventType
			}
			response := (WebhookGatewayDispatcher{Client: client}).Dispatch(context.Background(), subscription, gatewayTestEnvelope(subscription, payload))
			if (posts == 1) != test.wantPost || (response.TransportOutcome == "response") != test.wantPost {
				t.Fatalf("response=%+v posts=%d wantPost=%t", response, posts, test.wantPost)
			}
			if test.wantPost && test.kind == "workflow_dispatch" && (response.StatusCode != http.StatusOK || response.WorkflowRunID != 12 || len(response.Body) != 0) {
				t.Fatalf("documented HTTP 200 lost: %+v", response)
			}
		})
	}
}

func TestWebhookGatewayAcceptanceRunIdentityIsBounded(t *testing.T) {
	for _, test := range []struct {
		name, body string
		status     int
		wantID     int64
	}{
		{"current", `{"workflow_run_id":123,"run_url":"https://secret/token","html_url":"https://secret/token"}`, 200, 123},
		{"legacy", ``, 204, 0},
		{"missing", `{"run_url":"https://secret/token"}`, 200, 0},
		{"negative", `{"workflow_run_id":-123}`, 200, 0},
		{"overflow", `{"workflow_run_id":9223372036854775808}`, 200, 0},
		{"string", `{"workflow_run_id":"123"}`, 200, 0},
		{"truncated", `{"workflow_run_id":123,`, 200, 0},
		{"too-large", `{"workflow_run_id":123,"extra":"` + strings.Repeat("x", webhookGatewayResponseLimit) + `"}`, 200, 0},
		{"not-accepted", `{"workflow_run_id":123}`, 503, 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := gatewayTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				if gatewayAuthorityResponse(w, r) {
					return
				}
				w.WriteHeader(test.status)
				_, _ = w.Write([]byte(test.body))
			})
			subscription := gatewayTestSubscription("workflow_dispatch")
			response := (WebhookGatewayDispatcher{Client: client}).Dispatch(context.Background(), subscription, gatewayTestEnvelope(subscription, json.RawMessage(`{}`)))
			if response.StatusCode != test.status || response.WorkflowRunID != test.wantID || len(response.Body) != 0 {
				t.Fatalf("response=%+v wantRunID=%d", response, test.wantID)
			}
		})
	}
}

func TestWebhookGatewayRepositoryScopedMintAndLookupQuota(t *testing.T) {
	var lookups, observed int
	client := gatewayTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		lookups++
		if r.URL.Path != "/repositories/42" || !gatewayAuthorityResponse(w, r) {
			t.Errorf("unexpected route %s", r.URL.Path)
		}
	})
	repository, _, err := client.WebhookGatewayRepository(context.Background(), 7, 42, func(quota githubquota.ResponseQuota) {
		if quota.HasResponse {
			observed++
		}
	})
	if err != nil || repository.ID != 42 || lookups != 1 || observed != 2 {
		t.Fatalf("repository=%+v lookups=%d observed=%d err=%v", repository, lookups, observed, err)
	}
}

func TestWebhookGatewayDispatchTransportAmbiguity(t *testing.T) {
	client := gatewayTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if gatewayAuthorityResponse(w, r) {
			return
		}
		select {
		case <-r.Context().Done():
		case <-time.After(150 * time.Millisecond):
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	subscription := gatewayTestSubscription("workflow_dispatch")
	response := (WebhookGatewayDispatcher{Client: client}).Dispatch(ctx, subscription, gatewayTestEnvelope(subscription, json.RawMessage(`{}`)))
	if response.TransportOutcome != "unknown" || response.StatusCode != 0 {
		t.Fatalf("timeout response=%+v", response)
	}
	cancelled, cancelNow := context.WithCancel(context.Background())
	cancelNow()
	response = (WebhookGatewayDispatcher{Client: client}).Dispatch(cancelled, subscription, gatewayTestEnvelope(subscription, json.RawMessage(`{}`)))
	if response.TransportOutcome != "not-sent" {
		t.Fatalf("already cancelled response=%+v", response)
	}
}

func TestWebhookGatewayDispatchNeverFollowsRedirect(t *testing.T) {
	posts := 0
	client := gatewayTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if gatewayAuthorityResponse(w, r) {
			return
		}
		posts++
		w.Header().Set("Location", "/different-target")
		w.WriteHeader(http.StatusTemporaryRedirect)
	})
	subscription := gatewayTestSubscription("workflow_dispatch")
	response := (WebhookGatewayDispatcher{Client: client}).Dispatch(context.Background(), subscription, gatewayTestEnvelope(subscription, json.RawMessage(`{}`)))
	if response.StatusCode != 307 || posts != 1 {
		t.Fatalf("response=%+v posts=%d", response, posts)
	}
}

func TestWebhookGatewayRepositoryMembershipAndIdentity(t *testing.T) {
	for _, test := range []struct {
		name, repository string
		status           int
	}{
		{"identity-mismatch", `{"id":43,"owner":{"id":99}}`, 200},
		{"permission-obscured", `{"message":"Not Found"}`, 404},
		{"visibility-missing", `{"id":42,"owner":{"id":99},"full_name":"owner/repo"}`, 200},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := gatewayTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path != "/repositories/42" {
					t.Errorf("unexpected request %s", r.URL.Path)
				}
				w.WriteHeader(test.status)
				_, _ = w.Write([]byte(test.repository))
			})
			_, _, err := client.WebhookGatewayRepository(context.Background(), 7, 42)
			if err == nil {
				t.Fatal("unproven authority accepted")
			}
			if test.status == 404 {
				var apiErr *GatewayAPIError
				if !errors.As(err, &apiErr) || apiErr.StatusCode != 404 || errors.Is(err, ErrNotFound) {
					t.Fatalf("404 lost ambiguity: %v", err)
				}
			}
		})
	}
}

func TestWebhookGatewayInstallationCurrentIdentity(t *testing.T) {
	for _, test := range []struct {
		name, body string
		valid      bool
		suspended  bool
	}{
		{"current", `{"id":7,"app_id":11,"account":{"id":99,"login":"current-org","type":"Organization"},"permissions":{"actions":"write","contents":"read"}}`, true, false},
		{"suspended", `{"id":7,"app_id":11,"account":{"id":99,"type":"Organization"},"suspended_at":"2026-10-10T00:00:00Z"}`, true, true},
		{"wrong-app", `{"id":7,"app_id":12,"account":{"id":99,"type":"Organization"}}`, false, false},
		{"wrong-installation", `{"id":8,"app_id":11,"account":{"id":99,"type":"Organization"}}`, false, false},
		{"user-account", `{"id":7,"app_id":11,"account":{"id":99,"login":"current-user","type":"User"}}`, true, false},
		{"unknown-account", `{"id":7,"app_id":11,"account":{"id":99,"type":"Bot"}}`, false, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := gatewayTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/app/installations/7" {
					t.Errorf("unexpected installation route %s", r.URL.Path)
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(test.body))
			})
			installation, _, err := client.WebhookGatewayInstallation(context.Background(), 7)
			if (err == nil) != test.valid || (test.valid && (installation.ID != 7 || installation.AccountID != 99 || installation.Suspended != test.suspended)) {
				t.Fatalf("installation=%+v err=%v", installation, err)
			}
			if test.name == "current" && (installation.Permissions["actions"] != "write" || installation.AccountLogin != "current-org") {
				t.Fatalf("installation=%+v", installation)
			}
		})
	}
}

func TestWebhookGatewayDispatchExistingAppAuthentication(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}

	var tokenMints, posts int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/app/installations/7/access_tokens" {
			tokenMints++
			if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
				t.Error("token mint did not use existing App JWT transport")
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = fmt.Fprintf(w, `{"token":"installation-test-token","expires_at":%s}`, strconv.Quote(time.Now().Add(time.Hour).UTC().Format(time.RFC3339)))
			return
		}
		if r.Header.Get("Authorization") != "token installation-test-token" {
			t.Errorf("request did not use installation authentication: %s", r.URL.Path)
		}
		r.URL.Path = strings.TrimPrefix(r.URL.Path, "/api/v3")
		if gatewayAuthorityResponse(w, r) {
			return
		}
		posts++
		w.WriteHeader(204)
	}))
	defer server.Close()
	client, err := New(Config{AppID: 11, PrivateKeyPEM: pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}), BaseURL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	subscription := gatewayTestSubscription("repository_dispatch")
	response := (WebhookGatewayDispatcher{Client: client}).Dispatch(context.Background(), subscription, gatewayTestEnvelope(subscription, json.RawMessage(`{}`)))
	if response.StatusCode != 204 || tokenMints != 1 || posts != 1 {
		t.Fatalf("response=%+v mints=%d posts=%d", response, tokenMints, posts)
	}
}

func TestWebhookGatewayTokenMintFailureQuota(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	for _, status := range []int{http.StatusTooManyRequests, http.StatusServiceUnavailable} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			requests := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests++
				if r.URL.Path != "/app/installations/7/access_tokens" {
					t.Errorf("mint failure reached repository or dispatch route: %s", r.URL.Path)
				}
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Retry-After", time.Now().Add(time.Minute).UTC().Format(http.TimeFormat))
				w.Header().Set("X-RateLimit-Limit", "5000")
				w.Header().Set("X-RateLimit-Remaining", "4998")
				w.Header().Set("X-RateLimit-Reset", "1800000000")
				w.WriteHeader(status)
				_, _ = w.Write([]byte(`{"message":"sensitive token mint failure"}`))
			}))
			defer server.Close()
			client, err := New(Config{
				AppID: 11, BaseURL: server.URL,
				PrivateKeyPEM: pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}),
			})
			if err != nil {
				t.Fatal(err)
			}
			subscription := gatewayTestSubscription("repository_dispatch")
			response, quota := (WebhookGatewayDispatcher{Client: client}).DispatchWithQuota(context.Background(), subscription, gatewayTestEnvelope(subscription, json.RawMessage(`{}`)))
			if response.TransportOutcome != "not-sent" || response.StatusCode != 0 || len(response.Body) != 0 ||
				!quota.HasObservation || quota.Observation.Remaining != 4998 || quota.ParkUntil.IsZero() || requests != 1 {
				t.Fatalf("response=%+v quota=%+v requests=%d", response, quota, requests)
			}
		})
	}
}

func TestWebhookGatewaySanitizesKnownMessagesAndErrorCodes(t *testing.T) {
	for _, test := range []struct {
		input, expected string
	}{
		{`{"message":"workflow has been deleted","errors":[{"code":"invalid","field":"secret"},{"code":"sensitive-token"}],"documentation_url":"https://private"}`, `{"message":"Workflow has been deleted","errors":[{"code":"invalid"}]}`},
		{`{"message":"API rate limit exceeded for private user/IP https://private"}`, `{"message":"API rate limit exceeded"}`},
		{`{"message":"unknown secret","errors":[{"code":"missing_field","resource":"secret"}]}`, `{"errors":[{"code":"missing_field"}]}`},
		{`{"message":"Workflow is disabled for secret target"}`, ``},
		{`{"message":"Resource not accessible by personal access token"}`, `{"message":"Resource not accessible by personal access token"}`},
	} {
		if got := string(safeGatewayErrorBody([]byte(test.input))); got != test.expected {
			t.Errorf("sanitized=%s want=%s", got, test.expected)
		}
	}
}
