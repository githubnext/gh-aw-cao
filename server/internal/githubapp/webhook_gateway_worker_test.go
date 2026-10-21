package githubapp

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-cao/server/internal/webhookgateway"
)

type gatewayWorkerQueue struct {
	webhookgateway.Queue
	job webhookgateway.Job
}

func (q *gatewayWorkerQueue) ApplyRevision(context.Context, webhookgateway.QueueRevision) error {
	return nil
}

func (q *gatewayWorkerQueue) Maintain(context.Context, int) (webhookgateway.MaintenanceResult, error) {
	return webhookgateway.MaintenanceResult{}, nil
}

func (q *gatewayWorkerQueue) Claim(_ context.Context, request webhookgateway.ClaimRequest) (*webhookgateway.Job, error) {
	job, err := webhookgateway.ClaimJob(time.Now(), q.job, q.job.Version, q.job.Fence+1, request.Owner)
	q.job = job
	return &q.job, err
}

func (q *gatewayWorkerQueue) Renew(_ context.Context, _ webhookgateway.Fence, lease time.Duration) (webhookgateway.Job, error) {
	q.job.Version++
	q.job.LeaseUntil = time.Now().Add(lease)
	return q.job, nil
}

func (q *gatewayWorkerQueue) BeginDispatch(_ context.Context, fence webhookgateway.Fence, auth webhookgateway.Authorization) (webhookgateway.Job, error) {
	now := time.Now()
	if err := webhookgateway.ValidateDispatchAuthorization(q.job, auth, now); err != nil {
		return webhookgateway.Job{}, err
	}
	job, err := webhookgateway.StartDispatch(now, q.job, fence.Generation, fence.Owner, webhookgateway.AuthorizationDecision{Allowed: true})
	q.job = job
	return job, err
}

func (q *gatewayWorkerQueue) Finish(_ context.Context, fence webhookgateway.Fence, outcome webhookgateway.Outcome) (webhookgateway.Job, error) {
	job, err := webhookgateway.FinishDispatch(time.Now(), q.job, fence.Generation, fence.Owner, webhookgateway.DispatchResult{
		Outcome: string(outcome.State), Reason: outcome.Reason, RetryAt: outcome.NotBefore,
		AcceptedStatus: outcome.AcceptedStatus, WorkflowRunID: outcome.WorkflowRunID,
	})
	q.job = job
	return job, err
}

func (q *gatewayWorkerQueue) ClaimBatch(ctx context.Context, request webhookgateway.ClaimRequest) ([]webhookgateway.Job, error) {
	job, err := q.Claim(ctx, request)
	if err != nil {
		return nil, err
	}
	return []webhookgateway.Job{*job}, nil
}

func (q *gatewayWorkerQueue) BeginDispatchBatch(ctx context.Context, fences []webhookgateway.Fence, evidence []webhookgateway.Authorization) ([]webhookgateway.Job, error) {
	job, err := q.BeginDispatch(ctx, fences[0], evidence[0])
	return []webhookgateway.Job{job}, err
}

func (q *gatewayWorkerQueue) FinishBatch(ctx context.Context, fences []webhookgateway.Fence, outcome webhookgateway.Outcome) ([]webhookgateway.Job, error) {
	job, err := q.Finish(ctx, fences[0], outcome)
	return []webhookgateway.Job{job}, err
}

type gatewayWorkerPolicy struct{ snapshot webhookgateway.PolicySnapshot }

func (p gatewayWorkerPolicy) Load(context.Context) (webhookgateway.PolicySnapshot, error) {
	return p.snapshot, nil
}

type gatewayWorkerAuthorizer struct{ revision webhookgateway.Revision }

func (a gatewayWorkerAuthorizer) Authorize(_ context.Context, job webhookgateway.Job) (webhookgateway.AuthorizationSnapshot, error) {
	now := time.Now()
	source, destination := job.Subscription.Source, job.Subscription.Destination
	return webhookgateway.AuthorizationSnapshot{
		Complete: true, JobID: job.ID, Fence: job.Fence, Attempt: job.Attempt + 1,
		CheckedAt: now, ExpiresAt: now.Add(10 * time.Second), CurrentRevision: a.revision,
		SourceAccessible: true, DestinationAccessible: true, SourcePermissionsOK: true, DispatchPermissionsOK: true,
		SourceInstallationID: source.InstallationID, ReceivingInstallationID: source.InstallationID,
		SourceRepositoryID: source.RepositoryID, DestinationInstallationID: destination.InstallationID,
		DestinationRepositoryID: destination.RepositoryID, SourceVisibility: "private", DestinationVisibility: "private",
		Grant: webhookgateway.AdminGrant{
			SubscriptionID: job.Subscription.ID, Digest: job.SubscriptionDigest,
			SourceInstallationID: source.InstallationID, SourceRepositoryID: source.RepositoryID,
			ReceivingInstallationID: source.InstallationID, DestinationInstallationID: destination.InstallationID,
			DestinationRepositoryID: destination.RepositoryID, DispatchKind: destination.Kind, ExpiresAt: now.Add(time.Hour),
		},
	}, nil
}

func TestWebhookGatewayWorkerToHTTPPreservesCompleteRequest(t *testing.T) {
	subscription := gatewayTestSubscription("repository_dispatch")
	path := "/safe"
	subscription.Destination.Fields = []webhookgateway.PayloadField{{Name: "selected", Path: &path, Required: true}}
	event, err := webhookgateway.ParseEvent("delivery", "issues", []byte(`{"installation":{"id":7},"repository":{"id":42},"safe":"chosen","secret":"never-forward"}`), webhookgateway.Limits{})
	if err != nil {
		t.Fatal(err)
	}
	event.SourceID = subscription.Source.ID
	digest := strings.Repeat("b", 64)
	job, err := webhookgateway.NewJob(time.Now(), "job", event, subscription, digest)
	if err != nil {
		t.Fatal(err)
	}
	policy := webhookgateway.QueueRevision{Revision: 1, Digest: strings.Repeat("a", 64), Enabled: true}
	job.QueueRevision = policy
	revision := webhookgateway.Revision{RepositoryID: 42, CommitSHA: strings.Repeat("c", 40), MetadataPath: "compiled/metadata.json", Digest: digest, CompilerID: "gh-aw"}
	job.Payload, err = json.Marshal(map[string]any{"event_type": subscription.Destination.EventType,
		"client_payload": map[string]any{"selected": "chosen", "_gateway": map[string]any{
			"version": "cao.webhook/v1", "sourceId": subscription.Source.ID, "deliveryId": "delivery",
			"subscriptionId": subscription.ID, "revision": revision}}})
	if err != nil {
		t.Fatal(err)
	}
	queue := &gatewayWorkerQueue{job: job}
	posts := 0
	client := gatewayTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if gatewayAuthorityResponse(w, r) {
			return
		}
		posts++
		if queue.job.State != webhookgateway.Dispatching {
			t.Error("HTTP preceded durable dispatch reservation")
		}
		var request struct {
			EventType string                     `json:"event_type"`
			Payload   map[string]json.RawMessage `json:"client_payload"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
		}
		if request.EventType != subscription.Destination.EventType || string(request.Payload["aw_context"]) != `[{"selected":"chosen"}]` ||
			len(request.Payload) != 5 {
			t.Errorf("incorrect real worker HTTP body: %+v", request)
		}
		w.WriteHeader(http.StatusNoContent)
	})
	worker := webhookgateway.Worker{
		Policies: gatewayWorkerPolicy{snapshot: webhookgateway.PolicySnapshot{
			Revision: policy, Revisions: map[string]webhookgateway.Revision{subscription.ID: revision},
		}},
		Queue: queue, Authorizer: gatewayWorkerAuthorizer{revision: revision},
		Dispatcher: WebhookGatewayDispatcher{Client: client}, Owner: "worker",
		HTTPTimeout: time.Second, FinishTimeout: time.Second,
	}
	worked, err := worker.RunOnce(context.Background())
	if err != nil || !worked || posts != 1 || queue.job.State != webhookgateway.Succeeded || queue.job.AcceptedStatus != 204 {
		t.Fatalf("worked=%t err=%v posts=%d state=%s acceptance=%d", worked, err, posts, queue.job.State, queue.job.AcceptedStatus)
	}
}
