package webhookgatewayhost

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/githubapp"
	"github.com/githubnext/gh-aw-cao/server/internal/githubquota"
	"github.com/githubnext/gh-aw-cao/server/internal/operational/postgres"
	gateway "github.com/githubnext/gh-aw-cao/server/internal/webhookgateway"
)

type demoSecrets []byte

func (s demoSecrets) WebhookSecrets(context.Context, string) ([]byte, []byte, error) {
	return s, nil, nil
}

type demoProjectAPI struct{ authorityAPI }

func (a demoProjectAPI) WebhookGatewayProjectsWithQuota(_ context.Context, installation, organization int64, ids []string, _ func(githubquota.ResponseQuota)) error {
	if installation != 10 || organization != 12 || len(ids) != 1 || ids[0] != "PVT_example_project" {
		return gateway.ErrUnauthorized
	}
	return nil
}

// This exercises the proposed compiled-artifact boundary, not an unavailable
// upstream gh-aw emitter or a live GitHub installation.
func TestProjectsV2GatewayPostgresDemonstration(t *testing.T) {
	dsn := os.Getenv("POSTGRES_URL")
	if dsn == "" {
		t.Skip("POSTGRES_URL is required for the real PostgreSQL gateway demonstration")
	}
	ctx := t.Context()
	directory := t.TempDir()
	payload, err := os.ReadFile("testdata/projects-v2-item-edited.json")
	if err != nil {
		t.Fatal(err)
	}
	projectPath, fieldPath := "/projects_v2_item/project_node_id", "/changes/field_value/field_type"
	subscription := gateway.Subscription{
		SchemaVersion: "gh-aw.webhook-subscription/v1", Provider: "github", ID: "project-field-change", TenantID: "approved", AppID: 2,
		Source: gateway.Source{ID: "github", Event: "projects_v2_item", InstallationID: 10, OrganizationID: 12,
			ProjectIDs: []string{"PVT_example_project"}, RequiredPermissions: map[string]string{"organization_projects": "read"},
			IdentityConstraints: []gateway.IdentityConstraint{{Path: projectPath, Value: json.RawMessage(`"PVT_example_project"`)}}},
		Filter: &gateway.Filter{Op: "and", Args: []gateway.Filter{
			{Op: "eq", Path: "/action", Value: json.RawMessage(`"edited"`)},
			{Op: "eq", Path: "/changes/field_value/field_node_id", Value: json.RawMessage(`"PVTSSF_example_status_field"`)},
		}},
		Destination: gateway.Destination{Kind: "workflow_dispatch", InstallationID: 20, RepositoryID: 21,
			Workflow: "project-change.yml", Ref: "main", GatewayInput: true, Fields: []gateway.PayloadField{
				{Name: "project", Path: &projectPath, Required: true}, {Name: "field_type", Path: &fieldPath, Required: true},
			}},
		Delivery: gateway.DeliveryPolicy{TTLSeconds: 86400, LeaseSeconds: 60, MaxAttempts: 5, RetryDelaySeconds: 10},
	}
	metadata, err := json.Marshal(subscription)
	if err != nil {
		t.Fatal(err)
	}
	digest := gateway.MetadataDigest(metadata)
	namespace := fmt.Sprintf("gateway-demo-%d", time.Now().UnixNano())
	policy := gateway.GatewayPolicy{Version: 1, Enabled: true, Revision: 1, ReceivingAppID: 1, DispatchAppID: 2,
		Namespace: namespace, Workers: 1,
		Artifacts: []gateway.CompiledArtifact{{Path: "subscription.json", SHA256: digest, RepositoryID: 21,
			CommitSHA: strings.Repeat("a", 40), CompilerID: "contract-fixture-not-upstream-compiler"}},
		Grants: []gateway.AdminGrant{{SubscriptionID: subscription.ID, Digest: digest, SourceInstallationID: 10,
			SourceOrganizationID: 12, ProjectIDs: []string{"PVT_example_project"}, ReceivingInstallationID: 10,
			DestinationInstallationID: 20, DestinationRepositoryID: 21, DispatchKind: "workflow_dispatch",
			AllowVisibilityTransfer: true, ExpiresAt: time.Now().Add(time.Hour)}},
	}
	document, err := json.Marshal(map[string]any{"version": 1, "control-plane": map[string]any{
		"scope": map[string]any{"allowed-owners": []string{"approved"}}, "webhook-gateway": policy,
	}})
	if err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string][]byte{"cao.json": document, "subscription.json": metadata} {
		if err := os.WriteFile(filepath.Join(directory, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	loader := gateway.NewPolicyLoader(filepath.Join(directory, "cao.json"))
	snapshot, err := loader.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	store, err := postgres.New(ctx, dsn, namespace, postgres.Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = store.DeleteNamespace(cleanupCtx)
		_ = store.Close()
	})
	queue, err := store.OpenWebhookQueue(ctx, "github-webhooks", snapshot.Policy.Queue)
	if err != nil {
		t.Fatal(err)
	}
	_, _, receiver, destination := authorityFixture()
	receiver.installation.Permissions = map[string]string{"organization_projects": "read"}
	destination.repository.Visibility = "private"
	authority := LiveAuthority{Loader: loader, Queue: queue, Receiving: demoProjectAPI{receiver}, Dispatch: destination, State: store}
	if err := authority.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	secret := demoSecrets(bytes.Repeat([]byte("x"), 32))
	ingress := &gateway.Ingress{SourceID: "github", Secrets: secret, Policies: loader, Queue: queue,
		Authorizer: ReceiveAuthority{Loader: loader, Queue: queue, State: store}}
	deliver := func(body []byte) int {
		request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/webhooks/github", bytes.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-GitHub-Event", "projects_v2_item")
		request.Header.Set("X-GitHub-Delivery", "00000000-0000-4000-8000-000000000033")
		mac := hmac.New(sha256.New, secret)
		_, _ = mac.Write(body)
		request.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
		response := httptest.NewRecorder()
		ingress.ServeHTTP(response, request)
		return response.Code
	}
	if status := deliver(bytes.ReplaceAll(payload, []byte("PVT_example_project"), []byte("PVT_not_approved"))); status != http.StatusNoContent {
		t.Fatalf("irrelevant project delivery: HTTP %d", status)
	}
	if status := deliver(payload); status != http.StatusAccepted {
		t.Fatalf("matching project delivery: HTTP %d", status)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = postgres.New(ctx, dsn, namespace, postgres.Config{})
	if err != nil {
		t.Fatal(err)
	}
	queue, err = store.OpenWebhookQueue(ctx, "github-webhooks", snapshot.Policy.Queue)
	if err != nil {
		t.Fatal(err)
	}
	authority.Queue, authority.State = queue, store
	client, calls := demoDispatchClient(t)
	quota, err := githubquota.New(store, githubquota.Options{SafetyReserve: 100})
	if err != nil {
		t.Fatal(err)
	}
	gate := &QuotaGate{Service: quota, Reader: quotaReader{true}, AppID: 2, Dispatcher: githubapp.WebhookGatewayDispatcher{Client: client}}
	worker := gateway.Worker{Policies: loader, Queue: queue, Authorizer: authority, Dispatcher: gate, Budget: gate,
		Owner: "demo-worker", HTTPTimeout: 10 * time.Second, LeaseDuration: time.Minute}
	if worked, err := worker.RunOnce(ctx); err != nil || !worked {
		t.Fatalf("durable dispatch: worked=%t error=%v", worked, err)
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	var state string
	var accepted int
	var run int64
	if err := db.QueryRowContext(ctx, `SELECT state,accepted_status,workflow_run_id FROM cao_operational_webhook_jobs WHERE namespace=$1`, namespace).
		Scan(&state, &accepted, &run); err != nil {
		t.Fatal(err)
	}
	if state != "succeeded" || accepted != http.StatusOK || run != 33 || calls.Load() != 1 {
		t.Fatalf("acceptance not persisted: %s status=%d run=%d calls=%d", state, accepted, run, calls.Load())
	}
	ingress.Queue, ingress.Authorizer = queue, ReceiveAuthority{Loader: loader, Queue: queue, State: store}
	if status := deliver(payload); status != http.StatusAccepted {
		t.Fatalf("redelivery: HTTP %d", status)
	}
	if worked, err := worker.RunOnce(ctx); err != nil || worked || calls.Load() != 1 {
		t.Fatalf("duplicate dispatched: worked=%t error=%v calls=%d", worked, err, calls.Load())
	}
}

func demoDispatchClient(t *testing.T, transports ...http.RoundTripper) (*githubapp.Client, *atomic.Int64) {
	t.Helper()
	calls := &atomic.Int64{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/api/v3")
		switch {
		case strings.HasSuffix(path, "/access_tokens"):
			_, _ = fmt.Fprintf(w, `{"token":"test-installation-token","expires_at":%q}`, time.Now().Add(time.Hour).Format(time.RFC3339))
		case r.Method == http.MethodGet && path == "/repositories/21":
			_, _ = fmt.Fprint(w, `{"id":21,"full_name":"approved/destination","private":true,"visibility":"private","owner":{"id":12}}`)
		case r.Method == http.MethodPost && path == "/repos/approved/destination/actions/workflows/project-change.yml/dispatches":
			var request struct {
				Ref    string                     `json:"ref"`
				Inputs map[string]json.RawMessage `json:"inputs"`
			}
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil || request.Ref != "main" ||
				len(request.Inputs) != 3 || len(request.Inputs["_gateway"]) == 0 || string(request.Inputs["project"]) != `"PVT_example_project"` ||
				string(request.Inputs["field_type"]) != `"single_select"` {
				w.WriteHeader(http.StatusUnprocessableEntity)
				return
			}
			calls.Add(1)
			w.WriteHeader(http.StatusOK)
			_, _ = fmt.Fprint(w, `{"workflow_run_id":33}`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	private := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	var transport http.RoundTripper
	if len(transports) > 0 {
		transport = transports[0]
	}
	client, err := githubapp.New(githubapp.Config{AppID: 2, PrivateKeyPEM: private, BaseURL: server.URL + "/", UploadURL: server.URL + "/", Transport: transport})
	if err != nil {
		t.Fatal(err)
	}
	return client, calls
}
