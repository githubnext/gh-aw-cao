package postgresx

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/githubnext/gh-aw-cao/server/internal/sqlbuilder"
)

const defaultRunRetentionDays = 30
const futureRunWeeks = 4
const partitionMaintenanceInterval = 24 * time.Hour

// RunPartitionMaintenance is an administrative operation, never part of
// ingestion. Only whole weeks strictly older than the retention cutoff go.
func (s *Store) RunPartitionMaintenance(ctx context.Context, now time.Time, retentionDays int) error {
	if retentionDays < 7 || retentionDays > 3650 {
		return fmt.Errorf("run retention days must be between 7 and 3650")
	}
	lock, err := pgx.ConnectConfig(ctx, s.config.Copy())
	if err != nil {
		return err
	}
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = lock.Close(closeCtx)
	}()
	if _, err := lock.Exec(ctx, "SELECT pg_advisory_lock(712083241, 17484)"); err != nil {
		return err
	}
	tables := []string{"audits", "domains", "eval_observations", "experiment_assignments", "friction", "grader_observations", "issues", "skills", "tools", "runs"}
	cutoff := now.UTC().AddDate(0, 0, -retentionDays)
	week := func(t time.Time) time.Time {
		t = t.UTC()
		day := (int(t.Weekday()) + 6) % 7
		return time.Date(t.Year(), t.Month(), t.Day()-day, 0, 0, 0, 0, time.UTC)
	}
	start := week(cutoff)
	current := week(now)
	end := current.AddDate(0, 0, 7*(futureRunWeeks+1))
	existing, expired, err := s.existingPartitions(ctx, cutoff)
	if err != nil {
		return err
	}
	// Provision the current and upcoming weeks before any historical backlog.
	for at := current; at.Before(end); at = at.AddDate(0, 0, 7) {
		if err := s.createWeek(ctx, tables, at, existing); err != nil {
			return err
		}
	}
	for at := start; at.Before(current); at = at.AddDate(0, 0, 7) {
		if err := s.createWeek(ctx, tables, at, existing); err != nil {
			return err
		}
	}
	for _, at := range expired {
		if err := s.maintainWeek(ctx, tables, at, true); err != nil {
			return err
		}
	}
	return s.purgeInactiveRepositories(ctx, cutoff)
}

func (s *Store) purgeInactiveRepositories(ctx context.Context, cutoff time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':' || $1, 0))`, s.namespace); err != nil {
		return err
	}
	// Keep the identity while any historical or inventory record still refers
	// to it. Retired identities become eligible only after the retention window.
	rows, err := tx.QueryContext(ctx, `SELECT l.id FROM cao_repository_lifecycle l
		WHERE l.namespace=$1 AND l.lifecycle IN ('deleted','archived') AND l.changed_at<$2
		AND NOT EXISTS (SELECT 1 FROM workflows w WHERE w.namespace=l.namespace AND w.repository_id=l.id)
		AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.namespace=l.namespace AND r.repository_id=l.id)
		AND NOT EXISTS (SELECT 1 FROM operational_values v WHERE v.namespace=l.namespace AND v.repository_id=l.id)`,
		s.namespace, cutoff)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return err
	}
	for _, id := range ids {
		if _, err := tx.ExecContext(ctx, `DELETE FROM repositories WHERE namespace=$1 AND id=$2`, s.namespace, id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM cao_repository_lifecycle WHERE namespace=$1 AND id=$2`, s.namespace, id); err != nil {
			return err
		}
	}
	if len(ids) > 0 {
		if _, err := tx.ExecContext(ctx, `UPDATE cao_state SET revision=revision+1 WHERE namespace=$1`, s.namespace); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) existingPartitions(ctx context.Context, cutoff time.Time) (map[string]bool, []time.Time, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT c.relname,p.relname FROM pg_inherits i
		JOIN pg_class c ON c.oid=i.inhrelid JOIN pg_class p ON p.oid=i.inhparent
		WHERE p.relnamespace=current_schema()::regnamespace AND p.relname IN
		('audits','domains','eval_observations','experiment_assignments',
		 'friction','grader_observations','issues','skills','tools','runs')`)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = rows.Close() }()
	existing := make(map[string]bool)
	var expired []time.Time
	for rows.Next() {
		var name, table string
		if err := rows.Scan(&name, &table); err != nil {
			return nil, nil, err
		}
		existing[name] = true
		if table != "runs" {
			continue
		}
		if !strings.HasPrefix(name, "runs_w") || len(name) != len("runs_w")+8 {
			return nil, nil, fmt.Errorf("unexpected runs partition")
		}
		date, err := time.Parse("20060102", strings.TrimPrefix(name, "runs_w"))
		if err != nil {
			return nil, nil, err
		}
		if !date.AddDate(0, 0, 7).After(cutoff) {
			expired = append(expired, date)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	return existing, expired, nil
}

func (s *Store) createWeek(ctx context.Context, tables []string, at time.Time, existing map[string]bool) error {
	var missing []string
	for _, table := range tables {
		if !existing[table+"_w"+at.Format("20060102")] {
			missing = append(missing, table)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	if err := s.maintainWeek(ctx, missing, at, false); err != nil {
		return err
	}
	for _, table := range missing {
		existing[table+"_w"+at.Format("20060102")] = true
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
		namespaces, err = partitionNamespaces(ctx, tx, "runs_w"+at.Format("20060102"))
		if err != nil {
			return err
		}
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
			statement, _, err := sqlbuilder.Build("CREATE TABLE {} PARTITION OF {} FOR VALUES FROM ({}) TO ({})",
				sqlbuilder.Identifier(name), sqlbuilder.Identifier(table),
				sqlbuilder.Fragment("'"+at.Format(time.RFC3339)+"'"),
				sqlbuilder.Fragment("'"+at.AddDate(0, 0, 7).Format(time.RFC3339)+"'"))
			if err != nil {
				return err
			}
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
			if _, err := tx.ExecContext(ctx, `UPDATE cao_quality SET availability=CASE WHEN availability='unavailable' THEN 'unavailable' ELSE $1 END WHERE namespace=$2 AND collection=$3`,
				map[bool]string{true: "empty", false: "available"}[count == 0], namespace, source); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, "UPDATE cao_state SET revision=revision+1 WHERE namespace=$1", namespace); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func partitionNamespaces(ctx context.Context, tx *sql.Tx, name string) ([]string, error) {
	statement, _, err := sqlbuilder.Build("SELECT DISTINCT namespace FROM {}", sqlbuilder.Identifier(name))
	if err != nil {
		return nil, err
	}
	rows, err := tx.QueryContext(ctx, statement)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var namespaces []string
	for rows.Next() {
		var namespace string
		if err := rows.Scan(&namespace); err != nil {
			return nil, err
		}
		namespaces = append(namespaces, namespace)
	}
	return namespaces, rows.Err()
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
