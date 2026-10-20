package postgres

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	wg "github.com/githubnext/gh-cao/server/internal/webhookgateway"
)

func TestWebhookCrossConnectionClaimAndBudgetAtomicity(t *testing.T) {
	s, dsn := testStore(t, Config{})
	options := webhookOptions()
	options.MaxConcurrency = 3
	options.Rates.Global.Capacity = 1
	q := openWebhook(t, s, options)
	peer, err := Open(t.Context(), dsn, s.namespace, Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = peer.Close() }()
	other := openWebhook(t, peer, options)
	for i := range 8 {
		admitWebhook(t, q, fmt.Sprintf("delivery-%d", i), webhookJob(fmt.Sprintf("subscription-%d", i), "tenant"))
	}
	claimed := make(chan wg.Job, 12)
	var workers sync.WaitGroup
	for i := range 12 {
		workers.Go(func() {
			queue := q
			if i%2 != 0 {
				queue = other
			}
			job, err := queue.Claim(t.Context(), wg.ClaimRequest{Owner: fmt.Sprintf("worker-%d", i), LeaseDuration: time.Minute})
			if err != nil {
				t.Error(err)
			} else if job != nil {
				claimed <- *job
			}
		})
	}
	workers.Wait()
	close(claimed)
	if len(claimed) != options.MaxConcurrency {
		t.Fatalf("cross-connection concurrency: %d", len(claimed))
	}
	var started atomic.Int64
	for job := range claimed {
		workers.Go(func() {
			_, err := other.BeginDispatch(t.Context(), webhookJobFence(job), webhookAuthorization(job))
			switch {
			case err == nil:
				started.Add(1)
			case errors.Is(err, wg.ErrCapacity):
			default:
				t.Error(err)
			}
		})
	}
	workers.Wait()
	if started.Load() != 1 {
		t.Fatalf("distributed budget overspent: %d", started.Load())
	}
}

func TestWebhookExpiredFenceCannotMutateBeforeRecovery(t *testing.T) {
	s, _ := testStore(t, Config{})
	q := openWebhook(t, s, webhookOptions())
	admitWebhook(t, q, "delivery", webhookJob("one", "tenant"))
	job := claimWebhook(t, q)
	expireWebhookLease(t, s, job.ID)
	if _, err := q.Renew(t.Context(), webhookJobFence(job), time.Minute); !errors.Is(err, wg.ErrConflict) {
		t.Fatalf("expired owner renewed: %v", err)
	}
	if _, err := q.BeginDispatch(t.Context(), webhookJobFence(job), webhookAuthorization(job)); !errors.Is(err, wg.ErrConflict) {
		t.Fatalf("expired owner dispatched: %v", err)
	}
	if _, err := q.Finish(t.Context(), webhookJobFence(job), wg.Outcome{State: wg.Ready}); !errors.Is(err, wg.ErrConflict) {
		t.Fatalf("expired owner finished: %v", err)
	}
}

func TestWebhookKillSwitchAndDispatchRecovery(t *testing.T) {
	s, _ := testStore(t, Config{})
	q := openWebhook(t, s, webhookOptions())
	admitWebhook(t, q, "first", webhookJob("one", "tenant"))
	dispatched := dispatchWebhook(t, q, claimWebhook(t, q))
	admitWebhook(t, q, "second", webhookJob("two", "tenant"))
	policy := webhookPolicy()
	policy.Revision++
	policy.Enabled = false
	if err := q.ApplyRevision(t.Context(), policy); err != nil {
		t.Fatal(err)
	}
	if _, err := q.Claim(t.Context(), wg.ClaimRequest{Owner: "worker", LeaseDuration: time.Minute}); !errors.Is(err, wg.ErrUnauthorized) {
		t.Fatalf("kill switch claim: %v", err)
	}
	if _, err := q.AdmitBatch(t.Context(), webhookAdmission("third", webhookJob("three", "tenant"))); !errors.Is(err, wg.ErrUnauthorized) {
		t.Fatalf("stale admission after kill switch: %v", err)
	}
	expireWebhookLease(t, s, dispatched.ID)
	result, err := q.Maintain(t.Context(), 512)
	if err != nil || result.Ambiguous != 1 {
		t.Fatalf("kill switch lost in-flight uncertainty: %+v %v", result, err)
	}
}
