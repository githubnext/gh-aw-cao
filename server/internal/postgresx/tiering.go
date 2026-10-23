package postgresx

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/githubnext/gh-cao/server/internal/storagetiers"
)

// PlanStorageTiers scans the stored canonical population, never upstream
// evidence. It neither persists membership nor permits capacity eviction.
func (s *Store) PlanStorageTiers(ctx context.Context, options storagetiers.Options) (storagetiers.Plan, error) {
	if err := ctx.Err(); err != nil {
		return storagetiers.Plan{}, err
	}
	planner, err := storagetiers.New(s.namespace, options)
	if err != nil {
		return storagetiers.Plan{}, err
	}
	var result storagetiers.Plan
	err = s.WithReadTransaction(ctx, func(ctx context.Context, reader NativeReader) error {
		read, ok := reader.(*readTransaction)
		if !ok {
			return errors.New("tier planning requires a native PostgreSQL read transaction")
		}
		var duplicate bool
		// run_at participates in the physical PK. Do not count two partitions'
		// versions as distinct Runs or infer authority from their arrival order.
		if err := read.tx.QueryRowContext(ctx, `SELECT EXISTS (
			SELECT id FROM runs WHERE namespace=$1 GROUP BY id HAVING count(*)>1
		)`, s.namespace).Scan(&duplicate); err != nil {
			return fmt.Errorf("check canonical tier identities: %w", err)
		}
		if duplicate {
			return errors.New("tier planning requires distinct reconciled canonical Run identities")
		}
		if err := read.scanTierRuns(ctx, planner); err != nil {
			return err
		}
		var err error
		result, err = planner.Finish()
		return err
	})
	if err != nil {
		return storagetiers.Plan{}, err
	}
	return result, nil
}

func (r *readTransaction) scanTierRuns(ctx context.Context, planner *storagetiers.Planner) (err error) {
	rows, err := r.tx.QueryContext(ctx, `SELECT id,started_at,completed_at,conclusion
		FROM runs WHERE namespace=$1`, r.store.namespace)
	if err != nil {
		return fmt.Errorf("scan canonical tier runs: %w", err)
	}
	defer func() { err = errors.Join(err, rows.Close()) }()
	for rows.Next() {
		var id string
		var started, completed sql.NullTime
		var conclusion sql.NullString
		if err := rows.Scan(&id, &started, &completed, &conclusion); err != nil {
			return fmt.Errorf("decode canonical tier run: %w", err)
		}
		run := storagetiers.Run{ID: id, Conclusion: conclusion.String}
		startedMilliseconds, err := tierTimestamp(started)
		if err != nil {
			return err
		}
		completedMilliseconds, err := tierTimestamp(completed)
		if err != nil {
			return err
		}
		if startedMilliseconds.Valid {
			run.StartedAt = &startedMilliseconds.Int64
		}
		if completedMilliseconds.Valid {
			run.CompletedAt = &completedMilliseconds.Int64
		}
		if err := planner.Add(run); err != nil {
			return err
		}
	}
	return rows.Err()
}

func tierTimestamp(value sql.NullTime) (sql.NullInt64, error) {
	if !value.Valid {
		return sql.NullInt64{}, nil
	}
	// PostgreSQL's timestamp range exceeds JavaScript's Date range.
	if value.Time.Before(time.UnixMilli(-8_640_000_000_000_000)) ||
		value.Time.After(time.UnixMilli(8_640_000_000_000_000)) {
		return sql.NullInt64{}, errors.New("canonical tier timestamp exceeds the JavaScript Date range")
	}
	return sql.NullInt64{Int64: value.Time.UnixMilli(), Valid: true}, nil
}
