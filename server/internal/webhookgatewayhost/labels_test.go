package webhookgatewayhost

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/githubnext/gh-cao/server/internal/githubquota"
	"github.com/githubnext/gh-cao/server/internal/operational/memory"
	gateway "github.com/githubnext/gh-cao/server/internal/webhookgateway"
)

type labelPolicy struct{ policy *gateway.PolicySnapshot }

func (p labelPolicy) Load(context.Context) (gateway.PolicySnapshot, error) { return *p.policy, nil }

type labelReceiptState struct {
	mu      sync.Mutex
	values  map[string][]byte
	failPut bool
}

func (s *labelReceiptState) OperationalState(_ context.Context, name string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]byte(nil), s.values[name]...), nil
}

func (s *labelReceiptState) SetExpiringOperationalState(_ context.Context, name string, value []byte, ttl time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failPut {
		return gateway.ErrUnavailable
	}
	if ttl <= 7*24*time.Hour {
		return gateway.ErrInvalid
	}
	s.values[name] = append([]byte(nil), value...)
	return nil
}

type labelWriteAPI struct {
	calls, writes int
	before        func()
	err           error
}

func (a *labelWriteAPI) WebhookGatewayConsumeLabel(_ context.Context, _ gateway.Subscription, target gateway.LabelRemoval,
	before func() error, observe func(githubquota.ResponseQuota),
) error {
	a.calls++
	if a.before != nil {
		a.before()
	}
	if target.Repository != "approved/source" || target.Label != "ready" || target.Number != 42 {
		return gateway.ErrInvalid
	}
	observe(githubquota.ResponseQuota{Resource: "core", HasObservation: true,
		Observation: githubquota.Observation{Limit: 5000, Remaining: 4999, ResetAt: time.Now().Add(time.Hour)}})
	if err := before(); err != nil {
		return err
	}
	a.writes++
	return a.err
}

func labelConsumerFixture(t *testing.T) (*gateway.PolicySnapshot, gateway.Job, LabelConsumer, *labelWriteAPI) {
	t.Helper()
	policy, job, receiver, dispatcher := authorityFixture()
	data, err := os.ReadFile("../../../specs/fixtures/webhook-manifest-commands-v2.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Triggers []gateway.CompilerTrigger `json:"webhook_subscriptions"`
	}
	if json.Unmarshal(data, &manifest) != nil || len(manifest.Triggers) != 2 {
		t.Fatal("invalid command fixture")
	}
	trigger := manifest.Triggers[1]
	trigger.CommandFilter.Events, trigger.NativeEvents = []string{"issues"}, []string{"issues"}
	trigger.Repos = []string{"approved/*"}
	s := &job.Subscription
	s.Source.ID, s.Source.Event, s.Source.ServerURL = gateway.CompilerSourceID, "label_command", "https://github.com"
	s.Source.RequiredPermissions = map[string]string{"contents": "read", "issues": "write"}
	s.Compiler, s.Destination.Kind, s.Destination.Workflow, s.Destination.Ref = &trigger, "repository_dispatch", "", ""
	s.Destination.EventType = trigger.Dispatch.EventType
	policy.Subscriptions = []gateway.Subscription{*s}
	policy.Policy.Discovery = &gateway.DiscoveryPolicy{ActivateCommands: true, Repositories: []gateway.DiscoveryRepository{
		{Repository: "approved/source", RepositoryID: 11, ReceivingInstallationID: 10, DispatchInstallationID: 20, AllowLabelRemoval: true},
	}}
	revision := policy.Revisions[s.ID]
	revision.MetadataPath = trigger.Dispatch.Workflow
	policy.Revisions[s.ID] = revision
	grant := policy.Grants[s.ID]
	grant.DispatchKind = "repository_dispatch"
	policy.Grants[s.ID] = grant
	job.Event.SourceID, job.Event.Name, job.Event.CommandEvent, job.Event.Action = gateway.CompilerSourceID, "label_command", "issues", "labeled"
	job.CreatedAt, job.ExpiresAt, job.LeaseUntil = time.Now(), time.Now().Add(time.Hour), time.Now().Add(time.Minute)
	job.Version, job.State, job.ClaimID = 1, gateway.Dispatching, "batch.fixture"
	job.Payload, err = json.Marshal(map[string]any{"event_type": trigger.Dispatch.EventType, "client_payload": map[string]any{
		"schema_version": 1, "event": "label_command", "delivery_id": job.DeliveryID,
		"payload": map[string]any{"url": "https://github.com/approved/source/issues/42", "type": []string{"labeled"},
			"filters": map[string]any{"event": []string{"issues"}, "label": []string{"ready"}}},
		"_gateway": map[string]any{"version": "cao.webhook/v1", "sourceId": s.Source.ID, "deliveryId": job.DeliveryID,
			"subscriptionId": s.ID, "revision": revision},
	}})
	if err != nil || gateway.ValidateJob(job) != nil {
		t.Fatal("invalid admitted label fixture", err)
	}
	receiver.installation.Permissions = map[string]string{"contents": "read", "issues": "write"}
	dispatcher.installation.Permissions = map[string]string{"contents": "write"}
	deliveries, err := memory.New(memory.Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = deliveries.Close() })
	api := &labelWriteAPI{}
	consumer := LabelConsumer{ReceivingApp: 1, GitHub: api, Deliveries: deliveries, Quota: &quotaFake{},
		Receipts: &labelReceiptState{values: make(map[string][]byte)},
		Authority: LiveAuthority{Loader: labelPolicy{&policy}, Queue: &authorityRevision{}, Receiving: receiver,
			Dispatch: compilerAuthorityAPI{authorityAPI: dispatcher, head: revision.CommitSHA, digest: revision.Digest}}}
	return &policy, job, consumer, api
}

func TestLabelConsumptionDurabilityAndAmbiguousReplay(t *testing.T) {
	for _, scenario := range []string{"confirmed", "ambiguous", "receipt-unavailable"} {
		t.Run(scenario, func(t *testing.T) {
			_, job, consumer, api := labelConsumerFixture(t)
			if scenario == "ambiguous" {
				api.err = errors.New("response lost")
			}
			if scenario == "receipt-unavailable" {
				consumer.Receipts.(*labelReceiptState).failPut = true
			}
			first := consumer.ConsumeLabels(t.Context(), []gateway.Job{job})
			if (first == nil) != (scenario == "confirmed") || api.writes != 1 {
				t.Fatal("label mutation knowledge was not preserved", first)
			}
			restarted := consumer
			second := restarted.ConsumeLabels(t.Context(), []gateway.Job{job})
			if (second == nil) != (scenario == "confirmed") || api.writes != 1 {
				t.Fatal("a repeated delivery removed a potentially reapplied label", second)
			}
		})
	}
}

func TestLabelConsumptionRechecksWriteAuthorityImmediatelyBeforeMutation(t *testing.T) {
	for _, scenario := range []string{"withdrawn-grant", "disabled", "new-origin", "expired-lease", "not-admitted", "quota-unavailable"} {
		t.Run(scenario, func(t *testing.T) {
			policy, job, consumer, api := labelConsumerFixture(t)
			switch scenario {
			case "withdrawn-grant":
				api.before = func() { policy.Policy.Discovery.Repositories[0].AllowLabelRemoval = false }
			case "disabled":
				api.before = func() { policy.Policy.Discovery.ActivateCommands = false }
			case "new-origin":
				api.before = func() { policy.Policy.Discovery.ServerURL = "https://other.example" }
			case "expired-lease":
				job.LeaseUntil = time.Now().Add(-time.Second)
			case "not-admitted":
				job.State = gateway.Ready
			case "quota-unavailable":
				consumer.Quota = &quotaFake{err: errors.New("unavailable")}
			}

			if consumer.ConsumeLabels(t.Context(), []gateway.Job{job}) == nil || api.writes != 0 {
				t.Fatal("unreviewed, unfenced or unbudgeted mutation executed")
			}
		})
	}
}
