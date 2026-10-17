package webhookgatewayhost

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/githubapp"
	"github.com/githubnext/gh-aw-cao/server/internal/githubquota"
	gateway "github.com/githubnext/gh-aw-cao/server/internal/webhookgateway"
)

type authorityPolicy struct{ policy gateway.PolicySnapshot }

func (p authorityPolicy) Load(context.Context) (gateway.PolicySnapshot, error) { return p.policy, nil }

type authorityRevision struct{ revision gateway.QueueRevision }

func (r *authorityRevision) ApplyRevision(_ context.Context, revision gateway.QueueRevision) error {
	if revision.Revision < r.revision.Revision ||
		(revision.Revision == r.revision.Revision && revision != r.revision) {
		return gateway.ErrConflict
	}
	r.revision = revision
	return nil
}

type authorityState map[string][]byte

func (s authorityState) SetOperationalState(_ context.Context, key string, value []byte) error {
	s[key] = append([]byte(nil), value...)
	return nil
}

func (s authorityState) OperationalState(_ context.Context, key string) ([]byte, error) {
	return s[key], nil
}

type authorityAPI struct {
	installation githubapp.GatewayInstallation
	repository   githubapp.GatewayRepository
	err          error
}

func (a authorityAPI) WebhookGatewayInstallation(context.Context, int64) (githubapp.GatewayInstallation, githubquota.ResponseQuota, error) {
	return a.installation, githubquota.ResponseQuota{}, a.err
}

func (a authorityAPI) WebhookGatewayRepository(context.Context, int64, int64, ...func(githubquota.ResponseQuota)) (githubapp.GatewayRepository, githubquota.ResponseQuota, error) {
	return a.repository, githubquota.ResponseQuota{}, a.err
}

func authorityFixture() (gateway.PolicySnapshot, gateway.Job, authorityAPI, authorityAPI) {
	subscription := gateway.Subscription{
		SchemaVersion: "gh-aw.webhook-subscription/v1", Provider: "github", ID: "subscription",
		TenantID: "tenant", AppID: 2,
		Source: gateway.Source{ID: "github", Event: "issues", InstallationID: 10, RepositoryID: 11,
			OrganizationID: 12, RequiredPermissions: map[string]string{"issues": "read"}},
		Destination: gateway.Destination{Kind: "workflow_dispatch", InstallationID: 20, RepositoryID: 21, Workflow: "work.yml", Ref: "main"},
		Delivery:    gateway.DeliveryPolicy{TTLSeconds: 86400, LeaseSeconds: 60, MaxAttempts: 5, RetryDelaySeconds: 10},
	}
	digest := strings.Repeat("a", 64)
	revision := gateway.QueueRevision{Revision: 1, Digest: strings.Repeat("b", 64), Enabled: true}
	policy := gateway.PolicySnapshot{
		Policy:   gateway.GatewayPolicy{ReceivingAppID: 1, DispatchAppID: 2},
		Revision: revision, Subscriptions: []gateway.Subscription{subscription}, AllowedOwners: []string{"approved"},
		Revisions: map[string]gateway.Revision{subscription.ID: {
			RepositoryID: 21, CommitSHA: strings.Repeat("c", 40), MetadataPath: "subscription.json", Digest: digest, CompilerID: "compiler",
		}},
		Grants: map[string]gateway.AdminGrant{subscription.ID: {
			SubscriptionID: subscription.ID, Digest: digest, SourceInstallationID: 10, SourceRepositoryID: 11,
			SourceOrganizationID: 12, ReceivingInstallationID: 10, DestinationInstallationID: 20,
			DestinationRepositoryID: 21, DispatchKind: "workflow_dispatch", ExpiresAt: time.Now().Add(time.Hour),
		}},
	}
	job := gateway.Job{ID: "job", DeliveryID: "delivery", Subscription: subscription, SubscriptionDigest: digest,
		QueueRevision: revision, State: gateway.Claimed, Fence: 3, Attempt: 1,
		Event: gateway.EventIdentity{SourceID: subscription.Source.ID, DeliveryID: "delivery", Name: subscription.Source.Event,
			InstallationID: 10, RepositoryID: 11, OrganizationID: 12},
		Payload: json.RawMessage(`{"ref":"main","inputs":{}}`)}
	receiver := authorityAPI{
		installation: githubapp.GatewayInstallation{ID: 10, AppID: 1, AccountID: 12, AccountType: "Organization",
			AccountLogin: "approved", Permissions: map[string]string{"issues": "read"}},
		repository: githubapp.GatewayRepository{ID: 11, OwnerID: 12, FullName: "approved/source", Visibility: "public"},
	}
	dispatcher := authorityAPI{
		installation: githubapp.GatewayInstallation{ID: 20, AppID: 2, AccountID: 12, AccountType: "Organization",
			AccountLogin: "approved", Permissions: map[string]string{"actions": "write"}},
		repository: githubapp.GatewayRepository{ID: 21, OwnerID: 12, FullName: "approved/destination", Visibility: "public"},
	}
	return policy, job, receiver, dispatcher
}

func TestIsolatedAuthorityFreshAndRevoked(t *testing.T) {
	policy, job, receiver, dispatcher := authorityFixture()
	state := authorityState{}
	revision := &authorityRevision{}
	live := LiveAuthority{Loader: authorityPolicy{policy}, Queue: revision, Receiving: receiver, Dispatch: dispatcher, State: state}
	proof, err := live.Authorize(t.Context(), job)
	if err != nil {
		t.Fatal(err)
	}
	decision, err := gateway.ValidateAuthorization(time.Now(), job, proof)
	if err != nil || !decision.Allowed {
		t.Fatalf("live authority: %+v %v", decision, err)
	}
	receive := ReceiveAuthority{Loader: authorityPolicy{policy}, Queue: revision, State: state}
	if _, err := receive.Authorize(t.Context(), job); err != nil {
		t.Fatal(err)
	}
	receiver.installation.Suspended = true
	live.Receiving = receiver
	proof, err = live.Authorize(t.Context(), job)
	if err != nil {
		t.Fatal(err)
	}
	decision, err = gateway.ValidateAuthorization(time.Now(), job, proof)
	if err != nil || decision.Allowed || !decision.Cancel {
		t.Fatalf("suspension: %+v %v", decision, err)
	}
}

func TestAuthorityCannotBroadenReviewedOrInstallationScope(t *testing.T) {
	for _, scenario := range []string{"receiving-dispatch-permission", "destination-outside-policy", "repository-transfer", "private-source", "stale-config", "missing-api"} {
		t.Run(scenario, func(t *testing.T) {
			policy, job, receiver, dispatcher := authorityFixture()
			switch scenario {
			case "receiving-dispatch-permission":
				receiver.installation.Permissions["actions"] = "write"
			case "destination-outside-policy":
				dispatcher.repository.FullName = "unapproved/destination"
			case "repository-transfer":
				receiver.repository.OwnerID = 999
			case "private-source":
				receiver.repository.Visibility = "private"
			case "stale-config":
				job.Subscription.Destination.RepositoryID++
			case "missing-api":
				dispatcher.err = errors.New("unavailable")
			}
			live := LiveAuthority{Loader: authorityPolicy{policy}, Queue: &authorityRevision{}, Receiving: receiver, Dispatch: dispatcher}
			proof, err := live.Authorize(t.Context(), job)
			if err != nil {
				return
			}
			decision, err := gateway.ValidateAuthorization(time.Now(), job, proof)
			if err == nil && decision.Allowed {
				t.Fatal("authority expanded")
			}
		})
	}
}

func TestReceiveAuthorityRejectsStaleOrReplacedProof(t *testing.T) {
	policy, job, receiver, dispatcher := authorityFixture()
	state := authorityState{}
	revision := &authorityRevision{}
	live := LiveAuthority{Loader: authorityPolicy{policy}, Queue: revision, Receiving: receiver, Dispatch: dispatcher, State: state}
	proof, err := live.Authorize(t.Context(), job)
	if err != nil {
		t.Fatal(err)
	}

	proof.CheckedAt = time.Now().Add(-time.Minute)
	proof.ExpiresAt = time.Now().Add(-30 * time.Second)
	data, err := json.Marshal(authorizationProof{Revision: policy.Revision, Snapshot: proof})
	if err != nil {
		t.Fatal(err)
	}
	state[proofKey(job.Subscription.ID)] = data
	receive := ReceiveAuthority{Loader: authorityPolicy{policy}, Queue: revision, State: state}
	if _, err := receive.Authorize(t.Context(), job); err == nil {
		t.Fatal("stale proof accepted")
	}
	revision.revision.Revision++
	if _, err := live.Authorize(t.Context(), job); !errors.Is(err, gateway.ErrConflict) {
		t.Fatalf("old replica undid applied revocation: %v", err)
	}
}

func TestReceiveAuthorityRejectsProofFromPreviousPolicy(t *testing.T) {
	policy, job, receiver, dispatcher := authorityFixture()
	state := authorityState{}
	revision := &authorityRevision{}
	live := LiveAuthority{Loader: authorityPolicy{policy}, Queue: revision, Receiving: receiver, Dispatch: dispatcher, State: state}
	if _, err := live.Authorize(t.Context(), job); err != nil {
		t.Fatal(err)
	}
	policy.Revision.Revision++
	policy.Revision.Digest = strings.Repeat("d", 64)
	policy.AllowedOwners = []string{"narrowed"}
	job.QueueRevision = policy.Revision
	receive := ReceiveAuthority{Loader: authorityPolicy{policy}, Queue: revision, State: state}
	if _, err := receive.Authorize(t.Context(), job); !errors.Is(err, gateway.ErrUnavailable) {
		t.Fatalf("previous policy's proof authorized admission after scope narrowing: %v", err)
	}
}

func TestObservedInstallationRemovalReturnsCancellationEvidence(t *testing.T) {
	policy, job, receiver, dispatcher := authorityFixture()
	dispatcher.err = &githubapp.GatewayAPIError{StatusCode: http.StatusNotFound}
	live := LiveAuthority{Loader: authorityPolicy{policy}, Queue: &authorityRevision{}, Receiving: receiver, Dispatch: dispatcher}
	proof, err := live.Authorize(t.Context(), job)
	if err != nil || !proof.Complete {
		t.Fatalf("observed access withdrawal was treated as an outage: %v", err)
	}
	decision, err := gateway.ValidateAuthorization(time.Now(), job, proof)
	if err != nil || !decision.Cancel || decision.Allowed {
		t.Fatalf("withdrawal did not cancel: %+v %v", decision, err)
	}
}

type authorityProjectAPI struct {
	authorityAPI
	quota githubquota.ResponseQuota
}

func (a authorityProjectAPI) WebhookGatewayProjectsWithQuota(_ context.Context, _, _ int64, _ []string, observe func(githubquota.ResponseQuota)) error {
	observe(a.quota)
	return nil
}

func TestAuthorityAccountsProjectResponsesInGraphQLBucket(t *testing.T) {
	for _, unavailable := range []bool{false, true} {
		t.Run(fmt.Sprint(unavailable), func(t *testing.T) {
			policy, job, receiver, dispatcher := authorityFixture()
			job.Subscription.Source.ProjectIDs = []string{"PVT_project"}
			job.Subscription.Source.IdentityConstraints = []gateway.IdentityConstraint{
				{Path: "/projects_v2_item/project_node_id", Value: json.RawMessage(`"PVT_project"`)},
			}
			policy.Subscriptions = []gateway.Subscription{job.Subscription}
			grant := policy.Grants[job.Subscription.ID]
			grant.ProjectIDs = job.Subscription.Source.ProjectIDs
			policy.Grants[job.Subscription.ID] = grant
			quota := &quotaFake{}
			if unavailable {
				quota.err = errors.New("unavailable")
			}
			live := LiveAuthority{Loader: authorityPolicy{policy}, Queue: &authorityRevision{}, Dispatch: dispatcher, Quota: quota,
				Receiving: authorityProjectAPI{authorityAPI: receiver, quota: githubquota.ResponseQuota{
					HasResponse: true, HasObservation: true, Resource: "graphql",
					Observation: githubquota.Observation{Limit: 5000, Remaining: 4999, ResetAt: time.Now().Add(time.Hour)},
					ParkUntil:   time.Now().Add(time.Minute), ParkReason: "secondary-rate-limit",
				}}}
			proof, err := live.Authorize(t.Context(), job)
			if unavailable {
				if !errors.Is(err, gateway.ErrUnavailable) || proof.Complete {
					t.Fatalf("quota storage failure authorized project access: %+v %v", proof, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			decision, err := gateway.ValidateAuthorization(time.Now(), job, proof)
			if err != nil || !decision.Allowed {
				t.Fatalf("project authorization failed: %+v %v", decision, err)
			}
			bucket := githubquota.BucketID{App: "1", Installation: 10, Resource: "graphql"}
			if len(quota.observed) != 1 || quota.observed[0] != bucket ||
				len(quota.parkedBuckets) != 1 || quota.parkedBuckets[0] != bucket {
				t.Fatalf("project quota used the wrong bucket: observed=%v parked=%v", quota.observed, quota.parkedBuckets)
			}
		})
	}
}
