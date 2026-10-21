package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/githubnext/gh-cao/server/internal/operational"
)

type cliCommandQueue struct {
	store   *Store
	name    string
	options operational.CLICommandQueueOptions
}

var _ operational.CLICommandQueues = (*Store)(nil)
var _ operational.CLICommandQueue = (*cliCommandQueue)(nil)

type cliQueueState struct {
	owner           string
	fence, revision int64
	expiry          sql.NullTime
	blocked         bool
}

func (s *Store) OpenCLICommandQueue(ctx context.Context, name string, options operational.CLICommandQueueOptions) (operational.CLICommandQueue, error) {
	if err := names(name); err != nil {
		return nil, err
	}
	options, err := options.Resolve()
	if err != nil {
		return nil, err
	}
	config, err := json.Marshal(options)
	if err != nil {
		return nil, err
	}
	err = s.transact(ctx, func(t *transaction) error {
		var existing []byte
		err := t.tx.QueryRowContext(ctx, `SELECT config FROM cao_operational_cli_queues WHERE namespace=$1 AND name=$2`, s.namespace, name).Scan(&existing)
		if err == nil {
			if !bytes.Equal(existing, config) {
				return invalid("CLI queue configuration differs from existing queue")
			}
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if err := t.reserveCLI(int64(1024+len(name)+len(config)), 1); err != nil {
			return err
		}
		_, err = t.tx.ExecContext(ctx, `INSERT INTO cao_operational_cli_queues(namespace,name,config) VALUES($1,$2,$3)`, s.namespace, name, config)
		return err
	})
	if err != nil {
		return nil, err
	}
	return &cliCommandQueue{store: s, name: name, options: options}, nil
}

func (t *transaction) reserveCLI(bytes, entries int64) error {
	result, err := t.tx.ExecContext(t.ctx, `UPDATE cao_operational_namespaces SET protected_bytes=protected_bytes+$2,protected_entries=protected_entries+$3 WHERE namespace=$1 AND protected_bytes+$2 BETWEEN 0 AND $4 AND protected_entries+$3 BETWEEN 0 AND $5`,
		t.namespace, bytes, entries, t.config.MaxProtectedBytes, t.config.MaxProtectedEntries)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return operational.ErrCapacity
	}
	return nil
}

func (q *cliCommandQueue) transact(ctx context.Context, change bool, fn func(*transaction, cliQueueState) error) error {
	return q.store.transact(ctx, func(t *transaction) error {
		var state cliQueueState
		if err := t.tx.QueryRowContext(ctx, `SELECT owner,fence,lease_until,recovery_blocked,revision FROM cao_operational_cli_queues WHERE namespace=$1 AND name=$2`, t.namespace, q.name).
			Scan(&state.owner, &state.fence, &state.expiry, &state.blocked, &state.revision); err != nil {
			return err
		}
		if err := fn(t, state); err != nil {
			return err
		}
		if change {
			_, err := t.tx.ExecContext(ctx, `UPDATE cao_operational_cli_queues SET revision=revision+1 WHERE namespace=$1 AND name=$2`, t.namespace, q.name)
			return err
		}
		return nil
	})
}

func cliLeaseValid(t *transaction, state cliQueueState, lease operational.CLICommandLease) error {
	if lease.Owner == "" || lease.Fence < 1 || lease.Owner != state.owner || lease.Fence != state.fence ||
		!state.expiry.Valid || !t.now.Before(state.expiry.Time) {
		return operational.ErrConflict
	}
	return nil
}

func cliLeaseTTL(ttl time.Duration) error {
	if ttl < time.Millisecond || ttl > time.Minute {
		return operational.ErrCLICommandInput
	}
	return nil
}

func cliMonday(now time.Time) time.Time {
	now = now.UTC()
	date := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	return date.AddDate(0, 0, -(int(date.Weekday())+6)%7)
}

func (q *cliCommandQueue) Acquire(ctx context.Context, owner string, ttl time.Duration) (operational.CLICommandLease, error) {
	if ctx == nil {
		return operational.CLICommandLease{}, invalid("nil context")
	}
	ctx, cancel := context.WithTimeout(ctx, operational.AuditWriteTimeout)
	defer cancel()
	if err := names(owner); err != nil {
		return operational.CLICommandLease{}, err
	}
	if err := cliLeaseTTL(ttl); err != nil {
		return operational.CLICommandLease{}, err
	}
	if len(owner) > 256 || operational.ValidateCLICommandText(owner) != nil {
		return operational.CLICommandLease{}, operational.ErrCLICommandInput
	}
	var lease operational.CLICommandLease
	err := q.transact(ctx, true, func(t *transaction, state cliQueueState) error {
		if state.expiry.Valid && t.now.Before(state.expiry.Time) {
			return operational.ErrConflict
		}
		var interrupted bool
		if err := t.tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM cao_operational_cli_commands WHERE namespace=$1 AND queue=$2 AND (execution_claimed OR status='running'))`, t.namespace, q.name).Scan(&interrupted); err != nil {
			return err
		}
		if interrupted {
			if err := q.auditRecovery(t, "cli_command.result"); err != nil {
				return err
			}
			if _, err := t.tx.ExecContext(ctx, `UPDATE cao_operational_cli_commands SET status='failed',completed_at=$3,completion_week=$4,error='CLI action interrupted; subprocess termination is unverified.' WHERE namespace=$1 AND queue=$2 AND status='running'`, t.namespace, q.name, t.now, cliMonday(t.now)); err != nil {
				return err
			}
		}
		lease = operational.CLICommandLease{Owner: owner, Fence: state.fence + 1, ExpiresAt: t.now.Add(ttl)}
		_, err := t.tx.ExecContext(ctx, `UPDATE cao_operational_cli_queues SET owner=$3,fence=$4,lease_until=$5,recovery_blocked=recovery_blocked OR $6 WHERE namespace=$1 AND name=$2`,
			t.namespace, q.name, lease.Owner, lease.Fence, lease.ExpiresAt, interrupted)
		return err
	})
	if err != nil {
		return operational.CLICommandLease{}, err
	}
	return lease, nil
}

func (q *cliCommandQueue) Renew(ctx context.Context, lease operational.CLICommandLease, ttl time.Duration) (operational.CLICommandLease, error) {
	if err := cliLeaseTTL(ttl); err != nil {
		return operational.CLICommandLease{}, err
	}
	err := q.transact(ctx, false, func(t *transaction, state cliQueueState) error {
		if err := cliLeaseValid(t, state, lease); err != nil {
			return err
		}
		lease.ExpiresAt = t.now.Add(ttl)
		_, err := t.tx.ExecContext(ctx, `UPDATE cao_operational_cli_queues SET lease_until=$3 WHERE namespace=$1 AND name=$2`, t.namespace, q.name, lease.ExpiresAt)
		return err
	})
	if err != nil {
		return operational.CLICommandLease{}, err
	}
	return lease, nil
}

func (q *cliCommandQueue) Release(ctx context.Context, lease operational.CLICommandLease) error {
	return q.transact(ctx, true, func(t *transaction, state cliQueueState) error {
		if err := cliLeaseValid(t, state, lease); err != nil {
			return err
		}
		var active bool
		if err := t.tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM cao_operational_cli_commands WHERE namespace=$1 AND queue=$2 AND execution_claimed)`, t.namespace, q.name).Scan(&active); err != nil {
			return err
		}
		if active {
			return operational.ErrConflict
		}
		_, err := t.tx.ExecContext(ctx, `UPDATE cao_operational_cli_queues SET owner='',lease_until=NULL WHERE namespace=$1 AND name=$2`, t.namespace, q.name)
		return err
	})
}

func (q *cliCommandQueue) AcknowledgeRecovery(ctx context.Context, lease operational.CLICommandLease) error {
	if ctx == nil {
		return invalid("nil context")
	}
	ctx, cancel := context.WithTimeout(ctx, operational.AuditWriteTimeout)
	defer cancel()
	return q.transact(ctx, true, func(t *transaction, state cliQueueState) error {
		if err := cliLeaseValid(t, state, lease); err != nil {
			return err
		}
		if !state.blocked {
			return operational.ErrConflict
		}
		if err := q.auditRecovery(t, "cli_command.finished"); err != nil {
			return err
		}
		if _, err := t.tx.ExecContext(ctx, `UPDATE cao_operational_cli_commands SET execution_claimed=FALSE WHERE namespace=$1 AND queue=$2`, t.namespace, q.name); err != nil {
			return err
		}
		_, err := t.tx.ExecContext(ctx, `UPDATE cao_operational_cli_queues SET recovery_blocked=FALSE WHERE namespace=$1 AND name=$2`, t.namespace, q.name)
		return err
	})
}

func (q *cliCommandQueue) Enqueue(ctx context.Context, invocation operational.CLICommandInvocation, idempotency string, retryOf int64) (operational.CLICommand, error) {
	return q.enqueue(ctx, invocation, idempotency, retryOf, nil)
}

func (q *cliCommandQueue) enqueue(ctx context.Context, invocation operational.CLICommandInvocation, idempotency string, retryOf int64, event *operational.AuditEvent) (operational.CLICommand, error) {
	data, err := invocation.Encode(q.options.MaxInputBytes)
	if err != nil {
		return operational.CLICommand{}, err
	}
	if int64(len(data)) > q.store.config.MaxRecordBytes {
		return operational.CLICommand{}, operational.ErrCLICommandInput
	}
	if err := operational.ValidateCLICommandKey(idempotency); err != nil {
		return operational.CLICommand{}, err
	}
	if retryOf < 0 {
		return operational.CLICommand{}, operational.ErrCLICommandInput
	}
	fingerprint := sha256.Sum256(append(append([]byte{}, data...), []byte(":"+strconv.FormatInt(retryOf, 10))...))
	var command operational.CLICommand
	err = q.mutateCommand(ctx, &command, event, func(t *transaction, _ cliQueueState) error {
		if idempotency != "" {
			var previous []byte
			var id int64
			err := t.tx.QueryRowContext(ctx, `SELECT id,fingerprint FROM cao_operational_cli_commands WHERE namespace=$1 AND queue=$2 AND idempotency_key=$3`, t.namespace, q.name, idempotency).Scan(&id, &previous)
			if err == nil {
				if !bytes.Equal(previous, fingerprint[:]) {
					return operational.ErrConflict
				}
				command, err = q.detail(t, id)
				return err
			}
			if !errors.Is(err, sql.ErrNoRows) {
				return err
			}
		}
		if retryOf != 0 {
			original, err := q.detail(t, retryOf)
			if err != nil {
				return err
			}
			// Retry is a new admission by the currently authorized requester.
			original.Actor = invocation.Actor
			original.ActorID = invocation.ActorID
			encoded, err := original.Encode(q.options.MaxInputBytes)
			if err != nil {
				return err
			}
			if (original.Status != operational.CLICommandFailed && original.Status != operational.CLICommandTimedOut) || !bytes.Equal(encoded, data) {
				return operational.ErrConflict
			}
		}
		if _, err := t.retainCLI(q.name, cliMonday(t.now.AddDate(0, 0, -q.options.RetentionDays)), 512); err != nil {
			return err
		}
		var count int
		if err := t.tx.QueryRowContext(ctx, `SELECT count(*) FROM cao_operational_cli_commands WHERE namespace=$1 AND queue=$2`, t.namespace, q.name).Scan(&count); err != nil {
			return err
		}
		if count >= q.options.MaxJobs {
			return operational.ErrCapacity
		}
		size := int64(1024 + len(data) + len(idempotency) + len(fingerprint))
		if err := t.reserveCLI(size, 1); err != nil {
			return err
		}
		var key any
		if idempotency != "" {
			key = idempotency
		}
		var id int64
		if err := t.tx.QueryRowContext(ctx, `INSERT INTO cao_operational_cli_commands(namespace,queue,invocation,idempotency_key,fingerprint,retry_of,status,created_at,storage_bytes) VALUES($1,$2,$3,$4,$5,$6,'queued',$7,$8) RETURNING id`, t.namespace, q.name, data, key, fingerprint[:], retryOf, t.now, size).Scan(&id); err != nil {
			return err
		}
		command, err = q.detail(t, id)
		return err
	})
	if err != nil {
		return operational.CLICommand{}, err
	}
	return command, nil
}
