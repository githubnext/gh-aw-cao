package postgres

import (
	"context"

	wg "github.com/githubnext/gh-cao/server/internal/webhookgateway"
)

func (q *webhookQueue) Maintain(ctx context.Context, limit int) (wg.MaintenanceResult, error) {
	if limit < 1 || limit > 512 {
		return wg.MaintenanceResult{}, wg.ErrInvalid
	}
	var result wg.MaintenanceResult
	err := q.transact(ctx, func(t *transaction) error {
		var err error
		result, err = q.maintain(t, limit)
		return err
	})
	if err != nil {
		return wg.MaintenanceResult{}, err
	}
	return result, nil
}

func (q *webhookQueue) maintain(t *transaction, limit int) (wg.MaintenanceResult, error) {
	var result wg.MaintenanceResult
	rows, err := t.tx.QueryContext(t.ctx, `SELECT id FROM cao_operational_webhook_jobs WHERE namespace=$1 AND queue=$2 AND
		((state='ready' AND expires_at<=$3) OR (state IN ('claimed','dispatching') AND (lease_until<=$3 OR expires_at<=$3)))
		ORDER BY expires_at,id LIMIT $4`, t.namespace, q.name, t.now, limit)
	if err != nil {
		return result, err
	}
	defer func() { _ = rows.Close() }()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return result, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	if closeErr := rows.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return result, err
	}
	for _, id := range ids {
		job, err := q.detail(t, id)
		if err != nil {
			return result, err
		}
		switch {
		case job.State == wg.Dispatching:
			_, err = t.tx.ExecContext(t.ctx, `UPDATE cao_operational_webhook_jobs SET state='ambiguous',version=version+1,fence=fence+1,owner='',lease_until=NULL,terminal_at=$4,retain_until=greatest(retain_until,$5),reason='dispatch-lease-expired' WHERE namespace=$1 AND queue=$2 AND id=$3`, t.namespace, q.name, id, t.now, t.now.Add(q.options.TerminalRetention))
			result.Ambiguous++
		case !t.now.Before(job.ExpiresAt):
			_, err = t.tx.ExecContext(t.ctx, `UPDATE cao_operational_webhook_jobs SET state='expired',version=version+1,fence=fence+1,owner='',lease_until=NULL,terminal_at=$4,retain_until=greatest(retain_until,$5),reason='job-expired' WHERE namespace=$1 AND queue=$2 AND id=$3`, t.namespace, q.name, id, t.now, t.now.Add(q.options.TerminalRetention))
			result.Expired++
		default:
			_, err = t.tx.ExecContext(t.ctx, `UPDATE cao_operational_webhook_jobs SET state='ready',version=version+1,fence=fence+1,owner='',lease_until=NULL,not_before=$4,reason='claim-lease-expired' WHERE namespace=$1 AND queue=$2 AND id=$3`, t.namespace, q.name, id, t.now)
			result.Recovered++
		}
		if err != nil {
			return result, err
		}
	}
	remaining := limit - len(ids)
	if remaining == 0 {
		return result, nil
	}
	var count, size int64
	if err := t.tx.QueryRowContext(t.ctx, `WITH removed AS (
		DELETE FROM cao_operational_webhook_jobs WHERE namespace=$1 AND queue=$2 AND id IN (
			SELECT id FROM cao_operational_webhook_jobs WHERE namespace=$1 AND queue=$2 AND terminal_at IS NOT NULL AND retain_until<=$3 ORDER BY retain_until,id LIMIT $4
		) RETURNING storage_bytes
	) SELECT count(*),coalesce(sum(storage_bytes),0) FROM removed`, t.namespace, q.name, t.now, remaining).Scan(&count, &size); err != nil {
		return result, err
	}
	if err := t.reserveCLI(-size, -count); err != nil {
		return result, err
	}
	result.Deleted += int(count)
	remaining -= int(count)
	if remaining == 0 {
		return result, nil
	}
	if err := t.tx.QueryRowContext(t.ctx, `WITH removed AS (
		DELETE FROM cao_operational_webhook_deliveries d WHERE d.namespace=$1 AND d.queue=$2 AND d.delivery_id IN (
			SELECT r.delivery_id FROM cao_operational_webhook_deliveries r WHERE r.namespace=$1 AND r.queue=$2 AND r.retain_until<=$3 AND NOT EXISTS (
				SELECT 1 FROM cao_operational_webhook_jobs j WHERE j.namespace=r.namespace AND j.queue=r.queue AND j.delivery_id=r.delivery_id
			) ORDER BY r.retain_until,r.delivery_id LIMIT $4
		) RETURNING storage_bytes
	) SELECT count(*),coalesce(sum(storage_bytes),0) FROM removed`, t.namespace, q.name, t.now, remaining).Scan(&count, &size); err != nil {
		return result, err
	}
	if err := t.reserveCLI(-size, -count); err != nil {
		return result, err
	}
	result.Deleted += int(count)
	return result, nil
}
