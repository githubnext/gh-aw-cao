package postgres

import (
	"context"
	"math"
	"time"

	wg "github.com/githubnext/gh-cao/server/internal/webhookgateway"
)

func (q *webhookQueue) batchMembers(t *transaction, fences []wg.Fence) ([]wg.Job, error) {
	if len(fences) == 0 || len(fences) > wg.MaxDispatchBatchItems {
		return nil, wg.ErrInvalid
	}
	jobs := make([]wg.Job, 0, len(fences))
	for _, fence := range fences {
		job, err := q.detail(t, fence.JobID)
		if err != nil {
			return nil, err
		}
		if err := webhookFence(job, fence, t.now); err != nil {
			return nil, err
		}
		jobs = append(jobs, job)
	}
	if err := wg.ValidateBatchMembers(jobs); err != nil {
		return nil, err
	}
	var count int
	if err := t.tx.QueryRowContext(t.ctx, `SELECT count(*) FROM cao_operational_webhook_jobs
		WHERE namespace=$1 AND queue=$2 AND owner=$3 AND state IN ('claimed','dispatching')`,
		t.namespace, q.name, jobs[0].ClaimID).Scan(&count); err != nil {
		return nil, err
	}
	if count != len(jobs) {
		return nil, wg.ErrConflict
	}
	return jobs, nil
}

func (q *webhookQueue) BeginDispatchBatch(ctx context.Context, fences []wg.Fence, authorizations []wg.Authorization) ([]wg.Job, error) {
	if len(fences) != len(authorizations) {
		return nil, wg.ErrInvalid
	}
	var result []wg.Job
	err := q.transact(ctx, func(t *transaction) error {
		jobs, err := q.batchMembers(t, fences)
		if err != nil {
			return err
		}
		policy, err := q.policy(t)
		if err != nil {
			return err
		}
		until := jobs[0].LeaseUntil
		for i, job := range jobs {
			if job.State != wg.Claimed || job.Version >= math.MaxInt64-1 || !t.now.Before(job.ExpiresAt) ||
				job.Attempt >= job.Subscription.Delivery.MaxAttempts {
				return wg.ErrConflict
			}
			if !policy.Enabled || job.QueueRevision != policy || authorizations[i].Revision != policy {
				return wg.ErrUnauthorized
			}
			if err := wg.ValidateDispatchAuthorization(job, authorizations[i], t.now); err != nil {
				return err
			}
			if job.LeaseUntil.Before(until) {
				until = job.LeaseUntil
			}
		}
		if _, err := wg.BuildDispatchBatch(jobs); err != nil {
			return err
		}
		if err := q.spendRates(t, jobs[0]); err != nil {
			return err
		}
		for _, job := range jobs {
			if _, err := t.tx.ExecContext(ctx, `UPDATE cao_operational_webhook_jobs SET state='dispatching',
				version=version+1,attempt=attempt+1,lease_until=$4 WHERE namespace=$1 AND queue=$2 AND id=$3`,
				t.namespace, q.name, job.ID, until); err != nil {
				return err
			}
			started, err := q.detail(t, job.ID)
			if err != nil {
				return err
			}
			result = append(result, started)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (q *webhookQueue) FinishBatch(ctx context.Context, fences []wg.Fence, outcome wg.Outcome) ([]wg.Job, error) {
	if validateWebhookOutcome(outcome) != nil {
		return nil, wg.ErrInvalid
	}
	var result []wg.Job
	err := q.transact(ctx, func(t *transaction) error {
		jobs, err := q.batchMembers(t, fences)
		if err != nil {
			return err
		}
		policy, err := q.policy(t)
		if err != nil {
			return err
		}
		for _, job := range jobs {
			state := string(outcome.State)
			if outcome.State == wg.Ready {
				state = "retry"
			}
			finished, err := wg.FinishDispatch(t.now, job, job.Fence, job.ClaimID, wg.DispatchResult{
				Outcome: state, Reason: outcome.Reason, RetryAt: outcome.NotBefore, RetryJitter: outcome.RetryJitter,
				AcceptedStatus: outcome.AcceptedStatus, WorkflowRunID: outcome.WorkflowRunID,
			})
			if err != nil {
				return err
			}
			if finished.State == wg.Ready && (!policy.Enabled || policy != finished.QueueRevision) {
				finished, err = wg.CancelJob(t.now, finished, finished.Version)
				if err != nil {
					return err
				}
			}
			var terminalAt *time.Time
			retain := job.ExpiresAt.Add(q.options.DedupWindow)
			if wg.IsTerminal(finished.State) {
				terminalAt = &t.now
				retain = t.now.Add(q.options.TerminalRetention)
			}
			if _, err := t.tx.ExecContext(ctx, `UPDATE cao_operational_webhook_jobs SET state=$4,
				version=version+1,fence=fence+1,owner='',lease_until=NULL,terminal_at=$5,
				retain_until=greatest(retain_until,$6),reason=$7,accepted_status=$8,workflow_run_id=$9,not_before=$10
				WHERE namespace=$1 AND queue=$2 AND id=$3`, t.namespace, q.name, job.ID, finished.State,
				terminalAt, retain, finished.Reason, finished.AcceptedStatus, finished.WorkflowRunID, finished.NotBefore); err != nil {
				return err
			}
			stored, err := q.detail(t, job.ID)
			if err != nil {
				return err
			}
			result = append(result, stored)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}
