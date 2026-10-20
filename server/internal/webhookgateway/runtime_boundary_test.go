package webhookgateway_test

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/githubnext/gh-cao/server/internal/githubapp"
	wg "github.com/githubnext/gh-cao/server/internal/webhookgateway"
)

type boundaryPolicy struct{ snapshot wg.PolicySnapshot }

func (p boundaryPolicy) Load(context.Context) (wg.PolicySnapshot, error) { return p.snapshot, nil }

type boundarySecrets struct{}

func (boundarySecrets) WebhookSecrets(context.Context, string) ([]byte, []byte, error) {
	return []byte("boundary-webhook-key"), nil, nil
}

type boundaryAuthorization struct{ revision wg.Revision }

func (a boundaryAuthorization) Authorize(_ context.Context, job wg.Job) (wg.AuthorizationSnapshot, error) {
	now := time.Now()
	sub := job.Subscription
	return wg.AuthorizationSnapshot{
		Complete: true, CheckedAt: now, ExpiresAt: now.Add(10 * time.Second),
		JobID: job.ID, Fence: job.Fence, Attempt: job.Attempt + 1,
		SourceInstallationID: sub.Source.InstallationID, ReceivingInstallationID: sub.Source.InstallationID,
		SourceRepositoryID: sub.Source.RepositoryID, DestinationInstallationID: sub.Destination.InstallationID,
		DestinationRepositoryID: sub.Destination.RepositoryID, CurrentRevision: a.revision,
		SourceAccessible: true, DestinationAccessible: true, SourcePermissionsOK: true, DispatchPermissionsOK: true,
		SourceVisibility: "private", DestinationVisibility: "private",
		Grant: wg.AdminGrant{
			SubscriptionID: sub.ID, Digest: job.SubscriptionDigest,
			SourceInstallationID: sub.Source.InstallationID, SourceRepositoryID: sub.Source.RepositoryID,
			ReceivingInstallationID: sub.Source.InstallationID, DestinationInstallationID: sub.Destination.InstallationID,
			DestinationRepositoryID: sub.Destination.RepositoryID, DispatchKind: sub.Destination.Kind, ExpiresAt: now.Add(time.Hour),
		},
	}, nil
}

type boundaryQueue struct {
	wg.Queue
	job     wg.Job
	outcome wg.Outcome
	begun   atomic.Bool
}

func (q *boundaryQueue) AdmitBatch(_ context.Context, admission wg.Admission) (wg.AdmissionResult, error) {
	if len(admission.Jobs) != 1 {
		return wg.AdmissionResult{}, wg.ErrInvalid
	}
	if err := wg.ValidateJob(admission.Jobs[0]); err != nil {
		return wg.AdmissionResult{}, err
	}
	q.job = admission.Jobs[0]
	return wg.AdmissionResult{Jobs: admission.Jobs}, nil
}

func (q *boundaryQueue) ApplyRevision(context.Context, wg.QueueRevision) error { return nil }
func (q *boundaryQueue) Maintain(context.Context, int) (wg.MaintenanceResult, error) {
	return wg.MaintenanceResult{}, nil
}
func (q *boundaryQueue) Claim(_ context.Context, request wg.ClaimRequest) (*wg.Job, error) {
	q.job.State, q.job.ClaimID, q.job.Fence = wg.Claimed, request.Owner, 1
	q.job.Version++
	q.job.LeaseUntil = time.Now().Add(request.LeaseDuration)
	copy := q.job
	return &copy, nil
}
func (q *boundaryQueue) Renew(_ context.Context, fence wg.Fence, lease time.Duration) (wg.Job, error) {
	if fence.Version != q.job.Version {
		return wg.Job{}, wg.ErrConflict
	}
	q.job.Version++
	q.job.LeaseUntil = time.Now().Add(lease)
	return q.job, nil
}
func (q *boundaryQueue) BeginDispatch(_ context.Context, fence wg.Fence, authorization wg.Authorization) (wg.Job, error) {
	if fence.Version != q.job.Version {
		return wg.Job{}, wg.ErrConflict
	}
	if err := wg.ValidateDispatchAuthorization(q.job, authorization, time.Now()); err != nil {
		return wg.Job{}, err
	}
	q.job.State, q.job.Version, q.job.Attempt = wg.Dispatching, q.job.Version+1, q.job.Attempt+1
	q.begun.Store(true)
	return q.job, nil
}
func (q *boundaryQueue) Finish(_ context.Context, fence wg.Fence, outcome wg.Outcome) (wg.Job, error) {
	if fence.Version != q.job.Version {
		return wg.Job{}, wg.ErrConflict
	}
	q.outcome = outcome
	q.job.State = outcome.State
	return q.job, nil
}

func (q *boundaryQueue) ClaimBatch(ctx context.Context, request wg.ClaimRequest) ([]wg.Job, error) {
	job, err := q.Claim(ctx, request)
	if err != nil {
		return nil, err
	}
	return []wg.Job{*job}, nil
}

func (q *boundaryQueue) BeginDispatchBatch(ctx context.Context, fences []wg.Fence, evidence []wg.Authorization) ([]wg.Job, error) {
	job, err := q.BeginDispatch(ctx, fences[0], evidence[0])
	return []wg.Job{job}, err
}

func (q *boundaryQueue) FinishBatch(ctx context.Context, fences []wg.Fence, outcome wg.Outcome) ([]wg.Job, error) {
	job, err := q.Finish(ctx, fences[0], outcome)
	return []wg.Job{job}, err
}

func TestWorkerProductionHTTPBoundaryCompletePayload(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"repository_dispatch", "workflow_dispatch"} {
		t.Run(kind, func(t *testing.T) {
			sub := wg.Subscription{
				SchemaVersion: "gh-aw.webhook-subscription/v1", Provider: "github", ID: "boundary", TenantID: "tenant", AppID: 11,
				Source:   wg.Source{ID: "source", Event: "issues", InstallationID: 7, RepositoryID: 42},
				Delivery: wg.DeliveryPolicy{TTLSeconds: 600, LeaseSeconds: 60, MaxAttempts: 3, RetryDelaySeconds: 1},
				Destination: wg.Destination{
					Kind: kind, InstallationID: 7, RepositoryID: 42, EventType: "gateway-event",
					Fields: []wg.PayloadField{{Name: "issue_id", Literal: json.RawMessage(`"9"`)}},
				},
			}
			if kind == "workflow_dispatch" {
				sub.Destination.EventType, sub.Destination.Workflow, sub.Destination.Ref = "", "project.yml", "main"
				sub.Destination.GatewayInput = true
				sub.Destination.BatchInput = true
			}
			revision := wg.Revision{RepositoryID: 42, CommitSHA: strings.Repeat("c", 40), MetadataPath: "compiled/subscription.json",
				Digest: wg.MetadataDigest([]byte("artifact")), CompilerID: "gh-aw"}
			policy := wg.QueueRevision{Revision: 1, Enabled: true, Digest: wg.MetadataDigest([]byte("policy"))}
			event, err := wg.ParseEvent("delivery", "issues",
				[]byte(`{"action":"opened","installation":{"id":7},"repository":{"id":42},"issue":{"id":9},"private":"never-propagate"}`), wg.DefaultLimits())
			if err != nil {
				t.Fatal(err)
			}
			event.SourceID = "source"
			queue := &boundaryQueue{}
			policies := boundaryPolicy{wg.PolicySnapshot{Revision: policy, Subscriptions: []wg.Subscription{sub}, Revisions: map[string]wg.Revision{sub.ID: revision}}}
			ingress := wg.Ingress{SourceID: "source", Policies: policies, Secrets: boundarySecrets{}, Queue: queue, Authorizer: boundaryAuthorization{revision}}
			request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/", strings.NewReader(string(event.Payload)))
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("X-GitHub-Delivery", event.DeliveryID)
			request.Header.Set("X-GitHub-Event", event.Name)
			signature := hmac.New(sha256.New, []byte("boundary-webhook-key"))
			_, _ = signature.Write(event.Payload)
			request.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(signature.Sum(nil)))
			acknowledgment := httptest.NewRecorder()
			ingress.ServeHTTP(acknowledgment, request)
			if acknowledgment.Code != http.StatusAccepted {
				t.Fatalf("ingress admission status %d", acknowledgment.Code)
			}
			if strings.Contains(string(queue.job.Payload), "never-propagate") {
				t.Fatal("raw event retained in durable job")
			}
			requests := make(chan []byte, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				path := strings.TrimPrefix(r.URL.Path, "/api/v3")
				switch path {
				case "/app/installations/7/access_tokens":
					_, _ = fmt.Fprintf(w, `{"token":"boundary-installation-token","expires_at":%q}`, time.Now().Add(time.Hour).UTC().Format(time.RFC3339))
				case "/installation/repositories":
					_, _ = w.Write([]byte(`{"repositories":[{"id":42}],"total_count":1}`))
				case "/repositories/42":
					_, _ = w.Write([]byte(`{"id":42,"full_name":"current/renamed","owner":{"id":99},"visibility":"private","private":true,"permissions":{"push":true}}`))
				default:
					if r.Method != http.MethodPost || !strings.HasPrefix(path, "/repos/current/renamed/") {
						t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
						w.WriteHeader(http.StatusNotFound)
						return
					}
					if !queue.begun.Load() {
						t.Error("HTTP occurred before durable dispatch reservation")
					}
					body, err := io.ReadAll(r.Body)
					if err != nil {
						t.Error(err)
					}
					requests <- body
					if kind == "workflow_dispatch" {
						_, _ = w.Write([]byte(`{"workflow_run_id":123,"run_url":"https://api.github.com/run","html_url":"https://github.com/run"}`))
					} else {
						w.WriteHeader(http.StatusNoContent)
					}
				}
			}))
			t.Cleanup(server.Close)
			client, err := githubapp.New(githubapp.Config{
				AppID: 11, BaseURL: server.URL,
				PrivateKeyPEM: pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}),
			})
			if err != nil {
				t.Fatal(err)
			}
			worker := wg.Worker{
				Policies: policies,
				Queue:    queue, Authorizer: boundaryAuthorization{revision}, Dispatcher: githubapp.WebhookGatewayDispatcher{Client: client}, Owner: "worker",
			}
			if worked, err := worker.RunOnce(t.Context()); err != nil || !worked {
				t.Fatalf("worked %v error %v", worked, err)
			}
			if queue.outcome.State != wg.Succeeded {
				t.Fatalf("outcome %+v", queue.outcome)
			}
			var envelope map[string]json.RawMessage
			if err := json.Unmarshal(<-requests, &envelope); err != nil {
				t.Fatal(err)
			}
			field := "client_payload"
			if kind == "workflow_dispatch" {
				field = "inputs"
			}
			var properties map[string]json.RawMessage
			if err := json.Unmarshal(envelope[field], &properties); err != nil {
				t.Fatal(err)
			}
			context := properties["aw_context"]
			if kind == "workflow_dispatch" {
				var text string
				if err := json.Unmarshal(context, &text); err != nil {
					t.Fatal(err)
				}
				context = []byte(text)
			}
			if len(envelope) != 2 || len(properties) != 5 || string(context) != `[{"issue_id":"9"}]` || len(properties["_gateway"]) == 0 {
				t.Fatalf("double wrapping or missing provenance: %s", envelope[field])
			}
			if _, exists := properties[field]; exists {
				t.Fatal("dispatch request was double wrapped")
			}
			if kind == "workflow_dispatch" && queue.outcome.WorkflowRunID != 123 {
				t.Fatalf("acceptance correlation lost: %+v", queue.outcome)
			}
		})
	}
}
