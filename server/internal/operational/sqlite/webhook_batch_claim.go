package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"time"

	wg "github.com/githubnext/gh-cao/server/internal/webhookgateway"
)

var _ wg.BatchQueue = (*Queue)(nil)

func (q *Queue) ClaimBatch(ctx context.Context, request wg.ClaimRequest) ([]wg.Job, error) {
	if wg.ValidateBatchClaim(request) != nil || request.LeaseDuration > q.options.LeaseDuration {
		return nil, wg.ErrInvalid
	}
	var result []wg.Job
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
		if err := tx.QueryRowContext(ctx, `SELECT count(DISTINCT json_extract(document,'$.claimId'))
			FROM jobs WHERE state IN ('claimed','dispatching')`).Scan(&active); err != nil {
			return err
		}
		if active >= q.options.MaxConcurrency {
			return nil
		}
		var id string
		// '!' sorts below every identifier character, preserving tuple ordering.
		err = tx.QueryRowContext(ctx, `SELECT id FROM jobs WHERE state='ready' AND not_before<=? AND expires_at>?
			AND created_at<=? ORDER BY
			(tenant||'!'||json_extract(document,'$.subscription.id')>(SELECT tenant_cursor FROM gateway WHERE id=1)) DESC,
			tenant||'!'||json_extract(document,'$.subscription.id'),created_at,id LIMIT 1`,
			now.UnixMilli(), now.UnixMilli(), now.Add(-request.BatchWindow).UnixMilli()).Scan(&id)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		first, err := load(ctx, tx, id)
		if err != nil {
			return err
		}
		if first.QueueRevision != current {
			return wg.ErrConflict
		}
		ids, err := selectIDs(ctx, tx, `SELECT id FROM jobs WHERE state='ready' AND not_before<=? AND expires_at>?
			AND json_extract(document,'$.subscription.id')=? ORDER BY created_at,id LIMIT ?`,
			now.UnixMilli(), now.UnixMilli(), first.Subscription.ID, wg.MaxDispatchBatchItems)
		if err != nil {
			return err
		}
		until := now.Add(min(request.LeaseDuration, time.Duration(first.Subscription.Delivery.LeaseSeconds)*time.Second))
		for _, candidate := range ids {
			job, err := load(ctx, tx, candidate)
			if err != nil {
				return err
			}
			if !wg.BatchCompatible(first, job) {
				continue
			}
			packed := append(append([]wg.Job(nil), result...), job)
			if _, err := wg.BuildDispatchBatch(packed); err != nil && len(result) > 0 {
				continue
			}
			result = packed
			until = minTime(until, job.ExpiresAt)
		}
		owner := wg.BatchClaimOwner(request.Owner, first)
		for i, job := range result {
			claimed, err := wg.ClaimJob(now, job, job.Version, job.Fence+1, owner)
			if err != nil {
				return err
			}
			claimed.LeaseUntil = until
			if err := q.save(ctx, tx, now, claimed); err != nil {
				return err
			}
			result[i] = claimed
		}
		_, err = tx.ExecContext(ctx, `UPDATE gateway SET tenant_cursor=? WHERE id=1`,
			first.Subscription.TenantID+"!"+first.Subscription.ID)
		return err
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (q *Queue) batchMembers(ctx context.Context, tx *sql.Tx, now time.Time, fences []wg.Fence) ([]wg.Job, error) {
	if len(fences) == 0 || len(fences) > wg.MaxDispatchBatchItems {
		return nil, wg.ErrInvalid
	}
	jobs := make([]wg.Job, 0, len(fences))
	for _, expected := range fences {
		job, err := load(ctx, tx, expected.JobID)
		if err != nil {
			return nil, err
		}
		if err := fence(job, expected, now); err != nil {
			return nil, err
		}
		jobs = append(jobs, job)
	}
	if err := wg.ValidateBatchMembers(jobs); err != nil {
		return nil, err
	}
	var count int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM jobs WHERE state IN ('claimed','dispatching')
		AND json_extract(document,'$.claimId')=?`, jobs[0].ClaimID).Scan(&count); err != nil {
		return nil, err
	}
	if count != len(jobs) {
		return nil, wg.ErrConflict
	}
	return jobs, nil
}
