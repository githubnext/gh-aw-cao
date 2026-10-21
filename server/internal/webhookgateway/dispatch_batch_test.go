package webhookgateway

import (
	"bytes"
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"
)

func batchJobFixture(t *testing.T, delivery string, item int) Job {
	t.Helper()
	sub, policy := shellFixture()
	event := Event{SourceID: sub.Source.ID, DeliveryID: delivery, Name: sub.Source.Event, Action: "edited",
		InstallationID: 10, OrganizationID: 20}
	event.Payload, _ = json.Marshal(map[string]any{"action": "edited", "installation": map[string]any{"id": 10},
		"organization": map[string]any{"id": 20}, "projects_v2_item": map[string]any{"id": item}})
	job, err := NewJob(time.Now().Add(-time.Minute), "job-"+delivery, event, sub, policy.Revisions[sub.ID].Digest)
	if err != nil {
		t.Fatal(err)
	}
	job.Payload, err = buildGatewayDispatchPayload(sub, event, policy.Revisions[sub.ID], DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	job.QueueRevision = policy.Revision
	return job
}

func TestBatchUniqueContextsAndCompleteProvenance(t *testing.T) {
	jobs := []Job{batchJobFixture(t, "three", 9), batchJobFixture(t, "two", 10), batchJobFixture(t, "one", 9)}
	payload, err := BuildDispatchBatch(jobs)
	if err != nil {
		t.Fatal(err)
	}
	var request struct {
		ClientPayload struct {
			Version    int               `json:"schema_version"`
			Event      string            `json:"event"`
			Contexts   []json.RawMessage `json:"aw_context"`
			Deliveries []string          `json:"delivery_ids"`
			Gateway    batchProvenance   `json:"_gateway"`
		} `json:"client_payload"`
	}
	if err := json.Unmarshal(payload, &request); err != nil {
		t.Fatal(err)
	}
	p := request.ClientPayload
	if p.Version != 2 || p.Event != "projects_v2_item" || len(p.Contexts) != 2 ||
		!slices.Equal(p.Deliveries, []string{"one", "three", "two"}) || !digestOK(p.Gateway.BatchID) {
		t.Fatalf("lost uniqueness or delivery provenance: %s", payload)
	}
	slices.Reverse(jobs)
	reordered, err := BuildDispatchBatch(jobs)
	if err != nil || !bytes.Equal(payload, reordered) {
		t.Fatal("batch order changed stable envelope", err)
	}
	singleton, err := BuildDispatchBatch(jobs[:1])
	if err != nil || !bytes.Contains(singleton, []byte(`"aw_context":[`)) {
		t.Fatal("singleton lost array shape", err)
	}
	if ValidateBatchDispatchPayload(jobs[0].Subscription, jobs[0].Payload, DefaultLimits()) == nil {
		t.Fatal("legacy singleton envelope accepted")
	}
}

func TestBatchCannotCrossAuthorityOrEventBoundaries(t *testing.T) {
	for _, mutate := range []struct {
		name string
		fn   func(*Job)
	}{
		{"source-repository", func(j *Job) { j.Event.RepositoryID++ }},
		{"source-organization", func(j *Job) { j.Event.OrganizationID++ }},
		{"source-installation", func(j *Job) { j.Event.InstallationID++ }},
		{"event", func(j *Job) { j.Event.Name = "issues" }},
		{"revision", func(j *Job) { j.QueueRevision.Revision++ }},
		{"digest", func(j *Job) { j.SubscriptionDigest = strings.Repeat("d", 64) }},
		{"subscription", func(j *Job) { j.Subscription.ID = "another" }},
		{"destination", func(j *Job) { j.Subscription.Destination.RepositoryID++ }},
	} {
		t.Run(mutate.name, func(t *testing.T) {
			jobs := []Job{batchJobFixture(t, "one", 9), batchJobFixture(t, "two", 10)}
			mutate.fn(&jobs[1])
			if _, err := BuildDispatchBatch(jobs); err == nil {
				t.Fatal("incompatible jobs batched")
			}
		})
	}
}

func TestBatchRejectsEmptyRepeatedOversizedAndMalformedContexts(t *testing.T) {
	job := batchJobFixture(t, "one", 9)
	for _, jobs := range [][]Job{nil, {job, job}, make([]Job, MaxDispatchBatchItems+1)} {
		if _, err := BuildDispatchBatch(jobs); err == nil {
			t.Fatal("invalid member set accepted")
		}
	}
	payload, err := BuildDispatchBatch([]Job{job})
	if err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []string{"empty", "duplicate", "scalar", "unknown-field", "wrong-kind", "duplicate-delivery", "wrong-version"} {
		t.Run(scenario, func(t *testing.T) {
			var request map[string]any
			if err := json.Unmarshal(payload, &request); err != nil {
				t.Fatal(err)
			}
			p := request["client_payload"].(map[string]any)
			switch scenario {
			case "empty":
				p["aw_context"] = []any{}
			case "duplicate":
				element := p["aw_context"].([]any)[0]
				p["delivery_ids"] = []string{"one", "two"}
				p["aw_context"] = []any{element, element}
			case "scalar":
				p["aw_context"] = []any{9}
			case "unknown-field":
				p["aw_context"].([]any)[0].(map[string]any)["secret"] = "not-allowed"
			case "wrong-kind":
				p["event"] = "issues"
			case "duplicate-delivery":
				p["delivery_ids"] = []string{"one", "one"}
			case "wrong-version":
				p["schema_version"] = 1
			}
			corrupt, _ := json.Marshal(request)
			if ValidateBatchDispatchPayload(job.Subscription, corrupt, DefaultLimits()) == nil {
				t.Fatal("invalid batch envelope accepted")
			}
		})
	}
	l := DefaultLimits()
	l.MaxDispatchBytes = len(payload)
	if ValidateBatchDispatchPayload(job.Subscription, payload, l) != nil {
		t.Fatal("exact byte boundary rejected")
	}
	l.MaxDispatchBytes--
	if ValidateBatchDispatchPayload(job.Subscription, payload, l) == nil {
		t.Fatal("one-byte excess accepted")
	}
}

func TestLegacyCompilerDiscoveryCannotAutoactivate(t *testing.T) {
	base, registry := discoveryFixture(t)
	triggers, err := ParseWorkflowManifest(manifestFixture(t), ".github/workflows/test.lock.yml", DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	registry.Records[0].Workflows[0].Triggers = nil
	for _, trigger := range triggers {
		registry.Records[0].Workflows[0].Triggers = append(registry.Records[0].Workflows[0].Triggers, trigger.Declaration)
	}
	refreshRegistryDigest(t, &registry)
	policy, err := RegistryPolicy(base, registry, time.Now())
	if err != nil || len(policy.Subscriptions) != 0 {
		t.Fatal("single-event compiler declaration activated", err)
	}
}
