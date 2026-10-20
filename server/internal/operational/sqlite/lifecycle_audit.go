package sqlite

import (
	"context"
	"database/sql"
	"errors"

	"github.com/githubnext/gh-cao/server/internal/operational"
)

var _ operational.RevocationTransitions = (*Store)(nil)
var _ operational.AuditedCLICommandLifecycle = (*cliCommandQueue)(nil)

func (q *cliCommandQueue) FinishAudited(ctx context.Context, lease operational.CLICommandLease, id int64, result operational.CLICommandResult) error {
	return q.Finish(ctx, lease, id, result)
}

func (q *cliCommandQueue) SettleAudited(ctx context.Context, lease operational.CLICommandLease, id int64, code *int) error {
	return q.Settle(ctx, lease, id, code)
}

func (q *cliCommandQueue) AcknowledgeRecoveryAudited(ctx context.Context, lease operational.CLICommandLease) error {
	return q.AcknowledgeRecovery(ctx, lease)
}

func (s *Store) TransitionRevocation(ctx context.Context, id, expected, replacement, namespace string, events []operational.AuditEvent) (bool, error) {
	if ctx == nil {
		return false, invalid("nil context")
	}
	ctx, cancel := context.WithTimeout(ctx, operational.AuditWriteTimeout)
	defer cancel()
	if err := name(id); err != nil {
		return false, err
	}
	if err := name(namespace); err != nil {
		return false, err
	}
	if len(replacement) > 16*1024 {
		return false, operational.ErrAuditInput
	}
	if err := operational.ValidateRevocationTransition(id, expected, replacement, events); err != nil {
		return false, err
	}
	changed := false
	err := s.transact(ctx, func(t *transaction) error {
		var value string
		err := t.tx.QueryRowContext(ctx, `SELECT value FROM cao_operational_cli_revocations WHERE namespace=? AND id=?`, namespace, id).Scan(&value)
		if errors.Is(err, sql.ErrNoRows) {
			if expected != "" {
				return nil
			}
			var count int
			if err := t.tx.QueryRowContext(ctx, `SELECT count(*) FROM cao_operational_cli_revocations`).Scan(&count); err != nil {
				return err
			}
			if count >= 4096 {
				return operational.ErrCapacity
			}
			_, err = t.tx.ExecContext(ctx, `INSERT INTO cao_operational_cli_revocations(namespace,id,value,position)
				VALUES(?,?,?,(SELECT COALESCE(MAX(position),0)+1 FROM cao_operational_cli_revocations))`, namespace, id, replacement)
			changed = err == nil
			return err
		}
		if err != nil || value != expected {
			return err
		}
		for _, event := range events {
			var recorded bool
			if err := t.tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM cao_operational_audit_events
				WHERE (event=? OR (?<>'token.revoke_failed' AND event IN ('token.revoked','token.expired')))
				AND event IN ('token.revoked','token.expired','token.revoke_failed')
				AND json_extract(record,'$.attributes.hashed_token')=?)`, event.Event, event.Event, id).Scan(&recorded); err != nil {
				return err
			}
			if !recorded {
				if _, err := t.appendAudit(event); err != nil {
					return err
				}
			}
		}
		if replacement == "" {
			_, err = t.tx.ExecContext(ctx, `DELETE FROM cao_operational_cli_revocations WHERE namespace=? AND id=?`, namespace, id)
		} else {
			_, err = t.tx.ExecContext(ctx, `UPDATE cao_operational_cli_revocations SET value=? WHERE namespace=? AND id=?`, replacement, namespace, id)
		}
		changed = err == nil
		return err
	})
	return changed && err == nil, err
}

func (q *cliCommandQueue) auditLifecycle(t *transaction, id int64, event string, recovered bool) error {
	command, err := q.detail(t, id)
	if err != nil {
		return err
	}
	_, err = t.appendAudit(operational.CLICommandLifecycleEvent(command, q.name, event, recovered))
	return err
}

func (q *cliCommandQueue) auditRecovery(t *transaction, event string) error {
	condition := "status='running'"
	if event == "cli_command.finished" {
		condition = "execution_claimed"
	}
	// #nosec G202 -- condition is selected from two fixed SQL predicates.
	ids, err := queryIDs(t, `SELECT id FROM cao_operational_cli_commands WHERE queue=? AND `+condition+` ORDER BY id`, q.name)
	if err != nil {
		return err
	}
	for _, id := range ids {
		command, err := q.detail(t, id)
		if err != nil {
			return err
		}
		if event == "cli_command.result" {
			command.Status = operational.CLICommandFailed
			command.ExitCode = nil
		} else {
			command.ExecutionClaimed = false
		}
		if _, err := t.appendAudit(operational.CLICommandLifecycleEvent(command, q.name, event, true)); err != nil {
			return err
		}
	}
	return nil
}
