package postgres

import (
	"errors"
	"testing"

	wg "github.com/githubnext/gh-cao/server/internal/webhookgateway"
)

func TestWebhookAcceptanceEvidenceAndRunCorrelationPersist(t *testing.T) {
	for _, transport := range []struct {
		name   string
		status int
		runID  int64
	}{
		{"workflow-current", 200, 12345},
		{"workflow-legacy", 204, 0},
		{"repository", 204, 0},
	} {
		t.Run(transport.name, func(t *testing.T) {
			s, dsn := testStore(t, Config{})
			q := openWebhook(t, s, webhookOptions())
			input := webhookJob("one", "tenant")
			if transport.name == "repository" {
				input.Subscription.Destination.Kind = "repository_dispatch"
				input.Subscription.Destination.Workflow, input.Subscription.Destination.Ref = "", ""
				input.Subscription.Destination.EventType = "approved-event"
			}
			admitWebhook(t, q, "delivery", input)
			job := dispatchWebhook(t, q, claimWebhook(t, q))
			result, err := q.Finish(t.Context(), webhookJobFence(job), wg.Outcome{
				State: wg.Succeeded, AcceptedStatus: transport.status, WorkflowRunID: transport.runID,
			})
			if err != nil || result.AcceptedStatus != transport.status || result.WorkflowRunID != transport.runID {
				t.Fatalf("accepted result: %+v %v", result, err)
			}
			peer, err := Open(t.Context(), dsn, s.namespace, Config{})
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = peer.Close() }()
			reopened := openWebhook(t, peer, webhookOptions())
			admission := webhookAdmission("delivery", input)
			replay, err := reopened.AdmitBatch(t.Context(), admission)
			if err != nil || !replay.Duplicate || len(replay.Jobs) != 1 ||
				replay.Jobs[0].State != wg.Succeeded || replay.Jobs[0].AcceptedStatus != transport.status ||
				replay.Jobs[0].WorkflowRunID != transport.runID {
				t.Fatalf("durable accepted evidence: %+v %v", replay, err)
			}
		})
	}
}

func TestWebhookSuccessRequiresAcceptanceObservation(t *testing.T) {
	s, _ := testStore(t, Config{})
	q := openWebhook(t, s, webhookOptions())
	admitWebhook(t, q, "delivery", webhookJob("one", "tenant"))
	job := dispatchWebhook(t, q, claimWebhook(t, q))
	for _, status := range []int{0, 200, 202, 500} {
		if _, err := q.Finish(t.Context(), webhookJobFence(job), wg.Outcome{State: wg.Succeeded, AcceptedStatus: status}); !errors.Is(err, wg.ErrInvalid) {
			t.Fatalf("unaccepted status %d marked successful: %v", status, err)
		}
	}
	for _, state := range []wg.JobState{wg.Ready, wg.Rejected, wg.Ambiguous, wg.Cancelled, wg.Failed} {
		if _, err := q.Finish(t.Context(), webhookJobFence(job), wg.Outcome{State: state, AcceptedStatus: 204}); !errors.Is(err, wg.ErrInvalid) {
			t.Fatalf("nonaccepted outcome %s retained acceptance: %v", state, err)
		}
		if _, err := q.Finish(t.Context(), webhookJobFence(job), wg.Outcome{State: state, WorkflowRunID: 12345}); !errors.Is(err, wg.ErrInvalid) {
			t.Fatalf("nonaccepted outcome %s retained run: %v", state, err)
		}
	}
	if _, err := q.Finish(t.Context(), webhookJobFence(job), wg.Outcome{State: wg.Ambiguous}); err != nil {
		t.Fatal(err)
	}
}
