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

	"github.com/githubnext/gh-cao/server/internal/githubapp"
	"github.com/githubnext/gh-cao/server/internal/githubquota"
	"github.com/githubnext/gh-cao/server/internal/operational/postgres"
	gateway "github.com/githubnext/gh-cao/server/internal/webhookgateway"
)

type compilerAuthorityAPI struct {
	authorityAPI
	head, digest                             string
	expectedRepository, expectedInstallation int64
}

func (a compilerAuthorityAPI) WebhookGatewayWorkflowRevision(_ context.Context, installation, repository int64, _ string, _ func(githubquota.ResponseQuota)) (string, string, error) {
	if a.expectedRepository != 0 && (a.expectedRepository != repository || a.expectedInstallation != installation) {
		return "", "", gateway.ErrUnauthorized
	}
	return a.head, a.digest, nil
}

type compilerAcceptance struct {
	calls   int
	sources map[int64]int
}

func (d *compilerAcceptance) DispatchCompiler(ctx context.Context, s gateway.Subscription, payload json.RawMessage, revision gateway.Revision) gateway.DispatchResponse {
	if gateway.ValidateCompilerRevision(s, revision) != nil {
		return gateway.DispatchResponse{TransportOutcome: "not-sent", Kind: s.Destination.Kind}
	}
	if d.sources != nil {
		var envelope struct {
			Payload struct {
				Context struct {
					Webhook struct {
						Deliveries []json.RawMessage `json:"deliveries"`
					} `json:"webhook"`
				} `json:"aw_context"`
			} `json:"client_payload"`
		}
		if json.Unmarshal(payload, &envelope) != nil || s.Destination.RepositoryID != 11 ||
			strings.Contains(string(payload), "MUST-NOT-PERSIST") {
			return gateway.DispatchResponse{TransportOutcome: "not-sent", Kind: s.Destination.Kind}
		}
		d.sources[s.Source.RepositoryID] += len(envelope.Payload.Context.Webhook.Deliveries)
	}
	return d.Dispatch(ctx, s, payload)
}

func (d *compilerAcceptance) Dispatch(_ context.Context, s gateway.Subscription, payload json.RawMessage) gateway.DispatchResponse {
	d.calls++
	if gateway.ValidateBatchDispatchPayload(s, payload, gateway.DefaultLimits()) != nil {
		return gateway.DispatchResponse{TransportOutcome: "not-sent", Kind: s.Destination.Kind}
	}
	return gateway.DispatchResponse{TransportOutcome: "response", Kind: s.Destination.Kind, StatusCode: http.StatusNoContent}
}

func TestDiscoveredSecurityGatewayPostgresConformance(t *testing.T) {
	for _, multiple := range []bool{false, true} {
		t.Run(fmt.Sprintf("multiple-repositories=%v", multiple), func(t *testing.T) {
			testDiscoveredSecurityGatewayPostgres(t, multiple)
		})
	}
}

func testDiscoveredSecurityGatewayPostgres(t *testing.T, multiple bool) {
	dsn := os.Getenv("POSTGRES_URL")
	if dsn == "" {
		t.Skip("POSTGRES_URL is required for registry/ingress/worker conformance")
	}
	ctx := t.Context()
	fixture, err := os.ReadFile("../../../specs/fixtures/webhook-manifest-v2.json")
	if err != nil {
		t.Fatal(err)
	}
	if multiple {
		var document map[string]json.RawMessage
		if err := json.Unmarshal(fixture, &document); err != nil {
			t.Fatal(err)
		}
		var subscriptions []gateway.CompilerTrigger
		if err := json.Unmarshal(document["webhook_subscriptions"], &subscriptions); err != nil {
			t.Fatal(err)
		}
		for i := range subscriptions {
			if gateway.SecurityEventPermission(subscriptions[i].Event) != "" {
				subscriptions[i].Repos = []string{"bar/baz", "foo/*"}
			}
		}
		document["webhook_subscriptions"], err = json.Marshal(subscriptions)
		if err != nil {
			t.Fatal(err)
		}
		fixture, err = json.Marshal(document)
		if err != nil {
			t.Fatal(err)
		}
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
	owners := []string{"approved"}
	if multiple {
		owners = append(owners, "bar", "foo")
		config.Discovery.Repositories = append(config.Discovery.Repositories,
			gateway.DiscoveryRepository{Repository: "bar/baz", RepositoryID: 21, ReceivingInstallationID: 30, DispatchInstallationID: 40},
			gateway.DiscoveryRepository{Repository: "foo/one", RepositoryID: 22, ReceivingInstallationID: 31, DispatchInstallationID: 41},
			gateway.DiscoveryRepository{Repository: "foo/two", RepositoryID: 23, ReceivingInstallationID: 31, DispatchInstallationID: 41})
	}
	document, err := json.Marshal(map[string]any{"version": 1, "control-plane": map[string]any{
		"scope": map[string]any{"allowed-owners": owners}, "webhook-gateway": config}})
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
	inventories := securityInventories{11: record}
	for _, binding := range config.Discovery.Repositories[1:] {
		inventories[binding.RepositoryID] = gateway.RepositoryInventory{RepositoryID: binding.RepositoryID,
			OwnerID: binding.ReceivingInstallationID + 100, OwnerType: "Organization", Visibility: "private",
			CommitSHA: record.CommitSHA}
	}
	scanner := &DiscoveryWorker{Policies: policies, Registry: registry, GitHub: inventories}
	if err := scanner.RunOnce(ctx); err != nil {
		t.Fatal(err)
	}
	policy, err := loader.Load(ctx)
	wantRoutes := 2
	if multiple {
		wantRoutes = 6
	}
	if err != nil || len(policy.Subscriptions) != wantRoutes {
		t.Fatalf("security declarations did not activate: subscriptions=%d err=%v", len(policy.Subscriptions), err)
	}
	_, _, receiver, destination := authorityFixture()
	receiver.installation.Permissions = map[string]string{"contents": "read", "vulnerability_alerts": "read",
		"security_events": "read", "secret_scanning_alerts": "read"}
	receiver.repository.FullName = "approved/private"
	destination.repository.ID, destination.repository.FullName = 11, "approved/private"
	destination.installation.Permissions = map[string]string{"contents": "write"}
	sources := securitySourceAPIs{}
	for _, binding := range config.Discovery.Repositories {
		source := receiver
		source.installation.ID = binding.ReceivingInstallationID
		source.installation.AccountID = inventories[binding.RepositoryID].OwnerID
		source.installation.AccountLogin = strings.Split(binding.Repository, "/")[0]
		source.repository.ID, source.repository.FullName = binding.RepositoryID, binding.Repository
		source.repository.OwnerID = source.installation.AccountID
		sources[binding.RepositoryID] = source
	}
	live := LiveAuthority{Loader: loader, Queue: queue, State: store, Receiving: sources,
		Dispatch: compilerAuthorityAPI{authorityAPI: destination, head: record.CommitSHA, digest: record.Workflows[0].SHA256,
			expectedRepository: 11, expectedInstallation: 20}}
	if err := live.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	secret := demoSecrets(bytes.Repeat([]byte("x"), 32))
	ingress := &gateway.Ingress{SourceID: gateway.CompilerSourceID, Secrets: secret, Policies: loader, Queue: queue,
		Authorizer: ReceiveAuthority{Loader: loader, Queue: queue, State: store}}
	selected := config.Discovery.Repositories
	if multiple {
		selected = selected[1:]
	}
	submit := func(binding gateway.DiscoveryRepository, number int) {
		t.Helper()
		body := []byte(fmt.Sprintf(`{"action":"created","installation":{"id":%d},"organization":{"id":%d},
			"repository":{"id":%d,"private":true,"visibility":"private","full_name":%q},"alert":{"number":%d,
			"url":"https://api.github.com/repos/%s/dependabot/alerts/%d","secret":"MUST-NOT-PERSIST",
			"security_advisory":{"severity":"critical"}}}`,
			binding.ReceivingInstallationID, inventories[binding.RepositoryID].OwnerID,
			binding.RepositoryID, binding.Repository, number, binding.Repository, number))
		request := httptest.NewRequestWithContext(ctx, http.MethodPost, "/webhooks/compiler", bytes.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-GitHub-Delivery", fmt.Sprintf("security-%d-%d", binding.RepositoryID, number))
		request.Header.Set("X-GitHub-Event", "dependabot_alert")
		mac := hmac.New(sha256.New, secret)
		_, _ = mac.Write(body)
		request.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
		response := httptest.NewRecorder()
		ingress.ServeHTTP(response, request)
		if response.Code != http.StatusAccepted {
			t.Fatalf("discovered security ingress HTTP %d", response.Code)
		}
	}
	for _, binding := range selected {
		submit(binding, 42)
		submit(binding, 43)
	}
	dispatcher := &compilerAcceptance{sources: map[int64]int{}}
	worker := gateway.Worker{Policies: loader, Queue: queue, Authorizer: live, Dispatcher: dispatcher,
		Owner: "security-contract", HTTPTimeout: time.Second, LeaseDuration: time.Minute}
	for range selected {
		if worked, err := worker.RunOnce(ctx); err != nil || !worked {
			t.Fatalf("security dispatch worked=%v calls=%d err=%v", worked, dispatcher.calls, err)
		}
	}
	if dispatcher.calls != len(selected) {
		t.Fatalf("expected one homogeneous batch per source, got %d", dispatcher.calls)
	}
	for _, binding := range selected {
		if dispatcher.sources[binding.RepositoryID] != 2 {
			t.Fatal("source deliveries lost, mixed or not sent to approved workflow", binding.RepositoryID)
		}
	}
	hints := DiscoveryHints{Policies: policies, Registry: registry}
	if multiple {
		submit(selected[0], 44)
		if _, err := hints.Observe(ctx, gateway.Event{SourceID: gateway.CompilerSourceID, Name: "repository",
			RepositoryID: selected[0].RepositoryID, InstallationID: selected[0].ReceivingInstallationID}); err != nil {
			t.Fatal(err)
		}
		remaining, err := loader.Load(ctx)
		if err != nil || len(remaining.Subscriptions) != 4 {
			t.Fatal("source invalidation retained its routes or removed unrelated selection", err)
		}
		if worked, err := worker.RunOnce(ctx); err != nil || worked || dispatcher.calls != len(selected) {
			t.Fatal("source invalidation did not fence pending delivery", err)
		}
	}
	if _, err := hints.Observe(ctx, gateway.Event{SourceID: gateway.CompilerSourceID, Name: "repository",
		RepositoryID: 11, InstallationID: 10}); err != nil {
		t.Fatal(err)
	}
	revoked, err := loader.Load(ctx)
	if err != nil || len(revoked.Subscriptions) != 0 {
		t.Fatal("invalidation retained discovered subscriptions", err)
	}
}

type securityInventories map[int64]gateway.RepositoryInventory

func (records securityInventories) DiscoverWebhookSubscriptions(_ context.Context, binding gateway.DiscoveryRepository, _ func(githubquota.ResponseQuota)) (gateway.RepositoryInventory, error) {
	record, ok := records[binding.RepositoryID]
	if !ok {
		return gateway.RepositoryInventory{}, gateway.ErrUnauthorized
	}
	return record, nil
}

type securitySourceAPIs map[int64]authorityAPI

func (sources securitySourceAPIs) WebhookGatewayInstallation(ctx context.Context, installation int64) (githubapp.GatewayInstallation, githubquota.ResponseQuota, error) {
	for _, source := range sources {
		if source.installation.ID == installation {
			return source.WebhookGatewayInstallation(ctx, installation)
		}
	}
	return githubapp.GatewayInstallation{}, githubquota.ResponseQuota{}, gateway.ErrUnauthorized
}

func (sources securitySourceAPIs) WebhookGatewayRepository(ctx context.Context, installation, repository int64, observe ...func(githubquota.ResponseQuota)) (githubapp.GatewayRepository, githubquota.ResponseQuota, error) {
	source, ok := sources[repository]
	if !ok || source.installation.ID != installation {
		return githubapp.GatewayRepository{}, githubquota.ResponseQuota{}, gateway.ErrUnauthorized
	}
	return source.WebhookGatewayRepository(ctx, installation, repository, observe...)
}
