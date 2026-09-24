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

	"github.com/githubnext/gh-aw-cao/server/internal/ingest"
	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

type testReconciler struct {
	calls int
	event GitHubWebhook
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
	reconciler := &testReconciler{}
	app := &App{
		store:         redisx.NewStore(client, "webhook-test"),
		reconciler:    reconciler,
		webhookSecret: []byte("webhook-secret"),
		hub:           newEventHub(),
	}
	payload := `{"action":"completed"}`
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
	if reconciler.calls != 1 || reconciler.event.Event != "workflow_run" {
		t.Fatalf("webhook was not reconciled: %#v", reconciler)
	}
}

func TestCanonicalRelationshipFiltersUseCanonicalFields(t *testing.T) {
	rows := filterRows([]model.Row{
		{"runId": "run-1", "id": "session-1"},
		{"runId": "run-2", "id": "session-2"},
	}, func(row model.Row) bool {
		return fieldEquals(row, "run-1", "runId")
	})
	if len(rows) != 1 || rows[0]["id"] != "session-1" {
		t.Fatalf("unexpected related canonical rows: %#v", rows)
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
