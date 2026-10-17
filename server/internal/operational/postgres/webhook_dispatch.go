package postgres

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"time"
	"unicode/utf8"

	wg "github.com/githubnext/gh-aw-cao/server/internal/webhookgateway"
)

func (q *webhookQueue) Claim(ctx context.Context, request wg.ClaimRequest) (*wg.Job, error) {
	if names(request.Owner) != nil || len(request.Owner) > 256 ||
		request.LeaseDuration < time.Millisecond || request.LeaseDuration > q.options.LeaseDuration {
		return nil, wg.ErrInvalid
	}
	var result *wg.Job
	err := q.transact(ctx, func(t *transaction) error {
		if _, err := q.maintain(t, 512); err != nil {
			return err
		}
		policy, err := q.policy(t)
		if err != nil {
			return err
		}
		if !policy.Enabled {
			return wg.ErrUnauthorized
		}
		var active int
		if err := t.tx.QueryRowContext(ctx, `SELECT count(*) FROM cao_operational_webhook_jobs WHERE namespace=$1 AND queue=$2 AND state IN ('claimed','dispatching')`, t.namespace, q.name).Scan(&active); err != nil {
			return err
		}
		if active >= q.options.MaxConcurrency {
			return nil
		}
		var id, tenant string
		err = t.tx.QueryRowContext(ctx, `SELECT j.id,j.tenant FROM cao_operational_webhook_jobs j JOIN cao_operational_webhook_queues q ON q.namespace=j.namespace AND q.name=j.queue
			WHERE j.namespace=$1 AND j.queue=$2 AND j.state='ready' AND j.not_before<=$3 AND j.expires_at>$3
			ORDER BY (j.tenant>q.tenant_cursor) DESC,j.tenant,j.created_at,j.id LIMIT 1`, t.namespace, q.name, t.now).Scan(&id, &tenant)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		job, err := q.detail(t, id)
		if err != nil {
			return err
		}
		if job.QueueRevision != policy || job.Version >= math.MaxInt64-1 || job.Fence >= math.MaxInt64-1 || job.Attempt >= job.Subscription.Delivery.MaxAttempts {
			return wg.ErrConflict
		}
		until := t.now.Add(request.LeaseDuration)
		subscriptionUntil := t.now.Add(time.Duration(job.Subscription.Delivery.LeaseSeconds) * time.Second)
		if subscriptionUntil.Before(until) {
			until = subscriptionUntil
		}
		if job.ExpiresAt.Before(until) {
			until = job.ExpiresAt
		}
		if _, err := t.tx.ExecContext(ctx, `UPDATE cao_operational_webhook_jobs SET state='claimed',version=version+1,fence=fence+1,owner=$4,lease_until=$5 WHERE namespace=$1 AND queue=$2 AND id=$3`,
			t.namespace, q.name, id, request.Owner, until); err != nil {
			return err
		}
		if _, err := t.tx.ExecContext(ctx, `UPDATE cao_operational_webhook_queues SET tenant_cursor=$3 WHERE namespace=$1 AND name=$2`, t.namespace, q.name, tenant); err != nil {
			return err
		}
		job, err = q.detail(t, id)
		result = &job
		return err
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (q *webhookQueue) BeginDispatch(ctx context.Context, fence wg.Fence, authorization wg.Authorization) (wg.Job, error) {
	var job wg.Job
	err := q.transact(ctx, func(t *transaction) error {
		var err error
		job, err = q.detail(t, fence.JobID)
		if err != nil {
			return err
		}
		if err := webhookFence(job, fence, t.now); err != nil {
			return err
		}
		if job.State != wg.Claimed || !t.now.Before(job.ExpiresAt) || job.Attempt >= job.Subscription.Delivery.MaxAttempts {
			return wg.ErrConflict
		}
		policy, err := q.policy(t)
		if err != nil {
			return err
		}
		if !policy.Enabled || job.QueueRevision != policy || authorization.Revision != policy {
			return wg.ErrUnauthorized
		}
		if err := wg.ValidateDispatchAuthorization(job, authorization, t.now); err != nil {
			return err
		}
		if err := q.spendRates(t, job); err != nil {
			return err
		}
		if _, err := t.tx.ExecContext(ctx, `UPDATE cao_operational_webhook_jobs SET state='dispatching',version=version+1,attempt=attempt+1 WHERE namespace=$1 AND queue=$2 AND id=$3`, t.namespace, q.name, job.ID); err != nil {
			return err
		}
		job, err = q.detail(t, job.ID)
		return err
	})
	if err != nil {
		return wg.Job{}, err
	}
	return job, nil
}

func (q *webhookQueue) spendRates(t *transaction, job wg.Job) error {
	d := wg.JobDimensions(job)
	type pending struct {
		key    key
		bucket tokenBucket
		period time.Duration
	}
	var updates []pending
	for _, scope := range []struct {
		level, value string
		rate         wg.RateBudget
	}{
		{"global", "", q.options.Rates.Global},
		{"app", d.App, q.options.Rates.App},
		{"tenant", d.Tenant, q.options.Rates.Tenant},
		{"destination", d.Destination, q.options.Rates.Destination},
		{"workflow", d.Workflow, q.options.Rates.Workflow},
	} {
		identity, err := json.Marshal([]string{q.name, scope.level, scope.value})
		if err != nil {
			return err
		}
		hash := sha256.Sum256(identity)
		k := key{"webhook-rate", hex.EncodeToString(hash[:]), ""}
		b := tokenBucket{Tokens: float64(scope.rate.Capacity), At: t.now}
		if _, err := t.json(k, &b); err != nil {
			return err
		}
		b, result := advanceTokenBucket(b, t.now, scope.rate.Capacity, 1, scope.rate.Period)
		if !result.Allowed {
			return wg.ErrCapacity
		}
		updates = append(updates, pending{k, b, scope.rate.Period})
	}
	for _, update := range updates {
		if err := t.putJSON(update.key, update.bucket, update.bucket.At.Add(2*update.period)); err != nil {
			return err
		}
	}
	return nil
}

func (q *webhookQueue) Finish(ctx context.Context, fence wg.Fence, outcome wg.Outcome) (wg.Job, error) {
	if len(outcome.Reason) > 512 || strings.ContainsRune(outcome.Reason, 0) || !utf8.ValidString(outcome.Reason) ||
		(!webhookTerminal(outcome.State) && outcome.State != wg.Ready) ||
		(outcome.State != wg.Succeeded && (outcome.AcceptedStatus != 0 || outcome.WorkflowRunID != 0)) {
		return wg.Job{}, wg.ErrInvalid
	}
	var job wg.Job
	err := q.transact(ctx, func(t *transaction) error {
		var err error
		job, err = q.detail(t, fence.JobID)
		if err != nil {
			return err
		}
		if err := webhookFence(job, fence, t.now); err != nil {
			return err
		}
		if outcome.State == wg.Succeeded {
			if _, err := wg.FinishDispatch(t.now, job, fence.Generation, fence.Owner, wg.DispatchResult{
				Outcome: "succeeded", Reason: outcome.Reason, AcceptedStatus: outcome.AcceptedStatus, WorkflowRunID: outcome.WorkflowRunID,
			}); err != nil {
				return err
			}
		}
		if outcome.State == wg.Ready {
			if job.State == wg.Dispatching && outcome.Reason != "rate-limited" && outcome.Reason != "not-sent" {
				return wg.ErrConflict
			}
			if job.State == wg.Dispatching {
				delay := wg.RetryDelay(time.Duration(job.Subscription.Delivery.RetryDelaySeconds)*time.Second, job.Attempt, outcome.RetryJitter)
				earliest := t.now.Add(delay)
				if outcome.NotBefore.Before(earliest) {
					outcome.NotBefore = earliest
				}
			}
			if outcome.NotBefore.IsZero() || outcome.NotBefore.Before(t.now) {
				outcome.NotBefore = t.now
			}
			if !outcome.NotBefore.Before(job.ExpiresAt) {
				outcome.State = wg.Expired
			} else if job.Attempt >= job.Subscription.Delivery.MaxAttempts {
				outcome.State = wg.Failed
			}
			policy, err := q.policy(t)
			if err != nil {
				return err
			}
			if !policy.Enabled || policy != job.QueueRevision {
				outcome.State, outcome.Reason = wg.Cancelled, "policy-revision-changed"
			}
		}
		if job.State == wg.Claimed && (outcome.State == wg.Succeeded || outcome.State == wg.Ambiguous) {
			return wg.ErrConflict
		}
		if outcome.State == wg.Ready {
			_, err = t.tx.ExecContext(ctx, `UPDATE cao_operational_webhook_jobs SET state='ready',version=version+1,fence=fence+1,owner='',lease_until=NULL,not_before=$4,reason=$5 WHERE namespace=$1 AND queue=$2 AND id=$3`,
				t.namespace, q.name, job.ID, outcome.NotBefore, outcome.Reason)
		} else {
			_, err = t.tx.ExecContext(ctx, `UPDATE cao_operational_webhook_jobs SET state=$4,version=version+1,fence=fence+1,owner='',lease_until=NULL,terminal_at=$5,retain_until=greatest(retain_until,$6),reason=$7,accepted_status=$8,workflow_run_id=$9 WHERE namespace=$1 AND queue=$2 AND id=$3`,
				t.namespace, q.name, job.ID, outcome.State, t.now, t.now.Add(q.options.TerminalRetention), outcome.Reason, outcome.AcceptedStatus, outcome.WorkflowRunID)
		}
		if err != nil {
			return err
		}
		job, err = q.detail(t, job.ID)
		return err
	})
	if err != nil {
		return wg.Job{}, err
	}
	return job, nil
}

func (q *webhookQueue) Cancel(ctx context.Context, id string, version uint64) (wg.Job, error) {
	var job wg.Job
	err := q.transact(ctx, func(t *transaction) error {
		var err error
		job, err = q.detail(t, id)
		if err != nil {
			return err
		}
		if version == 0 || version != job.Version || (job.State != wg.Ready && job.State != wg.Claimed) {
			return wg.ErrConflict
		}
		if _, err := t.tx.ExecContext(ctx, `UPDATE cao_operational_webhook_jobs SET state='cancelled',version=version+1,fence=fence+1,owner='',lease_until=NULL,terminal_at=$4,retain_until=greatest(retain_until,$5),reason='cancelled' WHERE namespace=$1 AND queue=$2 AND id=$3`,
			t.namespace, q.name, id, t.now, t.now.Add(q.options.TerminalRetention)); err != nil {
			return err
		}
		job, err = q.detail(t, id)
		return err
	})
	if err != nil {
		return wg.Job{}, err
	}
	return job, nil
}
