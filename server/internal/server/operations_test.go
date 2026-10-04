package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/collect"
	"github.com/githubnext/gh-aw-cao/server/internal/ingest"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
	"github.com/githubnext/gh-aw-cao/server/internal/simulator"
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
	return ingest.Result{Revision: 2}, nil
}

func (reconciler *testReconciler) Reconcile(_ context.Context, event GitHubWebhook) (ingest.Result, error) {
	reconciler.calls++
	reconciler.event = event
	if reconciler.called != nil {
		close(reconciler.called)
	}
	return ingest.Result{Revision: 2}, nil
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

func TestReconcileInterruptedRebuildLeavesHeldLockUntouched(t *testing.T) {
	status := rebuildStatus{State: "running", StartedAt: "2026-01-01T00:00:00Z"}
	completedAt := time.Date(2026, 1, 1, 0, 5, 0, 0, time.UTC)

	got := reconcileInterruptedRebuild(status, true, false, completedAt)

	if !reflect.DeepEqual(got, status) {
		t.Fatalf("held lock must leave status untouched: got %+v, want %+v", got, status)
	}
}

func TestReconcileInterruptedRebuildIgnoresNonRunningState(t *testing.T) {
	status := rebuildStatus{State: "succeeded", Revision: 7}
	completedAt := time.Date(2026, 1, 1, 0, 5, 0, 0, time.UTC)

	got := reconcileInterruptedRebuild(status, false, true, completedAt)

	if !reflect.DeepEqual(got, status) {
		t.Fatalf("non-running status must be left untouched: got %+v, want %+v", got, status)
	}
}

func TestReconcileInterruptedRebuildMarksRequiredWhenDatabaseNotReady(t *testing.T) {
	status := rebuildStatus{State: "running", StartedAt: "2026-01-01T00:00:00Z"}
	completedAt := time.Date(2026, 1, 1, 0, 5, 0, 0, time.UTC)

	got := reconcileInterruptedRebuild(status, false, false, completedAt)

	if got.State != "interrupted" || !got.Required {
		t.Fatalf("unready database must report interrupted and required: %+v", got)
	}
	if got.CompletedAt != completedAt.Format(time.RFC3339Nano) {
		t.Fatalf("CompletedAt = %q, want %q", got.CompletedAt, completedAt.Format(time.RFC3339Nano))
	}
}

func TestReconcileInterruptedRebuildClearsRequiredWhenDatabaseReady(t *testing.T) {
	status := rebuildStatus{State: "running", StartedAt: "2026-01-01T00:00:00Z"}
	completedAt := time.Date(2026, 1, 1, 0, 5, 0, 0, time.UTC)

	got := reconcileInterruptedRebuild(status, false, true, completedAt)

	if got.State != "interrupted" || got.Required {
		t.Fatalf("ready database must report interrupted without requiring a rebuild: %+v", got)
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
	app := &App{store: redisx.NewStore(emptyRedisClient{}, "empty-test"), database: integrationDatabase(t)}

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

func TestHealthReportsPostgresFailureAsUnhealthy(t *testing.T) {
	database := integrationDatabase(t)
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	app := &App{store: redisx.NewStore(emptyRedisClient{}, "empty-test"), database: database}
	response := httptest.NewRecorder()
	app.health(response, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/health", nil))
	var health map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &health); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusServiceUnavailable || health["status"] != "unhealthy" {
		t.Fatalf("Postgres failure must report unhealthy: status=%d payload=%v", response.Code, health)
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

func TestSimulatorUsesProductionWebhookAdmissionAndCollectionQueue(t *testing.T) {
	database := integrationDatabase(t)
	var client *redisx.Client
	var err error
	if endpoint := os.Getenv("CAO_SIMULATOR_REDIS_URL"); endpoint != "" {
		client, err = redisx.New(endpoint)
		if err == nil {
			_, err = client.Do(t.Context(), "PING")
		}
		if err != nil {
			t.Fatalf("connect to CAO_SIMULATOR_REDIS_URL: %v", err)
		}
	} else {
		address, closeServer := fakeRedis(t)
		t.Cleanup(closeServer)
		client, err = redisx.New("redis://" + address)
		if err != nil {
			t.Fatal(err)
		}
	}
	site := t.TempDir()
	if err := os.WriteFile(site+"/index.html", []byte("<html><body></body></html>"), 0o600); err != nil {
		t.Fatal(err)
	}
	const secret = "simulator-webhook-secret"
	namespace := "simulator-test-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	app, err := New(t.Context(), redisx.NewStore(client, namespace), Config{
		Database:      database,
		Listen:        "127.0.0.1:0",
		SiteDirectory: site,
		AccessToken:   strings.Repeat("x", 32),
		WebhookSecret: secret,
		Collector:     &CollectorConfig{AppID: 1, AdmitOnly: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(app.Handler())
	defer server.Close()

	result, err := (simulator.Scenario{
		Name:                "production-webhook-path",
		Repositories:        4,
		EventsPerRepository: 2,
		Seed:                3,
		Distribution:        "uniform",
		DuplicateEvery:      2,
	}).Deliver(t.Context(), server.Client(), server.URL+"/api/github/webhook", secret, 4)
	if err != nil {
		t.Fatal(err)
	}
	if result.Accepted != result.Attempts || result.Failed != 0 || result.Duplicates == 0 {
		t.Fatalf("simulator did not exercise successful deduplicating admission: %#v", result)
	}
}

func TestSimulatorExercisesGoServerWithRedis(t *testing.T) {
	endpoint := os.Getenv("CAO_SIMULATOR_REDIS_URL")
	if endpoint == "" {
		t.Skip("set CAO_SIMULATOR_REDIS_URL to run the Go server simulator integration")
	}
	database := integrationDatabase(t)
	client, err := redisx.New(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Do(t.Context(), "PING"); err != nil {
		t.Fatalf("connect to CAO_SIMULATOR_REDIS_URL: %v", err)
	}

	site := t.TempDir()
	if err := os.WriteFile(site+"/index.html", []byte("<html><body></body></html>"), 0o600); err != nil {
		t.Fatal(err)
	}
	const secret = "simulator-webhook-secret"
	namespace := "simulator-server-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	app, err := New(t.Context(), redisx.NewStore(client, namespace), Config{
		Database:      database,
		Listen:        "127.0.0.1:0",
		SiteDirectory: site,
		AccessToken:   testAccessToken,
		WebhookSecret: secret,
		Collector:     &CollectorConfig{AppID: 1, AdmitOnly: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := app.Collector().Start(t.Context(), nil); err != nil {
		t.Fatalf("start Go server collector: %v", err)
	}
	server := httptest.NewServer(app.Handler())
	defer server.Close()

	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	result, err := (simulator.Scenario{
		Name:                "go-server-recovery-burst",
		Repositories:        8,
		EventsPerRepository: 5,
		Seed:                29,
		Distribution:        "hot",
		OutOfOrder:          true,
		DuplicateEvery:      3,
		DropEvery:           7,
		DelayEvery:          4,
		Delay:               "1ms",
		ReplayCount:         3,
		RemoveRepositories:  true,
	}).Deliver(ctx, server.Client(), server.URL+"/api/github/webhook", secret, 8)
	if err != nil {
		t.Fatalf("deliver simulator workload to Go server: %v", err)
	}
	if result.Accepted != result.Attempts || result.Failed != 0 || result.Duplicates == 0 || result.Dropped == 0 || result.Replayed == 0 {
		t.Fatalf("simulator did not exercise burst, duplicate, drop, and replay traffic: %#v", result)
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/api/v1/ingestion/health", nil) // #nosec G704 -- httptest binds this endpoint to loopback.
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+testAccessToken)
	response, err := server.Client().Do(request) // #nosec G704 -- the request targets the local httptest server.
	if err != nil {
		t.Fatalf("read Go server ingestion health: %v", err)
	}
	defer func() {
		if err := response.Body.Close(); err != nil {
			t.Errorf("close ingestion health response: %v", err)
		}
	}()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("ingestion health returned %d", response.StatusCode)
	}
	var status collect.Status
	if err := json.NewDecoder(response.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	if status.Health != "recovering" || status.QueueDepth == 0 || status.PendingTasks != 0 {
		t.Fatalf("simulator workload did not leave queued recovery work: %#v", status)
	}
	if status.Counters["webhookReceived"] != int64(result.Attempts) {
		t.Fatalf("health snapshot counted %d webhooks, simulator sent %d", status.Counters["webhookReceived"], result.Attempts)
	}
	if status.Counters["webhookDuplicate"] == 0 || status.Counters["taskQueued"] == 0 {
		t.Fatalf("health snapshot is missing simulator ingestion counters: %#v", status.Counters)
	}
}
