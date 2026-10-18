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

func TestDomainDispatchRejectsDataAndProvenanceAlongsideURL(t *testing.T) {
	for _, kind := range []string{"workflow_dispatch", "repository_dispatch"} {
		s, _, job, _ := domainFixture(t)
		key, selector := "inputs", "ref"
		value := "main"
		if kind == "repository_dispatch" {
			s.Destination.Kind, s.Destination.Workflow, s.Destination.Ref = kind, "", ""
			s.Destination.EventType = "changed"
			key, selector, value = "client_payload", "event_type", "changed"
		}
		job.Subscription = s
		for _, extra := range []string{"body", "action", "id", "_gateway"} {
			payload, err := json.Marshal(map[string]any{selector: value, key: map[string]any{
				"url": "https://api.github.com/repos/approved/source/issues/50", extra: "must-not-forward",
			}})
			if err != nil {
				t.Fatal(err)
			}
			job.Payload = payload
			if err := ValidateDispatchPayload(s, payload, DefaultLimits()); !errors.Is(err, ErrInvalid) {
				t.Fatalf("%s accepted extra %s", kind, extra)
			}
			if err := ValidateJob(job); !errors.Is(err, ErrInvalid) {
				t.Fatalf("durable %s job accepted extra %s", kind, extra)
			}
		}
	}
}
