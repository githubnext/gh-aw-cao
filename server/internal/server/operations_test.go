package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/ingest"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

type testReconciler struct {
	calls  int
	event  GitHubWebhook
	called chan struct{}
}

type emptyRedisClient struct{}

func (emptyRedisClient) Do(_ context.Context, command ...string) (any, error) {
	switch command[0] {
	case "PING":
		return "PONG", nil
	case "HGETALL":
		return []any{}, nil
	default:
		return nil, nil
	}
}

func (emptyRedisClient) DoMany(context.Context, [][]string) ([]any, error) {
	return nil, nil
}

func (reconciler *testReconciler) Rebuild(context.Context) (ingest.Result, error) {
	reconciler.calls++
	return ingest.Result{Generation: "g2", Revision: 2}, nil
}

func (reconciler *testReconciler) Reconcile(_ context.Context, event GitHubWebhook) (ingest.Result, error) {
	reconciler.calls++
	reconciler.event = event
	if reconciler.called != nil {
		close(reconciler.called)
	}
	return ingest.Result{Generation: "g2", Revision: 2}, nil
}

func TestWebhookSignatureVerification(t *testing.T) {
	payload := []byte(`{"action":"completed"}`)
	secret := []byte("webhook-secret")
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write(payload)
	signature := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	if !validWebhookSignature(payload, signature, secret) {
		t.Fatal("valid GitHub webhook signature was rejected")
	}
	if validWebhookSignature([]byte(`{"action":"tampered"}`), signature, secret) {
		t.Fatal("tampered webhook payload was accepted")
	}
}

func TestWebhookReconcilesThroughInjectedCanonicalUpdater(t *testing.T) {
	address, closeServer := fakeRedis(t)
	defer closeServer()
	client, err := redisx.New("redis://" + address)
	if err != nil {
		t.Fatal(err)
	}
	reconciler := &testReconciler{called: make(chan struct{})}
	var authBranches []string
	app := &App{
		store:         redisx.NewStore(client, "webhook-test"),
		reconciler:    reconciler,
		webhookSecret: []byte("webhook-secret"),
		hub:           newEventHub(),
		oauth: &githubOAuth{log: func(branch string) {
			authBranches = append(authBranches, branch)
		}},
	}
	payload := `{"action":"completed"}`
	rejected := httptest.NewRecorder()
	rejectedRequest := httptest.NewRequestWithContext(
		t.Context(), http.MethodPost, "/api/github/webhook", strings.NewReader(payload),
	)
	rejectedRequest.Header.Set("X-Hub-Signature-256", "sha256=invalid")
	app.githubWebhook(rejected, rejectedRequest)
	if rejected.Code != http.StatusUnauthorized {
		t.Fatalf("invalid webhook signature returned %d", rejected.Code)
	}
	mac := hmac.New(sha256.New, app.webhookSecret)
	_, _ = mac.Write([]byte(payload))
	request := httptest.NewRequestWithContext(
		t.Context(), http.MethodPost, "/api/github/webhook", strings.NewReader(payload),
	)
	request.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	request.Header.Set("X-GitHub-Delivery", "delivery-1")
	request.Header.Set("X-GitHub-Event", "workflow_run")
	response := httptest.NewRecorder()

	app.githubWebhook(response, request)

	if response.Code != http.StatusAccepted {
		t.Fatalf("webhook returned %d: %s", response.Code, response.Body.String())
	}
	<-reconciler.called
	deadline := time.Now().Add(time.Second)
	for {
		held, err := app.store.LockHeld(t.Context(), "projection")
		if err != nil {
			t.Fatal(err)
		}
		if !held {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("projection lock was not released after reconciliation")
		}
		time.Sleep(time.Millisecond)
	}
	if reconciler.calls != 1 || reconciler.event.Event != "workflow_run" {
		t.Fatalf("webhook was not reconciled: %#v", reconciler)
	}
	if strings.Join(authBranches, ",") != "webhook.signature_rejected,webhook.signature_accepted" {
		t.Fatalf("unexpected webhook authentication branch logs: %v", authBranches)
	}
}

func TestEmptyRedisIsHealthyButNotReady(t *testing.T) {
	app := &App{store: redisx.NewStore(emptyRedisClient{}, "empty-test")}

	healthResponse := httptest.NewRecorder()
	app.health(
		healthResponse,
		httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/health", nil),
	)
	if healthResponse.Code != http.StatusOK {
		t.Fatalf("empty Redis health returned %d: %s", healthResponse.Code, healthResponse.Body.String())
	}
	var health map[string]any
	if err := json.Unmarshal(healthResponse.Body.Bytes(), &health); err != nil {
		t.Fatal(err)
	}
	data := health["data"].(map[string]any)
	if data["available"] != false || data["rebuildRequired"] != true {
		t.Fatalf("empty Redis health did not require rebuild: %#v", health)
	}

	readinessResponse := httptest.NewRecorder()
	app.readiness(
		readinessResponse,
		httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/readiness", nil),
	)
	if readinessResponse.Code != http.StatusServiceUnavailable {
		t.Fatalf("empty Redis readiness returned %d: %s", readinessResponse.Code, readinessResponse.Body.String())
	}
}

func TestHostedRebuildRequiresExplicitAdministrator(t *testing.T) {
	var branches []string
	app := &App{
		oauth: &githubOAuth{log: func(branch string) {
			branches = append(branches, branch)
		}},
		config: Config{AdminUsers: []string{"cao-admin"}},
	}
	request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/api/admin/rebuild", nil)
	request = request.WithContext(context.WithValue(
		request.Context(),
		oauthSessionContextKey{},
		oauthSession{Login: "dashboard-reader"},
	))
	if app.adminAuthorized(request) {
		t.Fatal("non-administrator was authorized to rebuild")
	}
	request = request.WithContext(context.WithValue(
		request.Context(),
		oauthSessionContextKey{},
		oauthSession{Login: "CAO-ADMIN"},
	))
	if !app.adminAuthorized(request) {
		t.Fatal("explicit administrator was denied")
	}
	if strings.Join(branches, ",") != "admin.denied,admin.allowed" {
		t.Fatalf("unexpected administrator branch logs: %v", branches)
	}
}
