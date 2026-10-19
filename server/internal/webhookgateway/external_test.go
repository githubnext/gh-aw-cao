package webhookgateway

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
)

type externalDeliveryFixture struct {
	SourceID string         `json:"sourceId"`
	Payload  map[string]any `json:"payload"`
	Expected map[string]any `json:"expected"`
}

func externalFixture(t *testing.T) (PolicySnapshot, RegistrySnapshot, []externalDeliveryFixture) {
	t.Helper()
	base, registry := discoveryFixture(t)
	data, err := os.ReadFile("../../../specs/fixtures/webhook-external-deliveries-v2.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Sources    []ExternalSource          `json:"sources"`
		Deliveries []externalDeliveryFixture `json:"deliveries"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	for i := range fixture.Sources {
		fixture.Sources[i].ExpiresAt = time.Now().Add(time.Hour)
	}
	for _, delivery := range fixture.Deliveries {
		if delivery.SourceID == "linear" {
			delivery.Payload["webhookTimestamp"] = time.Now().UnixMilli()
		}
		if delivery.SourceID == "generic" {
			delivery.Payload["timestamp"] = time.Now().UnixMilli()
		}
	}
	base.Policy.ExternalSources = fixture.Sources
	base.Policy.Discovery.ActivateSecurity = false
	policyPath := filepath.Join(t.TempDir(), "cao.json")
	writePolicyFixture(t, policyPath, base.Policy)
	base, err = NewPolicyLoader(policyPath).Load(t.Context())
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
	triggers, err := ParseWorkflowManifest(lock, ".github/workflows/test.lock.yml", DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	declarations := make([]CompilerTrigger, 0, len(triggers))
	for _, trigger := range triggers {
		declarations = append(declarations, trigger.Declaration)
	}
	registry.Control = base.Revision
	registry.Records[0].Workflows = []DiscoveredWorkflow{{
		Path: ".github/workflows/test.lock.yml", SHA256: MetadataDigest(lock), Triggers: declarations,
	}}
	refreshRegistryDigest(t, &registry)
	return base, registry, fixture.Deliveries
}

func externalJob(t *testing.T, policy PolicySnapshot, subscription Subscription, root map[string]any, id string) Job {
	t.Helper()
	payload, err := json.Marshal(root)
	if err != nil {
		t.Fatal(err)
	}
	event, err := parseExternalEvent(*subscription.Source.External, id, payload, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	job, err := NewJob(time.Now(), "job."+id, event, subscription, policy.Revisions[subscription.ID].Digest)
	if err != nil {
		t.Fatal(err)
	}
	job.Payload, err = buildGatewayDispatchPayload(subscription, event, policy.Revisions[subscription.ID], DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	job.QueueRevision = policy.Revision
	if err := ValidateJob(job); err != nil {
		t.Fatal(err)
	}
	return job
}

func TestExternalRegistryRequiresIndependentEnrollment(t *testing.T) {
	for _, scenario := range []string{"active", "not-enrolled", "expired", "wrong-scope", "wrong-destination", "dirty", "disabled"} {
		t.Run(scenario, func(t *testing.T) {
			base, registry, _ := externalFixture(t)
			switch scenario {
			case "not-enrolled":
				base.Policy.ExternalSources = nil
			case "expired":
				for i := range base.Policy.ExternalSources {
					base.Policy.ExternalSources[i].ExpiresAt = time.Now().Add(-time.Second)
				}
			case "wrong-scope":
				for i := range base.Policy.ExternalSources {
					base.Policy.ExternalSources[i].Scope = "different"
					base.Policy.ExternalSources[i].Types = []string{"com.example.other"}
				}
			case "wrong-destination":
				for i := range base.Policy.ExternalSources {
					base.Policy.ExternalSources[i].DestinationRepositoryIDs = []int64{99}
				}
			case "dirty":
				registry.Records[0].Dirty = true
			case "disabled":
				base.Revision.Enabled, registry.Control.Enabled, registry.Revision.Enabled = false, false, false
			}
			refreshRegistryDigest(t, &registry)
			policy, err := RegistryPolicy(base, registry, time.Now())
			if err != nil {
				t.Fatal(err)
			}
			want := 0
			if scenario == "active" {
				want = 5
			}
			if len(policy.Subscriptions) != want {
				t.Fatalf("activated %d subscriptions, want %d", len(policy.Subscriptions), want)
			}
			for _, subscription := range policy.Subscriptions {
				if subscription.Source.InstallationID != 0 || subscription.Source.RepositoryID != 0 ||
					!ExternalSourceCurrent(policy, subscription, time.Now()) ||
					policy.Grants[subscription.ID].ExternalSourceID != subscription.Source.ID {
					t.Fatal("external identity inferred GitHub authority or lost enrollment binding")
				}
			}
		})
	}
}

func TestExternalNotificationsPreserveSelectedActivitiesWithoutResourceBodies(t *testing.T) {
	base, registry, deliveries := externalFixture(t)
	policy, err := RegistryPolicy(base, registry, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	for _, delivery := range deliveries {
		t.Run(delivery.SourceID, func(t *testing.T) {
			for _, subscription := range policy.Subscriptions {
				if subscription.Source.ID != delivery.SourceID ||
					subscription.Source.Event == "webhook" && subscription.Compiler.Types[0] != "com.example.release" {
					continue
				}
				jobs := []Job{
					externalJob(t, policy, subscription, delivery.Payload, "one"),
					externalJob(t, policy, subscription, delivery.Payload, "two"),
				}
				batch, err := BuildDispatchBatch(jobs)
				if err != nil {
					t.Fatal(err)
				}
				var request compilerBatchRequest
				if err := json.Unmarshal(batch, &request); err != nil {
					t.Fatal(err)
				}
				var projection map[string]any
				if err := json.Unmarshal(request.Payload.AWContext.Webhook.Deliveries[0].Payload, &projection); err != nil {
					t.Fatal(err)
				}
				encoded, err := json.Marshal(jobs)
				if err != nil || strings.Contains(string(encoded), "MUST-NOT-PERSIST") ||
					!reflect.DeepEqual(projection, delivery.Expected) {
					t.Fatalf("incorrect minimal notification: %s %v", request.Payload.AWContext.Webhook.Deliveries[0].Payload, err)
				}
				corrupt := jobs[0]
				corrupt.Event.Activities = []string{"edited"}
				if reflect.DeepEqual(corrupt.Event, jobs[0].Event) {
					corrupt.Event.Activities = []string{"unknown"}
				}
				if !errors.Is(ValidateJob(corrupt), ErrInvalid) {
					t.Fatal("durable notification no longer bound its normalized activities")
				}
				if len(jobs[0].Event.Activities) == 0 {
					t.Fatal("normalized activity evidence was not retained separately")
				}
				malformed := bytes.ReplaceAll(batch, []byte(`"url":`), []byte(`"title":"extra","url":`))
				if ValidateBatchDispatchPayload(subscription, malformed, DefaultLimits()) == nil {
					t.Fatal("resource-detail side channel accepted")
				}
			}
		})
	}
}

func TestExternalGenericIdentifiersNeverMixInOneBatch(t *testing.T) {
	base, registry, deliveries := externalFixture(t)
	policy, err := RegistryPolicy(base, registry, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	var jobs []Job
	for _, subscription := range policy.Subscriptions {
		if subscription.Source.Event != "webhook" {
			continue
		}
		root := deliveries[3].Payload
		root["type"] = subscription.Compiler.Types[0]
		jobs = append(jobs, externalJob(t, policy, subscription, root, subscription.Compiler.Types[0]))
	}
	if len(jobs) != 2 || BatchCompatible(jobs[0], jobs[1]) {
		t.Fatal("generic identifiers shared a compatibility group")
	}
	if _, err := BuildDispatchBatch(jobs); !errors.Is(err, ErrInvalid) {
		t.Fatal("mixed generic identifiers entered one dispatch", err)
	}
	batch, err := BuildDispatchBatch(jobs[:1])
	if err != nil {
		t.Fatal(err)
	}
	other := jobs[1].Subscription.Compiler.Types[0]
	wrong := bytes.ReplaceAll(batch, []byte(jobs[0].Subscription.Compiler.Types[0]), []byte(other))
	if ValidateBatchDispatchPayload(jobs[0].Subscription, wrong, DefaultLimits()) == nil {
		t.Fatal("one generic subscription accepted another identifier")
	}
}

func TestExternalURLsAndNativeScopeFailClosed(t *testing.T) {
	base, registry, deliveries := externalFixture(t)
	policy, err := RegistryPolicy(base, registry, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	for _, subscription := range policy.Subscriptions {
		if subscription.Source.Event == "webhook" && subscription.Compiler.Types[0] != "com.example.release" {
			continue
		}
		row := slices.IndexFunc(deliveries, func(row externalDeliveryFixture) bool { return row.SourceID == subscription.Source.ID })
		payload, err := json.Marshal(deliveries[row].Payload)
		if err != nil {
			t.Fatal(err)
		}
		for _, replacement := range []string{"http://", "https://user@", "https://unapproved.example/"} {
			corrupt := bytes.Replace(payload, []byte("https://"), []byte(replacement), 1)
			// Azure references are reconstructed from enrolled collection identity.
			if subscription.Source.Event == "azure_devops_issue" {
				corrupt = bytes.ReplaceAll(payload, []byte("azure-collection"), []byte("different"))
			}
			if _, err := parseExternalEvent(*subscription.Source.External, "bad", corrupt, DefaultLimits()); err == nil {
				t.Fatal("unapproved resource reference/source scope accepted", subscription.Source.Event)
			}
		}
		if subscription.Source.Event != "webhook" {
			corrupt := bytes.ReplaceAll(payload, []byte(subscription.Source.External.Scope), []byte("different"))
			if _, err := parseExternalEvent(*subscription.Source.External, "bad", corrupt, DefaultLimits()); err == nil {
				t.Fatal("provider project/organization scope was inferred")
			}
		}
	}
}
