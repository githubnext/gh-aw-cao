package sqlitex

import (
	"context"
	"errors"
	"time"

	"github.com/githubnext/gh-cao/internal/dashboardquery"

	"github.com/githubnext/gh-cao/server/internal/dashboardstore"
)

type BackfillTarget struct {
	Repository string
	Since      time.Time
}

// BackfillTargets never discovers repositories through credential reach.
// Inventory comes exclusively from the immutable deployed snapshot; the merged
// run watermark overlaps one day and includes older unfinished runs.
func (s *Store) BackfillTargets(ctx context.Context, now time.Time) ([]BackfillTarget, error) {
	if s.conn == nil {
		return nil, errors.New("backfill requires a local SQLite overlay")
	}
	var targets []BackfillTarget
	err := s.WithReadTransaction(ctx, func(ctx context.Context, r dashboardstore.Reader) error {
		rows, err := r.(*reader).tx.QueryContext(ctx, `
			WITH clocks AS (
				SELECT json_extract(value,'$.repositoryId') AS repository_id,
					max(json_extract(value,'$.startedAt')) AS latest,
					min(CASE WHEN coalesce(json_extract(value,'$.status'),'') != 'completed'
						THEN json_extract(value,'$.startedAt') END) AS unfinished
				FROM __idb_records WHERE database_name=? AND store_name='runs' GROUP BY 1
			)
			SELECT json_extract(repo.value,'$.owner') || '/' || json_extract(repo.value,'$.name'),
				coalesce(clocks.latest,''),coalesce(clocks.unfinished,'')
			FROM snapshot.__idb_records AS repo LEFT JOIN clocks
				ON clocks.repository_id=json_extract(repo.value,'$.id')
			WHERE repo.database_name=? AND repo.store_name='repositories'
			ORDER BY repo.record_key LIMIT 10001`, dashboardquery.DatabaseName, dashboardquery.DatabaseName)
		if err != nil {
			return err
		}
		defer func() { _ = rows.Close() }()
		for rows.Next() {
			var repository, latest, unfinished string
			if err := rows.Scan(&repository, &latest, &unfinished); err != nil {
				return err
			}
			since := now.AddDate(0, 0, -30)
			if at, err := time.Parse(time.RFC3339Nano, latest); err == nil && at.Before(now) {
				since = maxTime(since, at.Add(-24*time.Hour))
			}
			if at, err := time.Parse(time.RFC3339Nano, unfinished); err == nil && at.Before(since) {
				since = maxTime(now.AddDate(0, 0, -30), at.Add(-time.Hour))
			}
			targets = append(targets, BackfillTarget{Repository: repository, Since: since})
		}
		if len(targets) > 10000 {
			return errors.New("local backfill exceeds the 10000-repository scope limit")
		}
		return rows.Err()
	})
	return targets, err
}

func maxTime(left, right time.Time) time.Time {
	if right.After(left) {
		return right
	}
	return left
}
