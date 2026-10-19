package webhookgateway

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestDomainJobPersistsOnlyCompiledProjectionAndCommonIdentity(t *testing.T) {
	_, event, job, snapshot := domainFixture(t)
	if string(job.Payload) != `{"inputs":{"action":"edited"},"ref":"main"}` ||
		!reflect.DeepEqual(job.Event, IdentityOf(event)) {
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
