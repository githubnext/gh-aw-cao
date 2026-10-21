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
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-cao/server/internal/operational/postgres"
	gateway "github.com/githubnext/gh-cao/server/internal/webhookgateway"
)

type externalAcceptance map[string]int

func (d externalAcceptance) Dispatch(context.Context, gateway.Subscription, json.RawMessage) gateway.DispatchResponse {
	return gateway.DispatchResponse{TransportOutcome: "not-sent"}
}

func (d externalAcceptance) DispatchCompiler(_ context.Context, subscription gateway.Subscription, payload json.RawMessage, revision gateway.Revision) gateway.DispatchResponse {
	if gateway.ValidateCompilerRevision(subscription, revision) != nil ||
		gateway.ValidateBatchDispatchPayload(subscription, payload, gateway.DefaultLimits()) != nil ||
		strings.Contains(string(payload), "MUST-NOT-PERSIST") {
		return gateway.DispatchResponse{TransportOutcome: "not-sent"}
	}
	var envelope struct {
		Payload struct {
			Context struct {
				Webhook struct {
					Deliveries []json.RawMessage `json:"deliveries"`
				} `json:"webhook"`
			} `json:"aw_context"`
		} `json:"client_payload"`
	}
	if json.Unmarshal(payload, &envelope) != nil {
		return gateway.DispatchResponse{TransportOutcome: "not-sent"}
	}
	key := subscription.Source.Event
	d[key] += len(envelope.Payload.Context.Webhook.Deliveries)
	return gateway.DispatchResponse{TransportOutcome: "response", Kind: subscription.Destination.Kind, StatusCode: http.StatusNoContent}
}

func TestExternalGatewayPostgresConformance(t *testing.T) {
	dsn := os.Getenv("POSTGRES_URL")
	if dsn == "" {
		t.Skip("POSTGRES_URL is required for external registry/ingress/worker conformance")
	}
	ctx := t.Context()
	data, err := os.ReadFile("../../../specs/fixtures/webhook-external-deliveries-v2.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures struct {
		Sources    []gateway.ExternalSource `json:"sources"`
		Deliveries []struct {
			SourceID string         `json:"sourceId"`
			Payload  map[string]any `json:"payload"`
		} `json:"deliveries"`
	}
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	config := discoveryPolicyFixture().policy.Policy
	config.Version, config.Revision, config.Workers, config.Enabled = 1, 1, 1, true
	config.Namespace = fmt.Sprintf("gateway-external-%d", time.Now().UnixNano())
	config.ExternalSources = fixtures.Sources
	for i := range config.ExternalSources {
		config.ExternalSources[i].ExpiresAt = time.Now().Add(time.Hour)
	}
	path := filepath.Join(t.TempDir(), "cao.json")
	document, err := json.Marshal(map[string]any{"version": 1, "control-plane": map[string]any{
		"scope": map[string]any{"allowed-owners": []string{"approved"}}, "webhook-gateway": config}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, document, 0600); err != nil {
		t.Fatal(err)
	}
	policies := gateway.NewPolicyLoader(path)
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
	queue, err := store.OpenWebhookQueue(ctx, "external", initial.Policy.Queue)
	if err != nil {
		t.Fatal(err)
	}
	data, err = os.ReadFile("../../../specs/fixtures/webhook-manifest-external-v2.json")
	if err != nil {
		t.Fatal(err)
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, data); err != nil {
		t.Fatal(err)
	}
	lock := append([]byte("# gh-aw-manifest: "), compact.Bytes()...)
	triggers, err := gateway.ParseWorkflowManifest(lock, ".github/workflows/test.lock.yml", gateway.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	workflow := gateway.DiscoveredWorkflow{Path: ".github/workflows/test.lock.yml", SHA256: gateway.MetadataDigest(lock)}
	for _, trigger := range triggers {
		workflow.Triggers = append(workflow.Triggers, trigger.Declaration)
	}
	record := gateway.RepositoryInventory{RepositoryID: 11, OwnerID: 12, OwnerType: "Organization", Visibility: "private",
		CommitSHA: strings.Repeat("a", 40), Workflows: []gateway.DiscoveredWorkflow{workflow}}
	registry := queue.(gateway.RegistryStore)
	loader := RegistryLoader{Base: policies, Store: registry}
	scanner := DiscoveryWorker{Policies: policies, Registry: registry, GitHub: securityInventories{11: record}}
	if err := scanner.RunOnce(ctx); err != nil {
		t.Fatal(err)
	}
	policy, err := loader.Load(ctx)
	if err != nil || len(policy.Subscriptions) != 3 {
		t.Fatal("external declarations did not activate", err)
	}
	_, _, _, destination := authorityFixture()
	destination.repository.ID, destination.repository.FullName = 11, "approved/private"
	destination.installation.Permissions = map[string]string{"contents": "write"}
	// Receiving is deliberately nil: external enrollment must not invent GitHub source access.
	live := LiveAuthority{Loader: loader, Queue: queue, State: store,
		Dispatch: compilerAuthorityAPI{authorityAPI: destination, head: record.CommitSHA, digest: workflow.SHA256,
			expectedRepository: 11, expectedInstallation: 20}}
	if err := live.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	secret := demoSecrets(bytes.Repeat([]byte("x"), 32))
	for _, delivery := range fixtures.Deliveries {
		source, _ := policy.ExternalSource(delivery.SourceID)
		delivery.Payload["timestamp"], delivery.Payload["webhookTimestamp"] = time.Now().UnixMilli(), time.Now().UnixMilli()
		handler := gateway.Ingress{SourceID: source.ID, External: true, Secrets: secret, Policies: loader, Queue: queue,
			Authorizer: ReceiveAuthority{Loader: loader, Queue: queue, State: store}}
		for _, id := range []string{"one", "two", "one"} {
			delivery.Payload["id"] = id
			body, err := json.Marshal(delivery.Payload)
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequestWithContext(ctx, http.MethodPost, "/webhooks/"+source.ID, bytes.NewReader(body))
			request.Header.Set("Content-Type", "application/json")
			mac := hmac.New(sha256.New, secret)
			_, _ = mac.Write(body)
			signature := hex.EncodeToString(mac.Sum(nil))
			switch source.Event {
			case "jira_issue":
				request.Header.Set("X-Hub-Signature", "sha256="+signature)
				request.Header.Set("X-Atlassian-Webhook-Identifier", id)
			case "linear_issue":
				request.Header.Set("Linear-Signature", signature)
				request.Header.Set("Linear-Delivery", id)
			case "azure_devops_issue":
				request.SetBasicAuth("cao", string(secret))
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusAccepted && (source.Event != "linear_issue" || response.Code != http.StatusOK) {
				t.Fatalf("%s ingress HTTP %d", source.Event, response.Code)
			}
		}
	}
	dispatcher := externalAcceptance{}
	worker := gateway.Worker{Policies: loader, Queue: queue, Authorizer: live, Dispatcher: dispatcher,
		Owner: "external-contract", HTTPTimeout: time.Second, LeaseDuration: time.Minute}
	for range 3 {
		if worked, err := worker.RunOnce(ctx); err != nil || !worked {
			t.Fatalf("external dispatch worked=%v err=%v", worked, err)
		}
	}
	if len(dispatcher) != 3 {
		t.Fatal("external providers shared a batch", dispatcher)
	}
	for key, deliveries := range dispatcher {
		if deliveries != 2 {
			t.Fatal("distinct deliveries lost or retry delivered twice", key, deliveries)
		}
	}
	previous := gateway.Job{Subscription: policy.Subscriptions[0], SubscriptionDigest: policy.Revisions[policy.Subscriptions[0].ID].Digest,
		QueueRevision: policy.Revision}
	hints := DiscoveryHints{Policies: policies, Registry: registry}
	if _, err := hints.Observe(ctx, gateway.Event{SourceID: gateway.CompilerSourceID, Name: "repository",
		RepositoryID: 11, InstallationID: 10}); err != nil {
		t.Fatal(err)
	}
	if _, err := live.Authorize(ctx, previous); err == nil {
		t.Fatal("destination invalidation retained external source authority")
	}
}
