package webhookgateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type shellPolicy struct {
	snapshot PolicySnapshot
	load     func() (PolicySnapshot, error)
}

func (p shellPolicy) Load(context.Context) (PolicySnapshot, error) {
	if p.load != nil {
		return p.load()
	}
	return p.snapshot, nil
}

type shellSecrets struct{}

func (shellSecrets) WebhookSecrets(context.Context, string) ([]byte, []byte, error) {
	return []byte("current"), []byte("previous"), nil
}

type shellAuthorizer struct {
	calls int
	fn    func(Job) (AuthorizationSnapshot, error)
}

func (a *shellAuthorizer) Authorize(_ context.Context, job Job) (AuthorizationSnapshot, error) {
	a.calls++
	if a.fn != nil {
		return a.fn(job)
	}
	event := job.Event
	now := time.Now()
	source, destination := job.Subscription.Source, job.Subscription.Destination
	return AuthorizationSnapshot{
		Complete: true, JobID: job.ID, Fence: job.Fence, Attempt: job.Attempt + 1,
		SourceAccessible: true, DestinationAccessible: true,
		SourcePermissionsOK: true, DispatchPermissionsOK: true,
		CheckedAt: now, ExpiresAt: now.Add(10 * time.Second),
		SourceInstallationID: source.InstallationID, ReceivingInstallationID: source.InstallationID,
		SourceRepositoryID: event.RepositoryID, SourceOrganizationID: event.OrganizationID,
		DestinationInstallationID: destination.InstallationID, DestinationRepositoryID: destination.RepositoryID,
		SourceVisibility: "private", DestinationVisibility: "private",
		CurrentRevision: Revision{RepositoryID: 40, CommitSHA: strings.Repeat("c", 40), MetadataPath: "compiled/project.json",
			Digest: job.SubscriptionDigest, CompilerID: "gh-aw"},
		Grant: AdminGrant{SubscriptionID: job.Subscription.ID, Digest: job.SubscriptionDigest,
			SourceInstallationID: source.InstallationID, SourceRepositoryID: source.RepositoryID,
			SourceOrganizationID: source.OrganizationID, ProjectIDs: source.ProjectIDs,
			ReceivingInstallationID: source.InstallationID, DestinationInstallationID: destination.InstallationID,
			DestinationRepositoryID: destination.RepositoryID, DispatchKind: destination.Kind, ExpiresAt: now.Add(time.Hour)},
	}, nil
}

type shellQueue struct {
	calls     []string
	admission Admission
	job       *Job
	admitErr  error
	beginErr  error
	final     Outcome
	finishCtx error
}

func (q *shellQueue) ApplyRevision(context.Context, QueueRevision) error {
	q.calls = append(q.calls, "revision")
	return nil
}
func (q *shellQueue) AdmitBatch(_ context.Context, admission Admission) (AdmissionResult, error) {
	q.calls = append(q.calls, "admit")
	q.admission = admission
	return AdmissionResult{Jobs: admission.Jobs}, q.admitErr
}
func (q *shellQueue) Claim(context.Context, ClaimRequest) (*Job, error) {
	q.calls = append(q.calls, "claim")
	return q.job, nil
}
func (q *shellQueue) Renew(_ context.Context, fence Fence, lease time.Duration) (Job, error) {
	q.calls = append(q.calls, "renew")
	if fence != jobFence(*q.job) {
		return Job{}, ErrConflict
	}
	q.job.Version++
	q.job.LeaseUntil = time.Now().Add(lease)
	return *q.job, nil
}
func (q *shellQueue) BeginDispatch(_ context.Context, fence Fence, _ Authorization) (Job, error) {
	q.calls = append(q.calls, "begin")
	if q.beginErr != nil {
		return Job{}, q.beginErr
	}
	if fence != jobFence(*q.job) {
		return Job{}, ErrConflict
	}
	q.job.State = Dispatching
	q.job.Version++
	q.job.Attempt++
	return *q.job, nil
}
func (q *shellQueue) Finish(ctx context.Context, fence Fence, final Outcome) (Job, error) {
	q.calls = append(q.calls, "finish")
	q.finishCtx = ctx.Err()
	if fence != jobFence(*q.job) {
		return Job{}, ErrConflict
	}
	q.final = final
	q.job.State = final.State
	q.job.AcceptedStatus = final.AcceptedStatus
	q.job.WorkflowRunID = final.WorkflowRunID
	return *q.job, nil
}
func (q *shellQueue) Cancel(_ context.Context, _ string, _ uint64) (Job, error) {
	q.calls = append(q.calls, "cancel")
	q.job.State = Cancelled
	return *q.job, nil
}
func (q *shellQueue) Maintain(context.Context, int) (MaintenanceResult, error) {
	q.calls = append(q.calls, "maintain")
	return MaintenanceResult{}, nil
}

type shellDispatch func(context.Context, Subscription, json.RawMessage) DispatchResponse

func (fn shellDispatch) Dispatch(ctx context.Context, subscription Subscription, payload json.RawMessage) DispatchResponse {
	return fn(ctx, subscription, payload)
}

type shellQuotaProbe struct {
	reserveErr error
	acquired   bool
	released   bool
}

func (q *shellQuotaProbe) Acquire(context.Context, Job) (func(), error) {
	if q.reserveErr != nil {
		return nil, q.reserveErr
	}
	q.acquired = true
	return func() { q.released = true }, nil
}

func shellFixture() (Subscription, PolicySnapshot) {
	sub := Subscription{
		SchemaVersion: "gh-aw.webhook-subscription/v1", Provider: "github", ID: "project-sync", TenantID: "tenant", AppID: 1,
		Source: Source{ID: "projects", Event: "issues", InstallationID: 10, OrganizationID: 20},
		Filter: &Filter{Op: "eq", Path: "/action", Value: json.RawMessage(`"edited"`)},
		Destination: Destination{Kind: "repository_dispatch", InstallationID: 30, RepositoryID: 40,
			EventType: "project.changed", URLPath: "/issue/url"},
		Delivery: DeliveryPolicy{TTLSeconds: 600, LeaseSeconds: 60, MaxAttempts: 3, RetryDelaySeconds: 2},
	}
	snapshot := PolicySnapshot{
		Revision:      QueueRevision{Revision: 1, Digest: strings.Repeat("a", 64), Enabled: true},
		Subscriptions: []Subscription{sub},
		Revisions: map[string]Revision{sub.ID: {
			RepositoryID: 40, CommitSHA: strings.Repeat("c", 40), MetadataPath: "compiled/project.json",
			Digest: strings.Repeat("b", 64), CompilerID: "gh-aw",
		}},
	}
	return sub, snapshot
}

func shellRequest(body string) *http.Request {
	r := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-GitHub-Delivery", "delivery-1")
	r.Header.Set("X-GitHub-Event", "issues")
	r.Header.Set("X-Hub-Signature-256", signWebhook([]byte(body), []byte("current")))
	return r
}

func TestIngressFilteredNeverAuthorizesOrPersistsPayload(t *testing.T) {
	_, snapshot := shellFixture()
	queue, authorizer := &shellQueue{}, &shellAuthorizer{}
	handler := Ingress{SourceID: "projects", Policies: shellPolicy{snapshot: snapshot}, Secrets: shellSecrets{}, Queue: queue, Authorizer: authorizer}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, shellRequest(`{"action":"deleted","installation":{"id":10},"organization":{"id":20},"secret":"never-store"}`))
	if recorder.Code != http.StatusNoContent || authorizer.calls != 0 || len(queue.admission.Jobs) != 0 {
		t.Fatalf("status %d, auth calls %d, admission %+v", recorder.Code, authorizer.calls, queue.admission)
	}
}

func TestIngressAtomicAdmissionAndAllowlist(t *testing.T) {
	sub, snapshot := shellFixture()
	second := sub
	second.ID = "second"
	snapshot.Subscriptions = append(snapshot.Subscriptions, second)
	snapshot.Revisions[second.ID] = snapshot.Revisions[sub.ID]
	for _, capacityFailure := range []bool{false, true} {
		queue, authorizer := &shellQueue{}, &shellAuthorizer{}
		if capacityFailure {
			queue.admitErr = ErrCapacity
		}
		handler := Ingress{SourceID: "projects", Policies: shellPolicy{snapshot: snapshot}, Secrets: shellSecrets{}, Queue: queue, Authorizer: authorizer}
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, shellRequest(`{"action":"edited","installation":{"id":10},"organization":{"id":20},"issue":{"id":9,"url":"https://api.github.com/repos/approved/source/issues/9"},"secret":"never-propagate"}`))
		expected := http.StatusAccepted
		if capacityFailure {
			expected = http.StatusServiceUnavailable
		}
		if recorder.Code != expected || len(queue.admission.Jobs) != 2 || authorizer.calls != 2 {
			t.Fatalf("status %d, auth calls %d, jobs %d", recorder.Code, authorizer.calls, len(queue.admission.Jobs))
		}
		for _, job := range queue.admission.Jobs {
			if strings.Contains(string(job.Payload), "never-propagate") || !strings.Contains(string(job.Payload), `"url"`) {
				t.Fatalf("allowlist not enforced: %s", job.Payload)
			}
		}
	}
}

func shellWorker(queue *shellQueue, authorizer *shellAuthorizer) *Worker {
	sub, snapshot := shellFixture()
	event := Event{SourceID: "projects", DeliveryID: "delivery", Name: "issues", Action: "edited",
		InstallationID: 10, OrganizationID: 20,
		Payload: json.RawMessage(`{"action":"edited","installation":{"id":10},"organization":{"id":20},"issue":{"id":9,"url":"https://api.github.com/repos/approved/source/issues/9"},"secret":"never-propagate"}`)}
	payload, err := buildGatewayDispatchPayload(sub, event, snapshot.Revisions[sub.ID], DefaultLimits())
	if err != nil {
		panic(err)
	}
	queue.job = &Job{
		ID: "job", DeliveryID: "delivery", Subscription: sub, SubscriptionDigest: snapshot.Revisions[sub.ID].Digest,
		State: Claimed, Version: 2, Fence: 1, ClaimID: "worker",
		CreatedAt: time.Now().Add(-time.Minute), ExpiresAt: time.Now().Add(5 * time.Minute),
		Event: IdentityOf(event), Payload: payload,
	}
	return &Worker{Queue: queue, Policies: shellPolicy{snapshot: snapshot}, Authorizer: authorizer, Owner: "worker",
		Dispatcher: shellDispatch(func(_ context.Context, _ Subscription, payload json.RawMessage) DispatchResponse {
			queue.calls = append(queue.calls, "http")
			if strings.Contains(string(payload), "never-propagate") {
				panic("unallowlisted field reached dispatch")
			}
			return DispatchResponse{StatusCode: 204, TransportOutcome: "response"}
		})}
}

func TestWorkerRenewsBeginsSendsAndFencedFinish(t *testing.T) {
	queue := &shellQueue{}
	worker := shellWorker(queue, &shellAuthorizer{})
	worked, err := worker.RunOnce(context.Background())
	if err != nil || !worked || queue.final.State != Succeeded || queue.final.AcceptedStatus != http.StatusNoContent {
		t.Fatalf("worked %v err %v final %+v", worked, err, queue.final)
	}
	if got := strings.Join(queue.calls, ","); !strings.Contains(got, "renew,begin,http,finish") {
		t.Fatal(got)
	}
}

func TestWorkerCannotSendOnUnknownAuthorityOrBudgetFailure(t *testing.T) {
	for _, unknown := range []bool{true, false} {
		queue := &shellQueue{}
		authorizer := &shellAuthorizer{}
		if unknown {
			authorizer.fn = func(Job) (AuthorizationSnapshot, error) { return AuthorizationSnapshot{}, nil }
		} else {
			queue.beginErr = ErrCapacity
		}
		worker := shellWorker(queue, authorizer)
		_, _ = worker.RunOnce(context.Background())
		if strings.Contains(strings.Join(queue.calls, ","), "http") {
			t.Fatal("HTTP performed without fresh authority and budget")
		}
	}
}

func TestWorkerCancellationAfterBeginIsTerminalAmbiguous(t *testing.T) {
	queue := &shellQueue{}
	worker := shellWorker(queue, &shellAuthorizer{})
	ctx, cancel := context.WithCancel(context.Background())
	worker.Dispatcher = shellDispatch(func(context.Context, Subscription, json.RawMessage) DispatchResponse {
		cancel()
		return DispatchResponse{StatusCode: 204, TransportOutcome: "response"}
	})
	if _, err := worker.RunOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if queue.final.State != Ambiguous || queue.finishCtx != nil || queue.final.AcceptedStatus != 0 || queue.final.WorkflowRunID != 0 {
		t.Fatalf("final %+v finish context %v", queue.final, queue.finishCtx)
	}
}

func TestWorkerCurrentRevocationCancelsWithoutDispatch(t *testing.T) {
	queue := &shellQueue{}
	authorizer := &shellAuthorizer{fn: func(job Job) (AuthorizationSnapshot, error) {
		snapshot, err := (&shellAuthorizer{}).Authorize(context.Background(), job)
		snapshot.Grant.Revoked = true
		return snapshot, err
	}}
	worker := shellWorker(queue, authorizer)
	if _, err := worker.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if queue.job.State != Cancelled || strings.Contains(strings.Join(queue.calls, ","), "http") {
		t.Fatalf("calls %v state %s", queue.calls, queue.job.State)
	}
}

func TestWorkerKnownRateLimitRetriesButTransportTimeoutDoesNot(t *testing.T) {
	for _, transport := range []string{"response", "unknown"} {
		queue := &shellQueue{}
		worker := shellWorker(queue, &shellAuthorizer{})
		worker.Dispatcher = shellDispatch(func(context.Context, Subscription, json.RawMessage) DispatchResponse {
			return DispatchResponse{StatusCode: 429, TransportOutcome: transport, RetryAfter: "60"}
		})
		if _, err := worker.RunOnce(context.Background()); err != nil {
			t.Fatal(err)
		}
		expected := Ready
		if transport == "unknown" {
			expected = Ambiguous
		}
		if queue.final.State != expected {
			t.Fatalf("transport %s final %+v", transport, queue.final)
		}
		if queue.final.AcceptedStatus != 0 || queue.final.WorkflowRunID != 0 {
			t.Fatal("non-acceptance retained acceptance evidence")
		}
	}
}

func TestWorkerRunCancellationLifetime(t *testing.T) {
	queue := &shellQueue{}
	worker := shellWorker(queue, &shellAuthorizer{})
	queue.job = nil
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := worker.Run(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run cancellation = %v", err)
	}
	if len(queue.calls) != 0 {
		t.Fatal("cancelled run performed queue operations")
	}
}

func TestIngressIndexedFilteredLoad(t *testing.T) {
	sub, snapshot := shellFixture()
	for i := range 10000 {
		other := sub
		other.ID = fmt.Sprintf("other-%d", i)
		other.Source.ID = fmt.Sprintf("source-%d", i)
		snapshot.Subscriptions = append(snapshot.Subscriptions, other)
	}
	queue, authorizer := &shellQueue{}, &shellAuthorizer{}
	handler := Ingress{SourceID: "projects", Policies: shellPolicy{snapshot: snapshot}, Secrets: shellSecrets{}, Queue: queue, Authorizer: authorizer}
	for range 2000 {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, shellRequest(`{"action":"deleted","installation":{"id":10},"organization":{"id":20}}`))
		if recorder.Code != http.StatusNoContent {
			t.Fatalf("load request status %d", recorder.Code)
		}
	}
	if authorizer.calls != 0 || len(queue.admission.Jobs) != 0 {
		t.Fatal("filtered load performed GitHub authorization or persisted data")
	}
	if got := len(handler.candidates(snapshot, Event{SourceID: "projects", Name: "issues", Action: "edited"})); got != 1 {
		t.Fatalf("indexed candidate count %d", got)
	}
}

func TestWorkerSharedQuotaGateAndReservationLifecycle(t *testing.T) {
	for _, scenario := range []string{"quota-denied", "budget-denied", "accepted"} {
		t.Run(scenario, func(t *testing.T) {
			queue := &shellQueue{}
			worker := shellWorker(queue, &shellAuthorizer{})
			quota := &shellQuotaProbe{}
			worker.Budget = quota
			switch scenario {
			case "quota-denied":
				quota.reserveErr = ErrCapacity
			case "budget-denied":
				queue.beginErr = ErrCapacity
			}

			_, err := worker.RunOnce(context.Background())
			sent := strings.Contains(strings.Join(queue.calls, ","), "http")
			switch scenario {
			case "quota-denied":
				if sent || quota.acquired || queue.job.Attempt != 0 {
					t.Fatal("denied shared quota allowed external request")
				}
			case "budget-denied":
				if sent || !quota.released || queue.job.Attempt != 0 {
					t.Fatal("unused reservation not released")
				}
			case "accepted":
				if err != nil || !sent || !quota.acquired || !quota.released || queue.final.State != Succeeded {
					t.Fatalf("known acceptance lost: err %v final %+v quota %+v", err, queue.final, quota)
				}
			}
		})
	}
}

func TestWorkerWorkflowDispatchHTTP200Acceptance(t *testing.T) {
	queue := &shellQueue{}
	worker := shellWorker(queue, &shellAuthorizer{})
	queue.job.Subscription.Destination = Destination{
		Kind: "workflow_dispatch", InstallationID: 30, RepositoryID: 40,
		Workflow: "project-sync.yml", Ref: "main",
		URLPath: "/issue/url",
	}
	_, snapshot := shellFixture()
	payload, err := buildGatewayDispatchPayload(queue.job.Subscription,
		Event{DeliveryID: queue.job.DeliveryID, Payload: json.RawMessage(`{"issue":{"url":"https://api.github.com/repos/approved/source/issues/9"}}`)},
		snapshot.Revisions[queue.job.Subscription.ID], DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	queue.job.Payload = payload
	worker.Dispatcher = shellDispatch(func(context.Context, Subscription, json.RawMessage) DispatchResponse {
		return DispatchResponse{
			StatusCode: 200, TransportOutcome: "response", WorkflowRunID: 123,
			Body: json.RawMessage(`{"workflow_run_id":123,"run_url":"https://api.github.com/repos/control/repo/actions/runs/123","html_url":"https://github.com/control/repo/actions/runs/123"}`),
		}
	})
	if _, err := worker.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if queue.final.State != Succeeded || queue.final.AcceptedStatus != http.StatusOK || queue.final.WorkflowRunID != 123 {
		t.Fatalf("documented HTTP 200 acceptance classified as %+v", queue.final)
	}
}
