package postgres

import (
	"context"
	"errors"
	"time"

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
	if err := names(id); err != nil {
		return false, err
	}
	if err := opaque(namespace); err != nil {
		return false, err
	}
	if err := operational.ValidateRevocationTransition(id, expected, replacement, events); err != nil {
		return false, err
	}
	changed := false
	err := s.transact(ctx, func(t *transaction) error {
		k := key{"revocation", namespace, id}
		value, err := t.get(k)
		if err != nil || string(value) != expected {
			return err
		}
		for _, event := range events {
			var recorded bool
			if err := t.tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM cao_operational_audit_events
				WHERE namespace=$1 AND (event=$2 OR ($2<>'token.revoke_failed' AND event IN ('token.revoked','token.expired')))
				AND event IN ('token.revoked','token.expired','token.revoke_failed')
				AND record::jsonb->'attributes'->>'hashed_token'=$3)`, s.namespace, event.Event, id).Scan(&recorded); err != nil {
				return err
			}
			if !recorded {
				if _, err := t.appendAudit(event); err != nil {
					return err
				}
			}
		}
		if replacement == "" {
			err = t.remove(k)
		} else {
			err = t.put(k, []byte(replacement), time.Time{})
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
	rows, err := t.tx.QueryContext(t.ctx, `SELECT id FROM cao_operational_cli_commands WHERE namespace=$1 AND queue=$2 AND `+condition+` ORDER BY id`, t.namespace, q.name)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	if closeErr := rows.Close(); err != nil || closeErr != nil {
		return errors.Join(err, closeErr)
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
