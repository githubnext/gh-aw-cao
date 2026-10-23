package postgresx

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/githubnext/gh-cao/server/internal/sqlbuilder"
)

var aggregatePartitionTables = []string{"cao_run_evidence_contributions", "cao_run_contributions", "daily_workflow_aggregates"}

func (s *Store) aggregatePartitions(ctx context.Context) (map[string]time.Time, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT c.relname,p.relname FROM pg_inherits i
		JOIN pg_class c ON c.oid=i.inhrelid JOIN pg_class p ON p.oid=i.inhparent
		WHERE p.relnamespace=current_schema()::regnamespace AND p.relname IN
		('cao_run_evidence_contributions','cao_run_contributions','daily_workflow_aggregates')`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	result := map[string]time.Time{}
	for rows.Next() {
		var name, parent string
		if err := rows.Scan(&name, &parent); err != nil {
			return nil, err
		}
		at, err := time.Parse("20060102", strings.TrimPrefix(name, parent+"_w"))
		if err != nil || at.Weekday() != time.Monday || name != parent+"_w"+at.Format("20060102") {
			return nil, errors.New("aggregate storage requires UTC Monday weekly partitions; rebuild canonical storage in a fresh schema")
		}
		result[name] = at
	}
	return result, rows.Err()
}

func (s *Store) maintainAggregatePartitions(ctx context.Context, now time.Time) error {
	existing, err := s.aggregatePartitions(ctx)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	start, end := aggregateCutoff(now), aggregateWeekStart(now).AddDate(0, 0, 7)
	for at := start; at.Before(end); at = at.AddDate(0, 0, 7) {
		for _, table := range aggregatePartitionTables {
			name := table + "_w" + at.Format("20060102")
			if _, ok := existing[name]; ok {
				continue
			}
			statement, _, err := sqlbuilder.Build("CREATE TABLE {} PARTITION OF {} FOR VALUES FROM ({}) TO ({})",
				sqlbuilder.Identifier(name), sqlbuilder.Identifier(table),
				sqlbuilder.Fragment("'"+at.Format("2006-01-02")+"'"),
				sqlbuilder.Fragment("'"+at.AddDate(0, 0, 7).Format("2006-01-02")+"'"))
			if err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, statement); err != nil {
				return err
			}
		}
	}
	namespaces := map[string]bool{}
	for name, at := range existing {
		if !at.Before(start) {
			continue
		}
		found, err := partitionNamespaces(ctx, tx, name)
		if err != nil {
			return err
		}
		for _, namespace := range found {
			namespaces[namespace] = true
		}
		if _, err := tx.ExecContext(ctx, "DROP TABLE "+pgx.Identifier{name}.Sanitize()); err != nil {
			return err
		}
	}
	for namespace := range namespaces {
		if _, err := tx.ExecContext(ctx, `UPDATE cao_state SET revision=revision+1 WHERE namespace=$1`, namespace); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE cao_quality SET availability=CASE WHEN EXISTS(
			SELECT 1 FROM daily_workflow_aggregates WHERE namespace=$1) THEN 'available' ELSE 'empty' END
			WHERE namespace=$1 AND collection=$2 AND availability<>'unavailable'`, namespace, dailyAggregateSource); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) checkAggregatePartitions(ctx context.Context, now time.Time) error {
	existing, err := s.aggregatePartitions(ctx)
	if err != nil {
		return err
	}
	for at := aggregateCutoff(now); !at.After(aggregateWeekStart(now)); at = at.AddDate(0, 0, 7) {
		for _, table := range aggregatePartitionTables {
			if _, ok := existing[table+"_w"+at.Format("20060102")]; !ok {
				return errors.New("aggregate weekly partitions are not provisioned; run database maintain as owner")
			}
		}
	}
	return nil
}
