package webhookgatewayhost

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/githubquota"
	"github.com/githubnext/gh-aw-cao/server/internal/operational/postgres"
	gateway "github.com/githubnext/gh-aw-cao/server/internal/webhookgateway"
)

type compilerAuthorityAPI struct {
	authorityAPI
	head, digest string
}

func (a compilerAuthorityAPI) WebhookGatewayWorkflowRevision(context.Context, int64, int64, string, func(githubquota.ResponseQuota)) (string, string, error) {
	return a.head, a.digest, nil
}

type compilerAcceptance struct{ calls int }

func (d *compilerAcceptance) Dispatch(_ context.Context, s gateway.Subscription, payload json.RawMessage) gateway.DispatchResponse {
	d.calls++
	if gateway.ValidateDispatchPayload(s, payload, gateway.DefaultLimits()) != nil {
		return gateway.DispatchResponse{TransportOutcome: "not-sent", Kind: s.Destination.Kind}
	}
	return gateway.DispatchResponse{TransportOutcome: "response", Kind: s.Destination.Kind, StatusCode: http.StatusNoContent}
}

func TestDiscoveredSecurityGatewayPostgresConformance(t *testing.T) {
	dsn := os.Getenv("POSTGRES_URL")
	if dsn == "" {
		t.Skip("POSTGRES_URL is required for registry/ingress/worker conformance")
	}
	ctx := t.Context()
	fixture, err := os.ReadFile("../../../specs/fixtures/webhook-manifest-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, fixture); err != nil {
		t.Fatal(err)
	}
	lock := []byte("# gh-aw-manifest: " + compact.String() + "\nname: contract-fixture\n")
	triggers, err := gateway.ParseWorkflowManifest(lock, ".github/workflows/test.lock.yml", gateway.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	declarations := make([]gateway.CompilerTrigger, 0, len(triggers))
	for _, trigger := range triggers {
		declarations = append(declarations, trigger.Declaration)
	}
	base := discoveryPolicyFixture()
	base.policy.Policy.Namespace = fmt.Sprintf("gateway-discovery-%d", time.Now().UnixNano())
	directory := t.TempDir()
	policyPath := directory + "/cao.json"
	config := base.policy.Policy
	config.Version, config.Revision, config.Workers, config.Enabled = 1, 1, 1, true
	document, err := json.Marshal(map[string]any{"version": 1, "control-plane": map[string]any{
		"scope": map[string]any{"allowed-owners": []string{"approved"}}, "webhook-gateway": config}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(policyPath, document, 0600); err != nil {
		t.Fatal(err)
	}
	policies := gateway.NewPolicyLoader(policyPath)
	initial, err := policies.Load(ctx)
	if err != nil {
		t.Fatal(err)
	}
	store, err := postgres.New(ctx, dsn, config.Namespace, postgres.Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = store.DeleteNamespace(cleanup)
		_ = store.Close()
	})
	queue, err := store.OpenWebhookQueue(ctx, "security", initial.Policy.Queue)
	if err != nil {
		t.Fatal(err)
	}
	registry := queue.(gateway.RegistryStore)
	loader := RegistryLoader{Base: policies, Store: registry}
	record := gateway.RepositoryInventory{RepositoryID: 11, OwnerID: 12, OwnerType: "Organization", Visibility: "private",
		CommitSHA: strings.Repeat("a", 40), Workflows: []gateway.DiscoveredWorkflow{
			{Path: ".github/workflows/test.lock.yml", SHA256: gateway.MetadataDigest(lock), Triggers: declarations},
		}}
	scanner := &DiscoveryWorker{Policies: policies, Registry: registry, GitHub: &discoveryFake{record: &record}}
	if err := scanner.RunOnce(ctx); err != nil {
		t.Fatal(err)
	}
	policy, err := loader.Load(ctx)
	if err != nil || len(policy.Subscriptions) != 3 {
		t.Fatalf("security declarations did not activate: subscriptions=%d err=%v", len(policy.Subscriptions), err)
	}
	_, _, receiver, destination := authorityFixture()
	receiver.installation.Permissions = map[string]string{"contents": "read", "vulnerability_alerts": "read",
		"security_events": "read", "secret_scanning_alerts": "read"}
	receiver.repository.FullName = "approved/private"
	destination.repository.ID, destination.repository.FullName = 11, "approved/private"
	destination.installation.Permissions = map[string]string{"contents": "write"}
	live := LiveAuthority{Loader: loader, Queue: queue, State: store, Dispatch: destination,
		Receiving: compilerAuthorityAPI{authorityAPI: receiver, head: record.CommitSHA, digest: record.Workflows[0].SHA256}}
	if err := live.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	secret := demoSecrets(bytes.Repeat([]byte("x"), 32))
	body := []byte(`{"action":"created","installation":{"id":10},"organization":{"id":12},
		"repository":{"id":11,"private":true,"visibility":"private"},"alert":{"number":42,
		"secret":"MUST-NOT-PERSIST","body":"MUST-NOT-PERSIST","security_advisory":{"severity":"critical"}}}`)
	request := httptest.NewRequestWithContext(ctx, http.MethodPost, "/webhooks/compiler", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-GitHub-Delivery", "security-delivery")
	request.Header.Set("X-GitHub-Event", "dependabot_alert")
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write(body)
	request.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	response := httptest.NewRecorder()
	ingress := &gateway.Ingress{SourceID: gateway.CompilerSourceID, Secrets: secret, Policies: loader, Queue: queue,
		Authorizer: ReceiveAuthority{Loader: loader, Queue: queue, State: store}}
	ingress.ServeHTTP(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("discovered security ingress HTTP %d", response.Code)
	}
	dispatcher := &compilerAcceptance{}
	worker := gateway.Worker{Policies: loader, Queue: queue, Authorizer: live, Dispatcher: dispatcher,
		Owner: "security-contract", HTTPTimeout: time.Second, LeaseDuration: time.Minute}
	if worked, err := worker.RunOnce(ctx); err != nil || !worked || dispatcher.calls != 1 {
		t.Fatalf("security dispatch worked=%v calls=%d err=%v", worked, dispatcher.calls, err)
	}
	hints := DiscoveryHints{Policies: policies, Registry: registry}
	if _, err := hints.Observe(ctx, gateway.Event{SourceID: gateway.CompilerSourceID, Name: "repository",
		RepositoryID: 11, InstallationID: 10}); err != nil {
		t.Fatal(err)
	}
	revoked, err := loader.Load(ctx)
	if err != nil || len(revoked.Subscriptions) != 0 {
		t.Fatal("invalidation retained discovered subscriptions", err)
	}
}
