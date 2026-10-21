package sqlite

import (
	"context"
	"database/sql"
	"time"

	wg "github.com/githubnext/gh-cao/server/internal/webhookgateway"
)

func (q *Queue) Maintain(ctx context.Context, limit int) (wg.MaintenanceResult, error) {
	if limit < 1 || limit > 10000 {
		return wg.MaintenanceResult{}, wg.ErrInvalid
	}
	var result wg.MaintenanceResult
	err := q.transact(ctx, func(tx *sql.Tx, now time.Time) error {
		var err error
		result, err = q.maintain(ctx, tx, now, limit)
		return err
	})
	return result, err
}

func (q *Queue) maintain(ctx context.Context, tx *sql.Tx, now time.Time, limit int) (wg.MaintenanceResult, error) {
	var result wg.MaintenanceResult
	ids, err := selectIDs(ctx, tx, `SELECT id FROM jobs WHERE state IN ('ready','claimed','dispatching') AND
	 (expires_at<=? OR (state IN ('claimed','dispatching') AND lease_until<=?) OR
	  (state='ready' AND json_extract(document,'$.attempt')>=json_extract(document,'$.subscription.delivery.maxAttempts')))
	 ORDER BY created_at,id LIMIT ?`, now.UnixMilli(), now.UnixMilli(), limit)
	if err != nil {
		return result, err
	}
	for _, id := range ids {
		job, err := load(ctx, tx, id)
		if err != nil {
			return result, err
		}
		next, err := wg.RecoverJob(now, job)
		if err != nil {
			return result, err
		}
		switch next.State {
		case wg.Ambiguous:
			result.Ambiguous++
		case wg.Expired:
			result.Expired++
		case wg.Ready:
			result.Recovered++
		default:
		}
		if err := q.save(ctx, tx, now, next); err != nil {
			return result, err
		}
	}
	remaining := limit - len(ids)
	if remaining == 0 {
		return result, nil
	}
	deleted, err := tx.ExecContext(ctx, `DELETE FROM jobs WHERE id IN
	 (SELECT id FROM jobs WHERE state NOT IN ('ready','claimed','dispatching') AND retain_until<=? LIMIT ?)`,
		now.UnixMilli(), remaining)
	if err != nil {
		return result, err
	}
	count, err := deleted.RowsAffected()
	if err != nil {
		return result, err
	}
	result.Deleted = int(count)
	remaining -= int(count)
	if remaining > 0 {
		deleted, err = tx.ExecContext(ctx, `DELETE FROM deliveries WHERE id IN
		 (SELECT id FROM deliveries WHERE retain_until<=? AND NOT EXISTS(SELECT 1 FROM jobs WHERE delivery=deliveries.id) LIMIT ?)`,
			now.UnixMilli(), remaining)
		if err != nil {
			return result, err
		}
		count, err = deleted.RowsAffected()
		if err != nil {
			return result, err
		}
		result.Deleted += int(count)
	}
	return result, nil
}
