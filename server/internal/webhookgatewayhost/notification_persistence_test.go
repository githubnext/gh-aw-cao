package webhookgatewayhost

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/operational/postgres"
	gateway "github.com/githubnext/gh-aw-cao/server/internal/webhookgateway"
)

func TestNotificationPostgresRestartAndReadOnlyLiveDispatch(t *testing.T) {
	dsn := os.Getenv("POSTGRES_URL")
	if dsn == "" {
		t.Skip("POSTGRES_URL is required for notification durability conformance")
	}
	policy, previous, consumer, writes := labelConsumerFixture(t)
	s := previous.Subscription
	s.Source.Event, s.Compiler.Event, s.Source.RequiredPermissions = "pull_request_comment", "pull_request_comment",
		map[string]string{"contents": "read", "pull_requests": "read"}
	s.Compiler.CommandFilter, s.Compiler.NativeEvents, s.Compiler.Types = nil, []string{"issue_comment"}, []string{"created"}
	policy.Policy.Discovery.ActivateCommands = false
	policy.Policy.Discovery.ActivateNotifications = true
	policy.Policy.Discovery.Repositories[0].AllowLabelRemoval = false
	policy.Subscriptions = []gateway.Subscription{s}
	original := []byte(`{"action":"created","installation":{"id":10},"organization":{"id":12},
		"repository":{"id":11,"private":true,"full_name":"approved/source"},
		"issue":{"number":42,"pull_request":{}},"comment":{"id":99,
		"html_url":"https://github.com/approved/source/pull/42#issuecomment-99","body":"MUST-NOT-PERSIST"}}`)
	event, err := gateway.ParseEvent("notification.postgres", "issue_comment", original, gateway.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	event.SourceID = gateway.CompilerSourceID
	revision := policy.Revisions[s.ID]
	job, err := gateway.NewJob(time.Now(), "notification.job", event, s, revision.Digest)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := gateway.BuildDispatchPayload(s, event, gateway.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	var request map[string]any
	if err := json.Unmarshal(payload, &request); err != nil {
		t.Fatal(err)
	}
	request["client_payload"].(map[string]any)["_gateway"] = map[string]any{
		"version": "cao.webhook/v1", "sourceId": s.Source.ID, "deliveryId": event.DeliveryID,
		"subscriptionId": s.ID, "revision": revision,
	}
	job.Payload, err = json.Marshal(request)
	job.QueueRevision = policy.Revision
	if err != nil || gateway.ValidateJob(job) != nil || bytes.Contains(job.Payload, []byte("MUST-NOT-PERSIST")) {
		t.Fatal("invalid minimal durable notification", err)
	}
	namespace := "notification-" + gateway.MetadataDigest([]byte(t.Name() + time.Now().String()))[:24]
	store, err := postgres.New(t.Context(), dsn, namespace, postgres.Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := store.DeleteNamespace(ctx); err != nil {
			t.Error(err)
		}
		_ = store.Close()
	})
	rate := gateway.RateBudget{Capacity: 10, Period: time.Minute}
	options := gateway.QueueOptions{MaxRows: 100, MaxBytes: 1 << 20, MaxTenantRows: 50, MaxTenantBytes: 1 << 19,
		MaxSourceRows: 50, MaxSourceBytes: 1 << 19, MaxDestinationRows: 50, MaxDestinationBytes: 1 << 19,
		MaxPayloadBytes: 1 << 18, MaxBatch: 10, MaxConcurrency: 2, MaxAge: 24 * time.Hour,
		DedupWindow: 24 * time.Hour, TerminalRetention: 48 * time.Hour, LeaseDuration: time.Minute,
		Rates: gateway.RateBudgets{Global: rate, App: rate, Tenant: rate, Destination: rate, Workflow: rate}}
	queue, err := store.OpenWebhookQueue(t.Context(), "notifications", options)
	if err != nil {
		t.Fatal(err)
	}
	if err := queue.ApplyRevision(t.Context(), policy.Revision); err != nil {
		t.Fatal(err)
	}
	if _, err := queue.AdmitBatch(t.Context(), gateway.Admission{Revision: policy.Revision, DeliveryID: event.DeliveryID,
		DeliveryDigest: gateway.MetadataDigest(original), Jobs: []gateway.Job{job}}); err != nil {
		t.Fatal(err)
	}
	reopened, err := postgres.Open(t.Context(), dsn, namespace, postgres.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reopened.Close() }()
	queue, err = reopened.OpenWebhookQueue(t.Context(), "notifications", options)
	if err != nil {
		t.Fatal(err)
	}
	live := consumer.Authority
	live.Queue, live.State = queue, reopened
	receiver := live.Receiving.(authorityAPI)
	receiver.installation.Permissions = map[string]string{"contents": "read", "pull_requests": "read"}
	live.Receiving = receiver
	dispatcher := externalAcceptance{}
	worker := gateway.Worker{Policies: labelPolicy{policy}, Queue: queue, Authorizer: live, Dispatcher: dispatcher,
		Owner: "notification-worker", HTTPTimeout: time.Second, LeaseDuration: time.Minute}
	if worked, err := worker.RunOnce(t.Context()); err != nil || !worked || dispatcher[s.Source.Event] != 1 ||
		writes.calls != 0 || gateway.RequiresLabelRemoval(s) {
		t.Fatal("notification restart/read-only dispatch failed", worked, dispatcher, err)
	}
}
