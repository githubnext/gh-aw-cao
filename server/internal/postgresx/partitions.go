package postgresx

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

const defaultRunRetentionDays = 400
const futureRunWeeks = 4

// RunPartitionMaintenance is an administrative operation, never part of
// ingestion. Only whole weeks strictly older than the retention cutoff go.
func (s *Store) RunPartitionMaintenance(ctx context.Context, now time.Time, retentionDays int) error {
	if retentionDays < 7 || retentionDays > 3650 {
		return fmt.Errorf("run retention days must be between 7 and 3650")
	}
	lock, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = lock.Close() }()
	if _, err := lock.ExecContext(ctx, "SELECT pg_advisory_lock(712083241, 17484)"); err != nil {
		return err
	}
	defer func() {
		release, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = lock.ExecContext(release, "SELECT pg_advisory_unlock(712083241, 17484)")
	}()
	tables := []string{"events", "sessions", "audits", "domains", "eval_observations", "experiment_assignments", "friction", "grader_observations", "issues", "jobs", "skills", "tools", "runs"}
	cutoff := now.UTC().AddDate(0, 0, -retentionDays)
	week := func(t time.Time) time.Time {
		t = t.UTC()
		day := (int(t.Weekday()) + 6) % 7
		return time.Date(t.Year(), t.Month(), t.Day()-day, 0, 0, 0, 0, time.UTC)
	}
	start := week(cutoff)
	end := week(now).AddDate(0, 0, 7*(futureRunWeeks+1))
	rows, err := s.db.QueryContext(ctx, `SELECT c.relname FROM pg_inherits i
		JOIN pg_class c ON c.oid=i.inhrelid WHERE i.inhparent=to_regclass('runs')`)
	if err != nil {
		return err
	}
	var expired []time.Time
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			_ = rows.Close()
			return err
		}
		if !strings.HasPrefix(name, "runs_w") || len(name) != len("runs_w")+8 {
			_ = rows.Close()
			return fmt.Errorf("unexpected runs partition")
		}
		date, err := time.Parse("20060102", strings.TrimPrefix(name, "runs_w"))
		if err != nil {
			_ = rows.Close()
			return err
		}
		if !date.AddDate(0, 0, 7).After(cutoff) {
			expired = append(expired, date)
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	_ = rows.Close()
	for _, at := range expired {
		if err := s.maintainWeek(ctx, tables, at, true); err != nil {
			return err
		}
	}
	for at := start; at.Before(end); at = at.AddDate(0, 0, 7) {
		if err := s.maintainWeek(ctx, tables, at, false); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) maintainWeek(ctx context.Context, tables []string, at time.Time, drop bool) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var namespaces []string
	if drop {
		rows, err := tx.QueryContext(ctx, "SELECT DISTINCT namespace FROM runs_w"+at.Format("20060102"))
		if err != nil {
			return err
		}
		for rows.Next() {
			var namespace string
			if err := rows.Scan(&namespace); err != nil {
				_ = rows.Close()
				return err
			}
			namespaces = append(namespaces, namespace)
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return err
		}
		_ = rows.Close()
		for _, namespace := range namespaces {
			if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':' || $1, 0))`, namespace); err != nil {
				return err
			}
		}
	}
	for _, table := range tables {
		name := table + "_w" + at.Format("20060102")
		if drop {
			if _, err := tx.ExecContext(ctx, "ALTER TABLE "+table+" DETACH PARTITION "+name); err != nil {
				return fmt.Errorf("detach expired %s: %w", name, err)
			}
			if _, err := tx.ExecContext(ctx, "DROP TABLE "+name); err != nil {
				return fmt.Errorf("drop expired %s: %w", name, err)
			}
		} else {
			statement := fmt.Sprintf("CREATE TABLE IF NOT EXISTS %s PARTITION OF %s FOR VALUES FROM ('%s') TO ('%s')",
				name, table, at.Format(time.RFC3339), at.AddDate(0, 0, 7).Format(time.RFC3339))
			if _, err := tx.ExecContext(ctx, statement); err != nil {
				return fmt.Errorf("create weekly %s: %w", name, err)
			}
		}
	}
	for _, namespace := range namespaces {
		for _, table := range tables {
			var count int
			if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM "+table+" WHERE namespace=$1", namespace).Scan(&count); err != nil {
				return err
			}
			source := ""
			for key, entity := range entityTables {
				if entity.name == table {
					source = key
					break
				}
			}
			if source == "" {
				return fmt.Errorf("unregistered run partition table %s", table)
			}
			if _, err := tx.ExecContext(ctx, `UPDATE cao_quality SET row_count=$1,availability=$2 WHERE namespace=$3 AND collection=$4`,
				count, map[bool]string{true: "empty", false: "available"}[count == 0], namespace, source); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, "UPDATE cao_state SET revision=revision+1 WHERE namespace=$1", namespace); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func configuredRetentionDays() (int, error) {
	value := strings.TrimSpace(os.Getenv("CAO_POSTGRES_RUN_RETENTION_DAYS"))
	if value == "" {
		return defaultRunRetentionDays, nil
	}
	days, err := strconv.Atoi(value)
	if err != nil || days < 7 || days > 3650 {
		return 0, fmt.Errorf("CAO_POSTGRES_RUN_RETENTION_DAYS must be between 7 and 3650")
	}
	return days, nil
}
