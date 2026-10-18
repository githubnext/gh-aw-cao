package webhookgateway

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
)

func TestCanonicalResourceURLValidationAtEveryBoundary(t *testing.T) {
	for _, raw := range []string{
		`null`, `42`, `[]`, `{}`, `""`, `"not-a-url"`, `"https://evil.example/repos/owner/repo/issues/1"`,
		`"http://api.github.com/repos/owner/repo/issues/1"`, `"//api.github.com/repos/owner/repo/issues/1"`,
		`"https://api.github.com.evil.example/repos/owner/repo/issues/1"`,
		`"https://api.github.com@evil.example/repos/owner/repo/issues/1"`,
		`"https://user@api.github.com/repos/owner/repo/issues/1"`,
		`"https://api.github.com:443/repos/owner/repo/issues/1"`,
		`"https://api.github.com/repos/owner/repo/issues/1?token=private"`,
		`"https://api.github.com/repos/owner/repo/issues/1?"`,
		`"https://api.github.com/repos/owner/repo/issues/1#private"`,
		`"https://api.github.com/repos/owner/repo/issues/1#"`,
		`"https://api.github.com/repos/owner/repo/../issues/1"`,
		`"https://api.github.com/repos//owner/repo/issues/1"`,
		`"https://api.github.com/repos/owner/repo/%2e%2e/issues/1"`,
		`"https://api.github.com/repos/owner/repo/%0Aissues/1"`,
		`"https://api.github.com/repos/owner/repo/%7Fissues/1"`,
		`"https://api.github.com/repos/owner/repo/%0Bissues/1"`,
		`"https://api.github.com/repos/owner/repo/%252e%252e/issues/1"`,
		`"https://api.github.com/repos\\owner/repo/issues/1"`,
		`"https://api.github.com/"`, `"https://api.github.com"`,
		`"https://api.github.com/repos/` + strings.Repeat("a", 2048) + `"`,
	} {
		t.Run(raw, func(t *testing.T) {
			for _, kind := range []string{"workflow_dispatch", "repository_dispatch"} {
				s, e, job, _ := domainFixture(t)
				key, selector, target := "inputs", "ref", "main"
				if kind == "repository_dispatch" {
					s.Destination.Kind, s.Destination.Workflow, s.Destination.Ref = kind, "", ""
					s.Destination.EventType = "changed"
					key, selector, target = "client_payload", "event_type", "changed"
				}
				e.Payload = json.RawMessage(`{"custom":{"url":` + raw + `}}`)
				if _, err := BuildDispatchPayload(s, e, DefaultLimits()); !errors.Is(err, ErrInvalid) {
					t.Fatalf("invalid URL forwarded over %s: %v", kind, err)
				}
				job.Subscription = s
				job.Payload = json.RawMessage(`{"` + key + `":{"url":` + raw + `},"` + selector + `":"` + target + `"}`)
				if err := ValidateDispatchPayload(s, job.Payload, DefaultLimits()); !errors.Is(err, ErrInvalid) {
					t.Fatalf("invalid URL accepted for HTTP %s: %v", kind, err)
				}
				if err := ValidateJob(job); !errors.Is(err, ErrInvalid) {
					t.Fatalf("invalid URL persisted for %s: %v", kind, err)
				}
			}
		})
	}
	for _, field := range []string{"url", "html_url"} {
		s, e, _, _ := domainFixture(t)
		s.Destination.URLPath = "/custom/" + field
		e.Payload = json.RawMessage(`{"custom":{"` + field + `":"https://github.com/approved/source/issues/50"}}`)
		payload, err := BuildDispatchPayload(s, e, DefaultLimits())
		if err != nil || string(payload) != `{"inputs":{"url":"https://github.com/approved/source/issues/50"},"ref":"main"}` {
			t.Fatalf("valid canonical URL changed: %s %v", payload, err)
		}
	}
}

func TestProjectsV2WithoutCanonicalURLCannotBeForwarded(t *testing.T) {
	payload, err := os.ReadFile("../webhookgatewayhost/testdata/projects-v2-item-edited.json")
	if err != nil {
		t.Fatal(err)
	}
	s, _, _, _ := domainFixture(t)
	s.Destination.URLPath = "/projects_v2_item/url"
	if _, err := BuildDispatchPayload(s, Event{Payload: payload}, DefaultLimits()); !errors.Is(err, ErrInvalid) {
		t.Fatal("Projects V2 event without resource URL was enriched or forwarded")
	}
}

func TestDomainJobPersistsOnlyCompiledProjectionAndCommonIdentity(t *testing.T) {
	_, event, job, snapshot := domainFixture(t)
	if string(job.Payload) != `{"inputs":{"url":"https://api.github.com/repos/approved/source/issues/50"},"ref":"main"}` ||
		job.Event != IdentityOf(event) {
		t.Fatalf("job did not compile the projection: %+v", job.Event)
	}
	encoded, err := json.Marshal(job)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "never-forward") || strings.Contains(string(encoded), `"secret"`) {
		t.Fatal("raw webhook content persisted in job")
	}
	if err := ValidateJob(job); err != nil {
		t.Fatal(err)
	}
	job.Payload = event.Payload
	if err := ValidateJob(job); !errors.Is(err, ErrInvalid) {
		t.Fatal("raw webhook accepted as a compiled payload")
	}
	_, _, job, _ = domainFixture(t)
	job.Event.RepositoryID++
	if err := ValidateJob(job); !errors.Is(err, ErrInvalid) {
		t.Fatal("immutable event scope mismatch accepted")
	}
	_, _, job, _ = domainFixture(t)
	job.Event.DeliveryID = "another-delivery"
	if err := ValidateJob(job); !errors.Is(err, ErrInvalid) {
		t.Fatal("immutable delivery mismatch accepted")
	}
	_, _, job, _ = domainFixture(t)
	job.Payload = json.RawMessage(`{"inputs":{"action":"edited","undeclared":"private"},"ref":"main"}`)
	if err := ValidateJob(job); !errors.Is(err, ErrInvalid) {
		t.Fatal("undeclared persisted dispatch property accepted")
	}
	_, _, job, _ = domainFixture(t)
	job, err = ClaimJob(job.CreatedAt, job, job.Version, 1, "worker")
	if err != nil {
		t.Fatal(err)
	}
	decision, err := ValidateAuthorization(job.CreatedAt, job, snapshot)
	if err != nil || !decision.Allowed {
		t.Fatalf("compiled job authorization depended on raw event: %+v %v", decision, err)
	}
}

func TestDomainProjectedPayloadAndOriginalDeliveryDigestAreSeparate(t *testing.T) {
	_, event, job, _ := domainFixture(t)
	if MetadataDigest(event.Payload) == MetadataDigest(job.Payload) {
		t.Fatal("fixture did not distinguish source from projection")
	}
	a := Admission{Revision: job.QueueRevision, DeliveryID: event.DeliveryID,
		DeliveryDigest: MetadataDigest(event.Payload), Jobs: []Job{job}}
	if err := ValidateAdmission(a, domainQueueOptions()); err != nil {
		t.Fatal("original signed delivery digest must not be replaced by projected payload hash", err)
	}
}
