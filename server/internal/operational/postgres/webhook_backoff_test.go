package postgres

import (
	"testing"
	"time"

	wg "github.com/githubnext/gh-aw-cao/server/internal/webhookgateway"
)

func TestWebhookSafeRetryUsesExponentialBoundedJitter(t *testing.T) {
	s, _ := testStore(t, Config{})
	q := openWebhook(t, s, webhookOptions())
	admitWebhook(t, q, "delivery", webhookJob("one", "tenant"))
	for attempt := uint32(1); attempt <= 2; attempt++ {
		job := dispatchWebhook(t, q, claimWebhook(t, q))
		if job.Attempt != attempt {
			t.Fatalf("attempt: %d want %d", job.Attempt, attempt)
		}
		var before time.Time
		if err := s.db.QueryRowContext(t.Context(), `SELECT clock_timestamp()`).Scan(&before); err != nil {
			t.Fatal(err)
		}
		jitter := 250 * time.Millisecond
		result, err := q.Finish(t.Context(), webhookJobFence(job), wg.Outcome{State: wg.Ready, Reason: "rate-limited", RetryJitter: jitter})
		if err != nil || result.State != wg.Ready {
			t.Fatalf("retry: %+v %v", result, err)
		}
		minimum := wg.RetryDelay(time.Second, attempt, jitter)
		if result.NotBefore.Before(before.Add(minimum - time.Millisecond)) {
			t.Fatalf("retry backoff: %v before %v", result.NotBefore, before.Add(minimum))
		}
		if _, err := s.db.ExecContext(t.Context(), `UPDATE cao_operational_webhook_jobs SET not_before=clock_timestamp()-interval '1 second' WHERE namespace=$1 AND id=$2`, s.namespace, result.ID); err != nil {
			t.Fatal(err)
		}
	}
	job := dispatchWebhook(t, q, claimWebhook(t, q))
	if job.Attempt != 3 {
		t.Fatalf("attempt: %d want 3", job.Attempt)
	}
	result, err := q.Finish(t.Context(), webhookJobFence(job), wg.Outcome{State: wg.Ready, Reason: "not-sent", RetryJitter: time.Hour})
	if err != nil || result.State != wg.Failed {
		t.Fatalf("jitter bypassed attempt bound: %+v %v", result, err)
	}
}
