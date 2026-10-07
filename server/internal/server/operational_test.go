package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/githubapp"
	"github.com/githubnext/gh-aw-cao/server/internal/ingest"
	"github.com/githubnext/gh-aw-cao/server/internal/operational/memory"
	"github.com/githubnext/gh-aw-cao/server/internal/simulator"
)

func memoryOAuthApp(t *testing.T, githubURL string) *App {
	t.Helper()
	store, err := memory.New(memory.Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	profile := hostedHostProfile()
	profile.SingleProcess = true
	profile.SingleReplica = true
	profile.RequiresRedis = false
	app, err := New(t.Context(), focusedTestStore(store), Config{
		Database: constructorDatabase(), SiteDirectory: t.TempDir(),
		HostProfile: profile, Listen: "0.0.0.0:8443",
		CertFile: "certificate.pem", KeyFile: "key.pem",
		SingleReplicaConfirmed: true, AllowVolatile: true,
		Proxy:       ProxyPolicy{AllowedHosts: []string{"dashboard.example.com"}, RequireHTTPS: true},
		GitHubOAuth: validOAuthConfig(githubURL),
	})
	if err != nil {
		t.Fatal(err)
	}
	return app
}

func TestMemoryRestartInvalidatesSessionsCSRFAndPendingLogin(t *testing.T) {
	t.Setenv("CAO_REDIS_MAX_BYTES", "irrelevant-invalid-Redis-setting")
	github := fakeGitHub(t, fakeGitHubOptions{membershipState: "active", accessExpiresIn: 3600})
	first := memoryOAuthApp(t, github.URL)
	session, csrf := callbackSession(t, first)
	pendingCookie, pendingState := loginState(t, first)
	second := memoryOAuthApp(t, github.URL)
	request := azureRequest(t, http.MethodGet, "/api/auth/session")
	request.AddCookie(session)
	response := httptest.NewRecorder()
	second.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("old session accepted: %d", response.Code)
	}
	request = azureRequest(t, http.MethodPost, "/auth/logout")
	request.AddCookie(session)
	request.AddCookie(csrf)
	request.Header.Set("X-CSRF-Token", csrf.Value)
	response = httptest.NewRecorder()
	second.Handler().ServeHTTP(response, request)
	if response.Code >= 200 && response.Code < 300 {
		t.Fatalf("old CSRF accepted: %d", response.Code)
	}
	request = azureRequest(t, http.MethodGet, "/auth/callback?code=stale&state="+url.QueryEscape(pendingState))
	request.AddCookie(pendingCookie)
	response = httptest.NewRecorder()
	second.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("pre-restart login callback accepted: %d: %s", response.Code, response.Body.String())
	}
	if _, err := second.oauth.loadSession(t.Context(), session.Value); err == nil {
		t.Fatal("old session was restored")
	}
	if len(github.revoked) != 0 {
		t.Fatal("restart claimed GitHub token revocation")
	}
	newSession, _ := callbackSession(t, second)
	if newSession.Value == session.Value {
		t.Fatal("session identity reused after restart")
	}
}

func TestMemoryRequiresOAuthAndExplicitVolatility(t *testing.T) {
	store, err := memory.New(memory.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	config := Config{
		Database: constructorDatabase(), Listen: "127.0.0.1:8443",
		SiteDirectory: t.TempDir(), AccessToken: strings.Repeat("x", 32),
		SingleReplicaConfirmed: true, AllowVolatile: true,
	}
	if _, err := New(t.Context(), store, config); err == nil {
		t.Fatal("memory accepted bearer-only security")
	}
	config.HostProfile = hostedHostProfile()
	config.HostProfile.SingleProcess = true
	config.HostProfile.SingleReplica = true
	config.AccessToken = ""
	config.GitHubOAuth = validOAuthConfig("https://api.example.com")
	config.Proxy = ProxyPolicy{AllowedHosts: []string{"dashboard.example.com"}, RequireHTTPS: true}
	config.AllowVolatile = false
	if _, err := New(t.Context(), store, config); err == nil {
		t.Fatal("restart loss accepted implicitly")
	}
}

type unavailableMemoryScope struct{ client *githubapp.Client }

func (s unavailableMemoryScope) ListInstallations(ctx context.Context) ([]githubapp.Installation, error) {
	return s.client.ListInstallations(ctx)
}
func (unavailableMemoryScope) ListRepositories(context.Context, int64) ([]githubapp.Repository, error) {
	return nil, errors.New("scope unavailable")
}

func TestMemoryCollectorHTTPBootstrapAndPopulatedAdminBackfill(t *testing.T) {
	data := integrationDatabase(t)
	store, err := memory.New(memory.Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	scenario := simulator.Scenario{
		Name: "memory-collector", Repositories: 1,
		History: &simulator.History{Days: 1, RunsPerDay: 1, AsOf: time.Now().Add(-time.Minute).UTC().Format(time.RFC3339)},
	}
	api, err := simulator.NewAPIHandler(scenario, 1)
	if err != nil {
		t.Fatal(err)
	}
	endpoint := httptest.NewServer(api)
	t.Cleanup(endpoint.Close)
	transport, err := simulator.NewLocalTransport(endpoint.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(transport.CloseIdleConnections)
	key, err := stressAppKey()
	if err != nil {
		t.Fatal(err)
	}
	lake := t.TempDir()
	if _, err := scenario.WriteLake(t.Context(), lake, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := ingest.Run(t.Context(), data, lake, ingest.Options{DatabaseQueriesPath: backfillDatabaseQueries}); err != nil {
		t.Fatal(err)
	}
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	host, err := memoryHostPolicy().resolve(mapLookup(nil))
	if err != nil {
		t.Fatal(err)
	}
	github := fakeGitHub(t, fakeGitHubOptions{membershipState: "active", accessExpiresIn: 3600})
	const secret = "memory-integration-webhook-secret"
	app, err := New(t.Context(), focusedTestStore(store), Config{
		Database: data, DatabaseQueriesPath: backfillDatabaseQueries, SiteDirectory: t.TempDir(),
		HostProfile: host.Profile, Listen: "0.0.0.0:8443", CertFile: "certificate.pem", KeyFile: "key.pem",
		SingleReplicaConfirmed: true, AllowVolatile: true,
		Proxy:       ProxyPolicy{AllowedHosts: []string{"dashboard.example.com"}, RequireHTTPS: true},
		GitHubOAuth: validOAuthConfig(github.URL), WebhookSecret: secret, AdminUsers: []string{"octocat"},
		Collector: &CollectorConfig{
			AppID: 1, PrivateKeyPEM: key, BaseURL: endpoint.URL + "/", Transport: transport,
			LakeDirectory: lake, CatalogRoot: root, ControlRepository: "simulator/repo-00001",
			PolicyPath:          filepath.Join(root, ".github/workflows/cao.json"),
			StaticInventoryPath: filepath.Join(lake, "inventory-sources.json"), Workers: 1, WindowDays: 1,
			InventoryLimit: 10, QueueMaxLength: 20,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	collector := app.Collector()
	if !collector.volatile || collector.RecoveryReady() || !collector.backfill.ReconstructScope ||
		collector.backfill.ScopeReady == nil || collector.backfill.ScopeLimit != 10 {
		t.Fatal("production constructor did not wire volatile recovery")
	}
	// The simulator publishes a compacted lake, so use the existing no-recompaction replay mode.
	collector.backfill.Projector.CatalogRoot = ""
	webhook := func() *httptest.ResponseRecorder {
		payload := `{"action":"completed","workflow_run":{"id":1},"repository":{"full_name":"simulator/repo-00001"}}`
		request := azureRequest(t, http.MethodPost, "/api/github/webhook")
		request.Body = io.NopCloser(strings.NewReader(payload))
		request.Header.Set("X-GitHub-Delivery", "same-retryable-memory-delivery")
		request.Header.Set("X-GitHub-Event", "workflow_run")
		mac := hmac.New(sha256.New, []byte(secret))
		_, _ = mac.Write([]byte(payload))
		request.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
		response := httptest.NewRecorder()
		app.Handler().ServeHTTP(response, request)
		return response
	}
	readiness := func(want int) {
		t.Helper()
		response := httptest.NewRecorder()
		app.Handler().ServeHTTP(response, azureRequest(t, http.MethodGet, "/api/readiness"))
		if response.Code != want {
			t.Fatalf("readiness = %d, want %d: %s", response.Code, want, response.Body.String())
		}
	}
	readiness(http.StatusServiceUnavailable)
	collector.backfill.Enumerator = unavailableMemoryScope{collector.client}
	if _, err := collector.runBackfill(t.Context()); err == nil || collector.RecoveryReady() {
		t.Fatal("partial reconstruction declared ready")
	}
	if response := webhook(); response.Code != http.StatusServiceUnavailable {
		t.Fatalf("partial bootstrap admitted delivery: %d: %s", response.Code, response.Body.String())
	}
	collector.backfill.Enumerator = collector.client
	state, err := collector.runBackfill(t.Context())
	if err != nil || !state.LakeReplayed || state.QueuedRepositories != 1 || state.QueuedRunTasks != 1 {
		t.Fatalf("memory backfill: %+v, %v", state, err)
	}
	readiness(http.StatusOK)
	if response := webhook(); response.Code != http.StatusAccepted || strings.Contains(response.Body.String(), `"duplicate":true`) {
		t.Fatalf("retry was lost or acknowledged before bootstrap: %d: %s", response.Code, response.Body.String())
	}
	if response := webhook(); response.Code != http.StatusAccepted || !strings.Contains(response.Body.String(), `"duplicate":true`) {
		t.Fatalf("delivery was not deduplicated: %d: %s", response.Code, response.Body.String())
	}
	session, csrf := callbackSession(t, app)
	request := azureRequest(t, http.MethodPost, "/api/admin/rebuild")
	request.AddCookie(session)
	request.AddCookie(csrf)
	request.Header.Set("X-CSRF-Token", csrf.Value)
	before := api.Stats().Requests
	response := httptest.NewRecorder()
	app.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("admin backfill rejected: %d: %s", response.Code, response.Body.String())
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		status, err := app.readRebuildStatus(t.Context())
		if err != nil || status.State == "failed" {
			t.Fatalf("admin backfill failed: %+v, %v", status, err)
		}
		if status.State == "succeeded" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("admin backfill did not finish")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if api.Stats().Requests <= before {
		t.Fatal("populated admin rebuild skipped fresh GitHub enumeration")
	}
	leases, err := collector.queue.Lease(t.Context(), "lifecycle-test", 20, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, lease := range leases {
		if err := collector.queue.Complete(t.Context(), lease); err != nil {
			t.Fatal(err)
		}
	}
	collector.backfill.Enumerator = unavailableMemoryScope{collector.client}
	runtimeCtx, cancelRuntime := context.WithCancel(t.Context())
	defer cancelRuntime()
	if err := app.Start(runtimeCtx); err != nil {
		t.Fatal(err)
	}
	stopCtx, cancelStop := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancelStop()
	if err := app.Stop(stopCtx); err != nil {
		t.Fatalf("memory worker, projector, or revocation work outlived shutdown: %v", err)
	}
}

func TestVolatileCollectionAdmissionIsRetryableDuringBootstrap(t *testing.T) {
	collector := &Collector{volatile: true, bootstrapDone: make(chan struct{})}
	result, err := collector.Admit(t.Context(), GitHubWebhook{Delivery: "retryable", Event: "workflow_run"})
	if !errors.Is(err, ErrCollectionBootstrapping) || result != nil {
		t.Fatalf("bootstrap acknowledged unknown scope: %#v, %v", result, err)
	}
	if collector.RecoveryReady() {
		t.Fatal("bootstrap reported ready")
	}
	close(collector.bootstrapDone)
	if !collector.RecoveryReady() {
		t.Fatal("reconstruction did not release admission")
	}
}
