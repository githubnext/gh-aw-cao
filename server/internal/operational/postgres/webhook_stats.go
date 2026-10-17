package postgres

import (
	"context"
	"database/sql"
	"time"

	wg "github.com/githubnext/gh-aw-cao/server/internal/webhookgateway"
)

func (q *webhookQueue) QueueStats(ctx context.Context) (wg.QueueStats, error) {
	if ctx == nil {
		return wg.QueueStats{}, wg.ErrInvalid
	}
	tx, err := q.store.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return wg.QueueStats{}, err
	}
	defer func() { _ = tx.Rollback() }()
	stats, err := q.readStats(ctx, tx)
	if err != nil {
		return wg.QueueStats{}, err
	}
	if err := tx.Commit(); err != nil {
		return wg.QueueStats{}, err
	}
	return stats, nil
}

func (q *webhookQueue) readStats(ctx context.Context, tx *sql.Tx) (wg.QueueStats, error) {
	var stats wg.QueueStats
	var now time.Time
	if err := tx.QueryRowContext(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		return stats, err
	}
	if err := tx.QueryRowContext(ctx, `SELECT
		count(*) FILTER (WHERE state IN ('ready','claimed','dispatching')),
		greatest(0,coalesce(extract(epoch FROM ($3::timestamptz-min(created_at) FILTER (WHERE state IN ('ready','claimed','dispatching')))),0))::double precision,
		count(*) FILTER (WHERE state IN ('claimed','dispatching') AND lease_until>$3 AND expires_at>$3),
		count(*),coalesce(sum(storage_bytes),0)
		FROM cao_operational_webhook_jobs WHERE namespace=$1 AND queue=$2`,
		q.store.namespace, q.name, now).Scan(&stats.Depth, &stats.OldestAgeSeconds, &stats.ActiveWorkers, &stats.RetainedRows, &stats.RetainedBytes); err != nil {
		return stats, err
	}
	stats.WorkerUtilization = float64(stats.ActiveWorkers) / float64(q.options.MaxConcurrency)
	var receiptRows, receiptBytes int64
	if err := tx.QueryRowContext(ctx, `SELECT count(*),coalesce(sum(storage_bytes),0) FROM cao_operational_webhook_deliveries WHERE namespace=$1 AND queue=$2`,
		q.store.namespace, q.name).Scan(&receiptRows, &receiptBytes); err != nil {
		return stats, err
	}
	stats.RetainedRows += receiptRows
	stats.RetainedBytes += receiptBytes
	rows, err := tx.QueryContext(ctx, `SELECT greatest(count(*)::double precision/$3,sum(storage_bytes)::double precision/$4)
		FROM (
			SELECT tenant,storage_bytes FROM cao_operational_webhook_jobs WHERE namespace=$1 AND queue=$2
			UNION ALL
			SELECT scopes.tenant,(d.storage_bytes+greatest(cardinality(d.tenants),1)-1)/greatest(cardinality(d.tenants),1)
			FROM cao_operational_webhook_deliveries d
			CROSS JOIN LATERAL unnest(CASE WHEN cardinality(d.tenants)>0 THEN d.tenants ELSE ARRAY[d.tenant] END) scopes(tenant)
			WHERE d.namespace=$1 AND d.queue=$2 AND scopes.tenant<>''
		) retained GROUP BY tenant ORDER BY tenant LIMIT $5`,
		q.store.namespace, q.name, q.options.MaxTenantRows, q.options.MaxTenantBytes, q.options.MaxRows)
	if err != nil {
		return stats, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var utilization float64
		if err := rows.Scan(&utilization); err != nil {
			return stats, err
		}
		stats.TenantUtilization = append(stats.TenantUtilization, utilization)
	}
	if err := rows.Err(); err != nil {
		return stats, err
	}
	if err := rows.Close(); err != nil {
		return stats, err
	}
	return stats, nil
}
