package postgres

import (
	"errors"
	"strings"
	"testing"
	"time"

	wg "github.com/githubnext/gh-cao/server/internal/webhookgateway"
)

func TestWebhookAuthorizationIsCheckedInsideTransaction(t *testing.T) {
	s, _ := testStore(t, Config{})
	q := openWebhook(t, s, webhookOptions())
	admitWebhook(t, q, "delivery", webhookJob("one", "tenant"))
	job := claimWebhook(t, q)
	for _, kind := range []string{"incomplete", "expired", "attempt", "claim", "metadata", "grant", "visibility", "policy"} {
		t.Run(kind, func(t *testing.T) {
			authorization := webhookAuthorization(job)
			snapshot := &authorization.Snapshot
			switch kind {
			case "incomplete":
				snapshot.Complete = false
			case "expired":
				snapshot.ExpiresAt = time.Now().Add(-time.Second)
			case "attempt":
				snapshot.Attempt++
			case "claim":
				snapshot.Fence++
			case "metadata":
				snapshot.CurrentRevision.Digest = strings.Repeat("e", 64)
			case "grant":
				snapshot.Grant.Revoked = true
			case "visibility":
				snapshot.DestinationVisibility = "public"
			case "policy":
				authorization.Revision.Revision++
			}
			if _, err := q.BeginDispatch(t.Context(), webhookJobFence(job), authorization); !errors.Is(err, wg.ErrUnauthorized) {
				t.Fatalf("authorization passed: %v", err)
			}
		})
	}
	dispatched := dispatchWebhook(t, q, job)
	if dispatched.Attempt != 1 {
		t.Fatalf("denied authorizations consumed attempts: %d", dispatched.Attempt)
	}
}

func TestWebhookRenewalAndCancelCAS(t *testing.T) {
	s, _ := testStore(t, Config{})
	q := openWebhook(t, s, webhookOptions())
	admitWebhook(t, q, "delivery", webhookJob("one", "tenant"))
	first := claimWebhook(t, q)
	renewed, err := q.Renew(t.Context(), webhookJobFence(first), 30*time.Second)
	if err != nil || renewed.Version <= first.Version {
		t.Fatalf("renew: %+v %v", renewed, err)
	}
	if _, err := q.BeginDispatch(t.Context(), webhookJobFence(first), webhookAuthorization(first)); !errors.Is(err, wg.ErrConflict) {
		t.Fatalf("old version dispatched: %v", err)
	}
	if _, err := q.Cancel(t.Context(), first.ID, first.Version); !errors.Is(err, wg.ErrConflict) {
		t.Fatalf("old version cancelled: %v", err)
	}
	cancelled, err := q.Cancel(t.Context(), renewed.ID, renewed.Version)
	if err != nil || cancelled.State != wg.Cancelled {
		t.Fatalf("cancel: %+v %v", cancelled, err)
	}
	if _, err := q.Finish(t.Context(), webhookJobFence(renewed), wg.Outcome{State: wg.Ready}); !errors.Is(err, wg.ErrConflict) {
		t.Fatalf("cancelled claim revived: %v", err)
	}
}

func TestWebhookKnownNonacceptanceRetriesBounded(t *testing.T) {
	s, _ := testStore(t, Config{})
	q := openWebhook(t, s, webhookOptions())
	input := webhookJob("one", "tenant")
	input.Subscription.Delivery.MaxAttempts = 1
	admitWebhook(t, q, "delivery", input)
	dispatched := dispatchWebhook(t, q, claimWebhook(t, q))
	done, err := q.Finish(t.Context(), webhookJobFence(dispatched), wg.Outcome{
		State: wg.Ready, Reason: "rate-limited", NotBefore: time.Now().Add(time.Second),
	})
	if err != nil || done.State != wg.Failed {
		t.Fatalf("max attempts retry: %+v %v", done, err)
	}
	if next, err := q.Claim(t.Context(), wg.ClaimRequest{Owner: "worker", LeaseDuration: time.Minute}); err != nil || next != nil {
		t.Fatalf("exhausted job reclaimed: %+v %v", next, err)
	}
}

func TestWebhookTerminalRetentionAndExpiryAccounting(t *testing.T) {
	s, _ := testStore(t, Config{})
	q := openWebhook(t, s, webhookOptions())
	jobs := admitWebhook(t, q, "delivery", webhookJob("one", "tenant"))
	if _, err := s.db.ExecContext(t.Context(), `UPDATE cao_operational_webhook_jobs SET expires_at=clock_timestamp()-interval '1 second' WHERE namespace=$1 AND id=$2`, s.namespace, jobs[0].ID); err != nil {
		t.Fatal(err)
	}

	result, err := q.Maintain(t.Context(), 1)
	if err != nil || result.Expired != 1 || result.Deleted != 0 {
		t.Fatalf("bounded expiry: %+v %v", result, err)
	}
	if _, err := s.db.ExecContext(t.Context(), `UPDATE cao_operational_webhook_jobs SET retain_until=clock_timestamp()-interval '1 second' WHERE namespace=$1`, s.namespace); err != nil {
		t.Fatal(err)
	}
	result, err = q.Maintain(t.Context(), 1)
	if err != nil || result.Deleted != 1 {
		t.Fatalf("retain job: %+v %v", result, err)
	}
	// The independently retained receipt still blocks replay after payload deletion.
	admission := webhookAdmission("delivery", webhookJob("one", "tenant"))
	replay, err := q.AdmitBatch(t.Context(), admission)
	if err != nil || !replay.Duplicate || len(replay.Jobs) != 0 {
		t.Fatalf("receipt lost with job: %+v %v", replay, err)
	}
	if _, err := s.db.ExecContext(t.Context(), `UPDATE cao_operational_webhook_deliveries SET retain_until=clock_timestamp()-interval '1 second' WHERE namespace=$1`, s.namespace); err != nil {
		t.Fatal(err)
	}
	result, err = q.Maintain(t.Context(), 1)
	if err != nil || result.Deleted != 1 {
		t.Fatalf("retain receipt: %+v %v", result, err)
	}
	var entries int64
	if err := s.db.QueryRowContext(t.Context(), `SELECT protected_entries FROM cao_operational_namespaces WHERE namespace=$1`, s.namespace).Scan(&entries); err != nil || entries != 1 {
		t.Fatalf("retention accounting: %d %v", entries, err)
	}
}

func TestWebhookPolicyChangeCancelsKnownNonacceptanceRetry(t *testing.T) {
	s, _ := testStore(t, Config{})
	q := openWebhook(t, s, webhookOptions())
	admitWebhook(t, q, "delivery", webhookJob("one", "tenant"))
	dispatched := dispatchWebhook(t, q, claimWebhook(t, q))
	policy := webhookPolicy()
	policy.Revision++
	if err := q.ApplyRevision(t.Context(), policy); err != nil {
		t.Fatal(err)
	}
	result, err := q.Finish(t.Context(), webhookJobFence(dispatched), wg.Outcome{State: wg.Ready, Reason: "rate-limited"})
	if err != nil || result.State != wg.Cancelled {
		t.Fatalf("obsolete policy retry: %+v %v", result, err)
	}
}

func TestWebhookOptionalQueueDepth(t *testing.T) {
	s, _ := testStore(t, Config{})
	q := openWebhook(t, s, webhookOptions())
	admitWebhook(t, q, "delivery", webhookJob("one", "tenant"), webhookJob("two", "tenant"))
	depth, err := q.QueueDepth(t.Context())
	if err != nil || depth != 2 {
		t.Fatalf("ready depth: %d %v", depth, err)
	}
	first := dispatchWebhook(t, q, claimWebhook(t, q))
	depth, err = q.QueueDepth(t.Context())
	if err != nil || depth != 2 {
		t.Fatalf("active depth: %d %v", depth, err)
	}
	if _, err := q.Finish(t.Context(), webhookJobFence(first), wg.Outcome{State: wg.Succeeded, AcceptedStatus: 204}); err != nil {
		t.Fatal(err)
	}
	depth, err = q.QueueDepth(t.Context())
	if err != nil || depth != 1 {
		t.Fatalf("terminal excluded depth: %d %v", depth, err)
	}
}
