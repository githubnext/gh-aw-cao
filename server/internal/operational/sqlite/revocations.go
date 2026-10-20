package sqlite

import (
	"context"
	"database/sql"
	"errors"

	"github.com/githubnext/gh-cao/server/internal/operational"
)

var _ operational.RevocationQueue = (*Store)(nil)

func (s *Store) QueueRevocation(ctx context.Context, id, value, namespace string) error {
	if err := name(id); err != nil {
		return err
	}
	if err := name(namespace); err != nil {
		return err
	}
	if value == "" || len(value) > 16*1024 {
		return invalid("encrypted revocation record is empty or oversized")
	}
	return s.transact(ctx, func(t *transaction) error {
		var entries int
		if err := t.tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM cao_operational_cli_revocations WHERE NOT (namespace=? AND id=?)`, namespace, id).Scan(&entries); err != nil {
			return err
		}
		if entries >= 4096 {
			return operational.ErrCapacity
		}
		_, err := t.tx.ExecContext(ctx, `INSERT INTO cao_operational_cli_revocations(namespace,id,value,position)
			VALUES(?,?,?,(SELECT COALESCE(MAX(position),0)+1 FROM cao_operational_cli_revocations))
			ON CONFLICT(namespace,id) DO UPDATE SET value=excluded.value`,
			namespace, id, value)
		return err
	})
}

func (s *Store) PendingRevocation(ctx context.Context, namespace string) (operational.Revocation, error) {
	if err := name(namespace); err != nil {
		return operational.Revocation{}, err
	}
	var result operational.Revocation
	err := s.transact(ctx, func(t *transaction) error {
		err := t.tx.QueryRowContext(ctx, `SELECT id,value FROM cao_operational_cli_revocations WHERE namespace=? ORDER BY position,id LIMIT 1`, namespace).Scan(&result.ID, &result.Value)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		_, err = t.tx.ExecContext(ctx, `UPDATE cao_operational_cli_revocations
			SET position=(SELECT MAX(position)+1 FROM cao_operational_cli_revocations)
			WHERE namespace=? AND id=?`, namespace, result.ID)
		return err
	})
	return result, err
}

func (s *Store) CompleteRevocation(ctx context.Context, id, expected, namespace string) error {
	if err := name(id); err != nil {
		return err
	}
	if err := name(namespace); err != nil {
		return err
	}
	return s.transact(ctx, func(t *transaction) error {
		_, err := t.tx.ExecContext(ctx, `DELETE FROM cao_operational_cli_revocations WHERE namespace=? AND id=? AND value=?`, namespace, id, expected)
		return err
	})
}
