package postgres

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"time"

	wg "github.com/githubnext/gh-aw-cao/server/internal/webhookgateway"
)

var _ wg.BatchQueue = (*webhookQueue)(nil)

func (q *webhookQueue) ClaimBatch(ctx context.Context, request wg.ClaimRequest) ([]wg.Job, error) {
	if wg.ValidateBatchClaim(request) != nil || request.LeaseDuration > q.options.LeaseDuration {
		return nil, wg.ErrInvalid
	}
	var result []wg.Job
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
		if err := t.tx.QueryRowContext(ctx, `SELECT count(DISTINCT owner) FROM cao_operational_webhook_jobs
			WHERE namespace=$1 AND queue=$2 AND state IN ('claimed','dispatching')`, t.namespace, q.name).Scan(&active); err != nil {
			return err
		}
		if active >= q.options.MaxConcurrency {
			return nil
		}
		var id string
		// '!' sorts below every identifier character, preserving tuple ordering.
		err = t.tx.QueryRowContext(ctx, `SELECT j.id FROM cao_operational_webhook_jobs j
			JOIN cao_operational_webhook_queues q ON q.namespace=j.namespace AND q.name=j.queue
			WHERE j.namespace=$1 AND j.queue=$2 AND j.state='ready' AND j.not_before<=$3
			AND j.expires_at>$3 AND j.created_at<=$4
			ORDER BY ((j.tenant||'!'||j.subscription_id) COLLATE "C">q.tenant_cursor COLLATE "C") DESC,
			(j.tenant||'!'||j.subscription_id) COLLATE "C",j.created_at,j.id LIMIT 1`,
			t.namespace, q.name, t.now, t.now.Add(-request.BatchWindow)).Scan(&id)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		first, err := q.detail(t, id)
		if err != nil {
			return err
		}
		if first.QueueRevision != policy {
			return wg.ErrConflict
		}
		rows, err := t.tx.QueryContext(ctx, `SELECT id FROM cao_operational_webhook_jobs
			WHERE namespace=$1 AND queue=$2 AND subscription_id=$3 AND state='ready'
			AND not_before<=$4 AND expires_at>$4 ORDER BY created_at,id LIMIT $5`,
			t.namespace, q.name, first.Subscription.ID, t.now, wg.MaxDispatchBatchItems)
		if err != nil {
			return err
		}
		defer func() { _ = rows.Close() }()
		var ids []string
		for rows.Next() {
			var candidate string
			if err := rows.Scan(&candidate); err != nil {
				return err
			}
			ids = append(ids, candidate)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		until := t.now.Add(min(request.LeaseDuration, time.Duration(first.Subscription.Delivery.LeaseSeconds)*time.Second))
		for _, candidate := range ids {
			job, err := q.detail(t, candidate)
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
			if job.ExpiresAt.Before(until) {
				until = job.ExpiresAt
			}
		}
		owner := wg.BatchClaimOwner(request.Owner, first)
		for i, job := range result {
			if job.Version >= math.MaxInt64-1 || job.Fence >= math.MaxInt64-1 {
				return wg.ErrConflict
			}
			claimed, err := wg.ClaimJob(t.now, job, job.Version, job.Fence+1, owner)
			if err != nil {
				return err
			}
			if _, err := t.tx.ExecContext(ctx, `UPDATE cao_operational_webhook_jobs SET state='claimed',
				version=$4,fence=$5,owner=$6,lease_until=$7 WHERE namespace=$1 AND queue=$2 AND id=$3`,
				t.namespace, q.name, job.ID, claimed.Version, claimed.Fence, owner, until); err != nil {
				return err
			}
			claimed.LeaseUntil = until
			result[i] = claimed
		}
		_, err = t.tx.ExecContext(ctx, `UPDATE cao_operational_webhook_queues SET tenant_cursor=$3
			WHERE namespace=$1 AND name=$2`, t.namespace, q.name, first.Subscription.TenantID+"!"+first.Subscription.ID)
		return err
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}
