package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"time"
	"unicode/utf8"

	wg "github.com/githubnext/gh-aw-cao/server/internal/webhookgateway"
)

func (q *Queue) Claim(ctx context.Context, request wg.ClaimRequest) (*wg.Job, error) {
	if request.LeaseDuration < time.Millisecond || request.LeaseDuration > q.options.LeaseDuration {
		return nil, wg.ErrInvalid
	}
	var result *wg.Job
	err := q.transact(ctx, func(tx *sql.Tx, now time.Time) error {
		if _, err := q.maintain(ctx, tx, now, 512); err != nil {
			return err
		}
		current, err := revision(ctx, tx)
		if err != nil {
			return err
		}
		if !current.Enabled {
			return wg.ErrUnauthorized
		}
		var active int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM jobs WHERE state IN ('claimed','dispatching')`).Scan(&active); err != nil {
			return err
		}
		if active >= q.options.MaxConcurrency {
			return nil
		}
		var id, tenant string
		err = tx.QueryRowContext(ctx, `SELECT id,tenant FROM jobs WHERE state='ready' AND not_before<=? AND expires_at>?
		 ORDER BY (tenant>(SELECT tenant_cursor FROM gateway WHERE id=1)) DESC,tenant,created_at,id LIMIT 1`,
			now.UnixMilli(), now.UnixMilli()).Scan(&id, &tenant)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		job, err := load(ctx, tx, id)
		if err != nil {
			return err
		}
		if job.QueueRevision != current || job.Fence == math.MaxUint64 {
			return wg.ErrConflict
		}
		job, err = wg.ClaimJob(now, job, job.Version, job.Fence+1, request.Owner)
		if err != nil {
			return err
		}
		if until := now.Add(request.LeaseDuration); until.Before(job.LeaseUntil) {
			job.LeaseUntil = until
		}
		if err := q.save(ctx, tx, now, job); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE gateway SET tenant_cursor=? WHERE id=1`, tenant); err != nil {
			return err
		}
		result = &job
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (q *Queue) Renew(ctx context.Context, expected wg.Fence, lease time.Duration) (wg.Job, error) {
	if lease < time.Millisecond || lease > q.options.LeaseDuration {
		return wg.Job{}, wg.ErrInvalid
	}
	var result wg.Job
	err := q.transact(ctx, func(tx *sql.Tx, now time.Time) error {
		job, err := load(ctx, tx, expected.JobID)
		if err != nil {
			return err
		}
		if err := fence(job, expected, now); err != nil {
			return err
		}
		if job.Version == math.MaxUint64 || !job.ExpiresAt.After(now) {
			return wg.ErrConflict
		}
		job.LeaseUntil = minTime(job.ExpiresAt, now.Add(min(lease, time.Duration(job.Subscription.Delivery.LeaseSeconds)*time.Second)))
		job.Version++
		result = job
		return q.save(ctx, tx, now, job)
	})
	return result, err
}

func (q *Queue) BeginDispatch(ctx context.Context, expected wg.Fence, authorization wg.Authorization) (wg.Job, error) {
	var result wg.Job
	err := q.transact(ctx, func(tx *sql.Tx, now time.Time) error {
		job, err := load(ctx, tx, expected.JobID)
		if err != nil {
			return err
		}
		if err := fence(job, expected, now); err != nil {
			return err
		}
		current, err := revision(ctx, tx)
		if err != nil {
			return err
		}
		if !current.Enabled || current != authorization.Revision || current != job.QueueRevision {
			return wg.ErrUnauthorized
		}
		if err := wg.ValidateDispatchAuthorization(job, authorization, now); err != nil {
			return err
		}
		job, err = wg.StartDispatch(now, job, expected.Generation, expected.Owner, wg.AuthorizationDecision{Allowed: true})
		if err != nil {
			return err
		}
		if err := q.spendRates(ctx, tx, now, job); err != nil {
			return err
		}
		result = job
		return q.save(ctx, tx, now, job)
	})
	if err != nil {
		return wg.Job{}, err
	}
	return result, nil
}

func (q *Queue) spendRates(ctx context.Context, tx *sql.Tx, now time.Time, job wg.Job) error {
	d := wg.JobDimensions(job)
	if _, err := tx.ExecContext(ctx, `DELETE FROM rates WHERE expires_at<=?`, now.UnixMilli()); err != nil {
		return err
	}
	for _, scope := range []struct {
		kind, value string
		budget      wg.RateBudget
	}{
		{"global", "", q.options.Rates.Global}, {"app", d.App, q.options.Rates.App},
		{"tenant", d.Tenant, q.options.Rates.Tenant}, {"destination", d.Destination, q.options.Rates.Destination},
		{"workflow", d.Workflow, q.options.Rates.Workflow},
	} {
		identity, err := json.Marshal([]string{scope.kind, scope.value})
		if err != nil {
			return err
		}
		key := wg.MetadataDigest(identity)
		tokens, at := float64(scope.budget.Capacity), now.UnixMilli()
		err = tx.QueryRowContext(ctx, `SELECT tokens,updated_at FROM rates WHERE id=?`, key).Scan(&tokens, &at)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if errors.Is(err, sql.ErrNoRows) {
			var rows int64
			if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM rates`).Scan(&rows); err != nil {
				return err
			}
			if rows/5 >= q.options.MaxRows {
				return wg.ErrCapacity
			}
		}
		elapsed := max(int64(0), now.UnixMilli()-at)
		tokens = min(float64(scope.budget.Capacity), tokens+float64(elapsed)*float64(scope.budget.Capacity)/float64(scope.budget.Period.Milliseconds()))
		if tokens < 1 {
			return wg.ErrCapacity
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO rates VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE
		 SET tokens=excluded.tokens,updated_at=excluded.updated_at,expires_at=excluded.expires_at`,
			key, tokens-1, now.UnixMilli(), now.Add(2*scope.budget.Period).UnixMilli()); err != nil {
			return err
		}
	}
	return nil
}

func (q *Queue) Finish(ctx context.Context, expected wg.Fence, outcome wg.Outcome) (wg.Job, error) {
	if len(outcome.Reason) > 512 || strings.ContainsRune(outcome.Reason, 0) || !utf8.ValidString(outcome.Reason) {
		return wg.Job{}, wg.ErrInvalid
	}
	var result wg.Job
	err := q.transact(ctx, func(tx *sql.Tx, now time.Time) error {
		job, err := load(ctx, tx, expected.JobID)
		if err != nil {
			return err
		}
		if err := fence(job, expected, now); err != nil {
			return err
		}
		state := string(outcome.State)
		if outcome.State == wg.Ready {
			state = "retry"
		}
		job, err = wg.FinishDispatch(now, job, expected.Generation, expected.Owner, wg.DispatchResult{
			Outcome: state, Reason: outcome.Reason, RetryAt: outcome.NotBefore, RetryJitter: outcome.RetryJitter,
			AcceptedStatus: outcome.AcceptedStatus, WorkflowRunID: outcome.WorkflowRunID,
		})
		if err != nil {
			return err
		}
		if job.State == wg.Ready {
			current, err := revision(ctx, tx)
			if err != nil {
				return err
			}
			if !current.Enabled || current != job.QueueRevision {
				job, err = wg.CancelJob(now, job, job.Version)
				if err != nil {
					return err
				}
			}
		}
		result = job
		return q.save(ctx, tx, now, job)
	})
	if err != nil {
		return wg.Job{}, err
	}
	return result, nil
}

func (q *Queue) Cancel(ctx context.Context, id string, version uint64) (wg.Job, error) {
	var result wg.Job
	err := q.transact(ctx, func(tx *sql.Tx, now time.Time) error {
		job, err := load(ctx, tx, id)
		if err != nil {
			return err
		}
		job, err = wg.CancelJob(now, job, version)
		if err != nil {
			return err
		}
		result = job
		return q.save(ctx, tx, now, job)
	})
	return result, err
}

func minTime(a, b time.Time) time.Time {
	if b.Before(a) {
		return b
	}
	return a
}
