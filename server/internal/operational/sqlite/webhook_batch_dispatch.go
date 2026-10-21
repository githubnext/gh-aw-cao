package sqlite

import (
	"context"
	"database/sql"
	"strings"
	"time"
	"unicode/utf8"

	wg "github.com/githubnext/gh-cao/server/internal/webhookgateway"
)

func (q *Queue) BeginDispatchBatch(ctx context.Context, fences []wg.Fence, authorizations []wg.Authorization) ([]wg.Job, error) {
	if len(fences) != len(authorizations) {
		return nil, wg.ErrInvalid
	}
	var result []wg.Job
	err := q.transact(ctx, func(tx *sql.Tx, now time.Time) error {
		jobs, err := q.batchMembers(ctx, tx, now, fences)
		if err != nil {
			return err
		}
		current, err := revision(ctx, tx)
		if err != nil {
			return err
		}
		until := jobs[0].LeaseUntil
		for i, job := range jobs {
			if !current.Enabled || current != authorizations[i].Revision || current != job.QueueRevision {
				return wg.ErrUnauthorized
			}
			if err := wg.ValidateDispatchAuthorization(job, authorizations[i], now); err != nil {
				return err
			}
			started, err := wg.StartDispatch(now, job, job.Fence, job.ClaimID, wg.AuthorizationDecision{Allowed: true})
			if err != nil {
				return err
			}
			until = minTime(until, job.LeaseUntil)
			result = append(result, started)
		}
		if _, err := wg.BuildDispatchBatch(jobs); err != nil {
			return err
		}
		if err := q.spendRates(ctx, tx, now, jobs[0]); err != nil {
			return err
		}
		for i := range result {
			result[i].LeaseUntil = until
			if err := q.save(ctx, tx, now, result[i]); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (q *Queue) FinishBatch(ctx context.Context, fences []wg.Fence, outcome wg.Outcome) ([]wg.Job, error) {
	if len(outcome.Reason) > 512 || strings.ContainsRune(outcome.Reason, 0) || !utf8.ValidString(outcome.Reason) {
		return nil, wg.ErrInvalid
	}
	var result []wg.Job
	err := q.transact(ctx, func(tx *sql.Tx, now time.Time) error {
		jobs, err := q.batchMembers(ctx, tx, now, fences)
		if err != nil {
			return err
		}
		current, err := revision(ctx, tx)
		if err != nil {
			return err
		}
		for _, job := range jobs {
			state := string(outcome.State)
			if outcome.State == wg.Ready {
				state = "retry"
			}
			finished, err := wg.FinishDispatch(now, job, job.Fence, job.ClaimID, wg.DispatchResult{
				Outcome: state, Reason: outcome.Reason, RetryAt: outcome.NotBefore, RetryJitter: outcome.RetryJitter,
				AcceptedStatus: outcome.AcceptedStatus, WorkflowRunID: outcome.WorkflowRunID,
			})
			if err != nil {
				return err
			}
			if finished.State == wg.Ready && (!current.Enabled || current != finished.QueueRevision) {
				finished, err = wg.CancelJob(now, finished, finished.Version)
				if err != nil {
					return err
				}
			}
			if err := q.save(ctx, tx, now, finished); err != nil {
				return err
			}
			result = append(result, finished)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}
