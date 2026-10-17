package webhookgateway

import "testing"

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

func TestDomainAuthorizationAlwaysChecksSignedInstallation(t *testing.T) {
	s, event, job, snapshot := domainFixture(t)
	event.InstallationID++
	decision, err := Authorize(job.CreatedAt, s, job.SubscriptionDigest, event, snapshot)
	if err != nil || decision.Allowed || !decision.Cancel {
		t.Fatalf("signed installation mismatch accepted: %+v %v", decision, err)
	}
}
