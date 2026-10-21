package webhookgateway

import (
	"bytes"
	"errors"
	"testing"
)

func TestDomainAuthorizationIgnoresUndeclaredOptionalScopeIDs(t *testing.T) {
	for _, scope := range []string{"repository", "organization"} {
		t.Run(scope, func(t *testing.T) {
			s, event, job, snapshot := domainFixture(t)
			switch scope {
			case "repository":
				s.Source.OrganizationID = 0
				snapshot.SourceOrganizationID = 0
				snapshot.Grant.SourceOrganizationID = 0
			case "organization":
				s.Source.RepositoryID = 0
				snapshot.SourceRepositoryID = 0
				snapshot.Grant.SourceRepositoryID = 0
				event.RepositoryID = 0
				event.Payload = bytes.Replace(event.Payload, []byte(`"repository":{"id":30},`), nil, 1)
			default:
				t.Fatal("unsupported test scope")
			}
			decision, err := Authorize(job.CreatedAt, s, job.SubscriptionDigest, event, snapshot)
			if err != nil || !decision.Allowed {
				t.Fatalf("optional payload identity denied scoped authority: %+v %v", decision, err)
			}
			if scope == "repository" {
				snapshot.SourceRepositoryID++
			} else {
				snapshot.SourceOrganizationID++
			}
			decision, err = Authorize(job.CreatedAt, s, job.SubscriptionDigest, event, snapshot)
			if err != nil || decision.Allowed || !decision.Cancel {
				t.Fatalf("declared scope mismatch accepted: %+v %v", decision, err)
			}
		})
	}
}

func TestOrganizationSubscriptionNeverAuthorizesRepositoryDeliveries(t *testing.T) {
	s, event, job, snapshot := domainFixture(t)
	s.Source.RepositoryID = 0
	snapshot.SourceRepositoryID = 0
	snapshot.Grant.SourceRepositoryID = 0
	if err := ValidateSubscription(s, DefaultLimits()); err != nil {
		t.Fatal(err)
	}
	if matched, err := MatchSubscription(s, event, DefaultLimits()); err != nil || matched {
		t.Fatalf("organization source matched repository delivery: matched=%v err=%v", matched, err)
	}
	if _, err := NewJob(job.CreatedAt, "excluded", event, s, job.SubscriptionDigest); !errors.Is(err, ErrInvalid) {
		t.Fatalf("organization source admitted repository job: %v", err)
	}
	decision, err := Authorize(job.CreatedAt, s, job.SubscriptionDigest, event, snapshot)
	if err != nil || decision.Allowed || !decision.Cancel || decision.Reason != "identity-changed" {
		t.Fatalf("organization proof authorized repository source: %+v %v", decision, err)
	}
	job.Subscription = s
	snapshot.Fence = job.Fence
	if _, err := ValidateAuthorization(job.CreatedAt, job, snapshot); !errors.Is(err, ErrInvalid) {
		t.Fatalf("legacy repository job reused organization authority: %v", err)
	}
	if err := ValidateJob(job); !errors.Is(err, ErrInvalid) {
		t.Fatalf("invalid durable source accepted: %v", err)
	}
	if _, err := BuildDispatchBatch([]Job{job}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("organization batch included repository source: %v", err)
	}
}

func TestDomainAuthorizationAlwaysChecksSignedInstallation(t *testing.T) {
	s, event, job, snapshot := domainFixture(t)
	event.InstallationID++
	decision, err := Authorize(job.CreatedAt, s, job.SubscriptionDigest, event, snapshot)
	if err != nil || decision.Allowed || !decision.Cancel {
		t.Fatalf("signed installation mismatch accepted: %+v %v", decision, err)
	}
}
