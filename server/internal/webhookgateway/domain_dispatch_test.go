package webhookgateway

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestDomainCompleteDispatchRequestValidation(t *testing.T) {
	s, _, job, _ := domainFixture(t)
	if err := ValidateDispatchPayload(s, job.Payload, DefaultLimits()); err != nil {
		t.Fatal(err)
	}
	for _, payload := range []string{
		`{"action":"edited"}`,
		`{"ref":"wrong","inputs":{"action":"edited"}}`,
		`{"ref":"main","inputs":{"ref":"main","inputs":{"action":"edited"}}}`,
		`{"ref":"main","inputs":{"action":"edited","extra":"undeclared"}}`,
		`{"ref":"main","inputs":{}}`,
		`{"ref":"main","inputs":{"action":["edited"]}}`,
		`{"ref":"main","inputs":{"action":null}}`,
		`{"ref":"main","inputs":{"action":"edited"},"extra":1}`,
	} {
		if err := ValidateDispatchPayload(s, json.RawMessage(payload), DefaultLimits()); !errors.Is(err, ErrInvalid) {
			t.Fatalf("invalid/double-wrapped dispatch accepted: %s %v", payload, err)
		}
	}
}

func TestDomainProvenanceIsTypedAndBoundToImmutableJob(t *testing.T) {
	s, _, job, snapshot := domainFixture(t)
	s.Destination.GatewayInput = true
	job.Subscription = s
	p := dispatchProvenance{Version: "cao.webhook/v1", SourceID: job.Event.SourceID,
		DeliveryID: job.DeliveryID, SubscriptionID: s.ID, Revision: snapshot.CurrentRevision}
	makePayload := func(value any) json.RawMessage {
		t.Helper()
		data, err := json.Marshal(map[string]any{"ref": "main",
			"inputs": map[string]any{"action": "edited", "_gateway": value}})
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	encoded, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	job.Payload = makePayload(string(encoded))
	if err := ValidateJob(job); err != nil {
		t.Fatal(err)
	}
	if err := ValidateDispatchPayload(s, job.Payload, DefaultLimits()); err != nil {
		t.Fatal(err)
	}
	job.Payload = makePayload(p)
	if err := ValidateDispatchPayload(s, job.Payload, DefaultLimits()); !errors.Is(err, ErrInvalid) {
		t.Fatal("nested object sent to workflow input")
	}
	job.Payload = makePayload(string(encoded))
	s.Destination.GatewayInput = false
	if err := ValidateDispatchPayload(s, job.Payload, DefaultLimits()); !errors.Is(err, ErrInvalid) {
		t.Fatal("undeclared reserved workflow input accepted")
	}
	p.Revision.Digest = MetadataDigest([]byte("wrong-revision"))
	encoded, err = json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	job.Payload = makePayload(string(encoded))
	if err := ValidateJob(job); !errors.Is(err, ErrInvalid) {
		t.Fatal("job accepted spoofed provenance digest")
	}
}
