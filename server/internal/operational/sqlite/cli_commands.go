package sqlite

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/githubnext/gh-cao/server/internal/operational"
)

type cliCommandQueue struct {
	store   *Store
	name    string
	options operational.CLICommandQueueOptions
}

var _ operational.CLICommandQueue = (*cliCommandQueue)(nil)

type cliQueueState struct {
	owner           string
	fence, revision int64
	expiry          sql.NullInt64
	blocked         bool
}

// OpenCLICommandQueue creates the queue or opens it with identical options.
func (s *Store) OpenCLICommandQueue(ctx context.Context, queueName string, options operational.CLICommandQueueOptions) (operational.CLICommandQueue, error) {
	if err := name(queueName); err != nil {
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
		err := t.tx.QueryRowContext(ctx, `SELECT config FROM cao_operational_cli_queues WHERE name=?`, queueName).Scan(&existing)
		if err == nil {
			if !bytes.Equal(existing, config) {
				return invalid("CLI queue configuration differs from existing queue")
			}
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		_, err = t.tx.ExecContext(ctx, `INSERT INTO cao_operational_cli_queues(name,config) VALUES(?,?)`, queueName, config)
		return err
	})
	if err != nil {
		return nil, err
	}
	return &cliCommandQueue{store: s, name: queueName, options: options}, nil
}

func (q *cliCommandQueue) transact(ctx context.Context, change bool, fn func(*transaction, cliQueueState) error) error {
	return q.store.transact(ctx, func(t *transaction) error {
		var state cliQueueState
		if err := t.tx.QueryRowContext(ctx, `SELECT owner,fence,lease_until,recovery_blocked,revision FROM cao_operational_cli_queues WHERE name=?`, q.name).
			Scan(&state.owner, &state.fence, &state.expiry, &state.blocked, &state.revision); err != nil {
			return err
		}
		if err := fn(t, state); err != nil {
			return err
		}
		if change {
			_, err := t.tx.ExecContext(ctx, `UPDATE cao_operational_cli_queues SET revision=revision+1 WHERE name=?`, q.name)
			return err
		}
		return nil
	})
}

func cliLeaseValid(t *transaction, state cliQueueState, lease operational.CLICommandLease) error {
	if lease.Owner == "" || lease.Fence < 1 || lease.Owner != state.owner || lease.Fence != state.fence ||
		!state.expiry.Valid || nanos(t.now) >= state.expiry.Int64 {
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

// cliWeek is the UTC Monday of the completion week, as YYYY-MM-DD.
func cliWeek(now time.Time) string {
	now = now.UTC()
	date := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	return date.AddDate(0, 0, -(int(date.Weekday())+6)%7).Format(time.DateOnly)
}

func (q *cliCommandQueue) Acquire(ctx context.Context, owner string, ttl time.Duration) (operational.CLICommandLease, error) {
	if ctx == nil {
		return operational.CLICommandLease{}, invalid("nil context")
	}
	ctx, cancel := context.WithTimeout(ctx, operational.AuditWriteTimeout)
	defer cancel()
	if err := name(owner); err != nil {
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
		if state.expiry.Valid && nanos(t.now) < state.expiry.Int64 {
			return operational.ErrConflict
		}
		var interrupted bool
		if err := t.tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM cao_operational_cli_commands WHERE queue=? AND (execution_claimed OR status='running'))`, q.name).Scan(&interrupted); err != nil {
			return err
		}
		if interrupted {
			if err := q.auditRecovery(t, "cli_command.result"); err != nil {
				return err
			}
			if _, err := t.tx.ExecContext(ctx, `UPDATE cao_operational_cli_commands SET status='failed',completed_at=?,completion_week=?,error='CLI action interrupted; subprocess termination is unverified.' WHERE queue=? AND status='running'`, nanos(t.now), cliWeek(t.now), q.name); err != nil {
				return err
			}
		}
		lease = operational.CLICommandLease{Owner: owner, Fence: state.fence + 1, ExpiresAt: t.now.Add(ttl)}
		_, err := t.tx.ExecContext(ctx, `UPDATE cao_operational_cli_queues SET owner=?,fence=?,lease_until=?,recovery_blocked=(recovery_blocked OR ?) WHERE name=?`,
			lease.Owner, lease.Fence, nanos(lease.ExpiresAt), interrupted, q.name)
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
		_, err := t.tx.ExecContext(ctx, `UPDATE cao_operational_cli_queues SET lease_until=? WHERE name=?`, nanos(lease.ExpiresAt), q.name)
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
		if err := t.tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM cao_operational_cli_commands WHERE queue=? AND execution_claimed)`, q.name).Scan(&active); err != nil {
			return err
		}
		if active {
			return operational.ErrConflict
		}
		_, err := t.tx.ExecContext(ctx, `UPDATE cao_operational_cli_queues SET owner='',lease_until=NULL WHERE name=?`, q.name)
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
		if _, err := t.tx.ExecContext(ctx, `UPDATE cao_operational_cli_commands SET execution_claimed=0 WHERE queue=?`, q.name); err != nil {
			return err
		}
		_, err := t.tx.ExecContext(ctx, `UPDATE cao_operational_cli_queues SET recovery_blocked=0 WHERE name=?`, q.name)
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
			err := t.tx.QueryRowContext(ctx, `SELECT id,fingerprint FROM cao_operational_cli_commands WHERE queue=? AND idempotency_key=?`, q.name, idempotency).Scan(&id, &previous)
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
			encoded, err := original.Encode(q.options.MaxInputBytes)
			if err != nil {
				return err
			}
			if (original.Status != operational.CLICommandFailed && original.Status != operational.CLICommandTimedOut) || !bytes.Equal(encoded, data) {
				return operational.ErrConflict
			}
		}
		if _, err := q.retain(t, 512); err != nil {
			return err
		}
		var count int
		if err := t.tx.QueryRowContext(ctx, `SELECT count(*) FROM cao_operational_cli_commands WHERE queue=?`, q.name).Scan(&count); err != nil {
			return err
		}
		if count >= q.options.MaxJobs {
			return operational.ErrCapacity
		}
		var key any
		if idempotency != "" {
			key = idempotency
		}
		result, err := t.tx.ExecContext(ctx, `INSERT INTO cao_operational_cli_commands(queue,invocation,idempotency_key,fingerprint,retry_of,status,created_at) VALUES(?,?,?,?,?,'queued',?)`,
			q.name, data, key, fingerprint[:], retryOf, nanos(t.now))
		if err != nil {
			return err
		}
		id, err := result.LastInsertId()
		if err != nil {
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

func (q *cliCommandQueue) Claim(ctx context.Context, lease operational.CLICommandLease) (*operational.CLICommand, error) {
	var command *operational.CLICommand
	err := q.transact(ctx, true, func(t *transaction, state cliQueueState) error {
		if err := cliLeaseValid(t, state, lease); err != nil {
			return err
		}
		if state.blocked {
			return operational.ErrCLIQueueRecovery
		}
		var count int
		if err := t.tx.QueryRowContext(ctx, `SELECT count(*) FROM cao_operational_cli_commands WHERE queue=? AND execution_claimed`, q.name).Scan(&count); err != nil {
			return err
		}
		if count >= q.options.MaxConcurrency {
			return nil
		}
		var id int64
		err := t.tx.QueryRowContext(ctx, `SELECT id FROM cao_operational_cli_commands WHERE queue=? AND status='queued' ORDER BY id LIMIT 1`, q.name).Scan(&id)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if _, err := t.tx.ExecContext(ctx, `UPDATE cao_operational_cli_commands SET status='running',execution_claimed=1,started_at=?,deadline=? WHERE queue=? AND id=?`,
			nanos(t.now), nanos(t.now.Add(q.options.Timeout)), q.name, id); err != nil {
			return err
		}
		result, err := q.detail(t, id)
		command = &result
		return err
	})
	if err != nil {
		return nil, err
	}
	return command, nil
}

func validExitCode(code *int) bool {
	return code == nil || (*code >= -2147483648 && *code <= 2147483647)
}

func (q *cliCommandQueue) Finish(ctx context.Context, lease operational.CLICommandLease, id int64, result operational.CLICommandResult) error {
	if ctx == nil {
		return invalid("nil context")
	}
	ctx, cancel := context.WithTimeout(ctx, operational.AuditWriteTimeout)
	defer cancel()
	if id < 1 || (result.Status != operational.CLICommandCompleted && result.Status != operational.CLICommandFailed && result.Status != operational.CLICommandTimedOut) ||
		len(result.Error) > 512 || operational.ValidateCLICommandText(result.Error) != nil || !validExitCode(result.ExitCode) {
		return operational.ErrCLICommandInput
	}
	return q.transact(ctx, true, func(t *transaction, state cliQueueState) error {
		if err := cliLeaseValid(t, state, lease); err != nil {
			return err
		}
		command, err := q.detail(t, id)
		if err != nil {
			return err
		}
		if command.Status.Terminal() {
			return nil // Cancellation/deadline wins a late executor completion.
		}
		if command.Status != operational.CLICommandRunning || !command.ExecutionClaimed ||
			(result.Status == operational.CLICommandTimedOut && (command.Deadline == nil || t.now.Before(*command.Deadline))) {
			return operational.ErrConflict
		}
		_, err = t.tx.ExecContext(ctx, `UPDATE cao_operational_cli_commands SET status=?,exit_code=?,error=?,completed_at=?,completion_week=? WHERE queue=? AND id=?`,
			string(result.Status), result.ExitCode, result.Error, nanos(t.now), cliWeek(t.now), q.name, id)
		if err != nil {
			return err
		}
		return q.auditLifecycle(t, id, "cli_command.result", false)
	})
}

func (q *cliCommandQueue) Settle(ctx context.Context, lease operational.CLICommandLease, id int64, exitCode *int) error {
	if ctx == nil {
		return invalid("nil context")
	}
	ctx, cancel := context.WithTimeout(ctx, operational.AuditWriteTimeout)
	defer cancel()
	if id < 1 || !validExitCode(exitCode) {
		return operational.ErrCLICommandInput
	}
	return q.transact(ctx, true, func(t *transaction, state cliQueueState) error {
		if err := cliLeaseValid(t, state, lease); err != nil {
			return err
		}
		if state.blocked {
			return operational.ErrCLIQueueRecovery
		}
		command, err := q.detail(t, id)
		if err != nil {
			return err
		}
		if !command.Status.Terminal() {
			return operational.ErrConflict
		}
		if !command.ExecutionClaimed {
			return nil
		}
		_, err = t.tx.ExecContext(ctx, `UPDATE cao_operational_cli_commands SET execution_claimed=0,exit_code=coalesce(?,exit_code) WHERE queue=? AND id=?`, exitCode, q.name, id)
		if err != nil {
			return err
		}
		return q.auditLifecycle(t, id, "cli_command.finished", false)
	})
}

func (q *cliCommandQueue) Cancel(ctx context.Context, id int64) (operational.CLICommand, error) {
	return q.cancel(ctx, id, nil)
}

func (q *cliCommandQueue) cancel(ctx context.Context, id int64, event *operational.AuditEvent) (operational.CLICommand, error) {
	var command operational.CLICommand
	err := q.mutateCommand(ctx, &command, event, func(t *transaction, _ cliQueueState) error {
		var err error
		command, err = q.detail(t, id)
		if err != nil || command.Status.Terminal() {
			return err
		}
		if _, err := t.tx.ExecContext(ctx, `UPDATE cao_operational_cli_commands SET status='canceled',error='The CLI action was canceled.',completed_at=?,completion_week=? WHERE queue=? AND id=?`,
			nanos(t.now), cliWeek(t.now), q.name, id); err != nil {
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

func (q *cliCommandQueue) AppendOutput(ctx context.Context, lease operational.CLICommandLease, id int64, stream, data string) (operational.CLICommandOutput, error) {
	if id < 1 || (stream != "stdout" && stream != "stderr") || data == "" || operational.ValidateCLICommandText(data) != nil {
		return operational.CLICommandOutput{}, operational.ErrCLICommandInput
	}
	var output operational.CLICommandOutput
	err := q.transact(ctx, true, func(t *transaction, state cliQueueState) error {
		if err := cliLeaseValid(t, state, lease); err != nil {
			return err
		}
		if state.blocked {
			return operational.ErrCLIQueueRecovery
		}
		command, err := q.detail(t, id)
		if err != nil {
			return err
		}
		if command.Status != operational.CLICommandRunning || !command.ExecutionClaimed {
			return operational.ErrConflict
		}
		var total int
		if err := t.tx.QueryRowContext(ctx, `SELECT coalesce(sum(output_bytes),0) FROM cao_operational_cli_commands WHERE queue=?`, q.name).Scan(&total); err != nil {
			return err
		}
		if len(data) > q.options.MaxChunkBytes || command.OutputBytes+len(data) > q.options.MaxOutputBytes ||
			command.OutputChunks >= q.options.MaxOutputChunks || total+len(data) > q.options.MaxQueueOutputBytes {
			output.Truncated = true
			_, err := t.tx.ExecContext(ctx, `UPDATE cao_operational_cli_commands SET output_truncated=1 WHERE queue=? AND id=?`, q.name, id)
			return err
		}
		output = operational.CLICommandOutput{Sequence: int64(command.OutputChunks + 1), Stream: stream, Data: data}
		if _, err := t.tx.ExecContext(ctx, `INSERT INTO cao_operational_cli_output(command_id,sequence,stream,data) VALUES(?,?,?,?)`, id, output.Sequence, stream, data); err != nil {
			return err
		}
		_, err = t.tx.ExecContext(ctx, `UPDATE cao_operational_cli_commands SET output_bytes=output_bytes+?,output_chunks=output_chunks+1 WHERE queue=? AND id=?`, len(data), q.name, id)
		return err
	})
	if err != nil {
		return operational.CLICommandOutput{}, err
	}
	return output, nil
}

func (q *cliCommandQueue) detail(t *transaction, id int64) (operational.CLICommand, error) {
	if id < 1 {
		return operational.CLICommand{}, operational.ErrCLICommandInput
	}
	var command operational.CLICommand
	var invocation []byte
	var status string
	var created int64
	var started, completed, deadline, exitCode sql.NullInt64
	err := t.tx.QueryRowContext(t.ctx, `SELECT id,invocation,status,created_at,started_at,completed_at,deadline,coalesce(completion_week,''),coalesce(idempotency_key,''),retry_of,exit_code,error,output_bytes,output_chunks,output_truncated,execution_claimed FROM cao_operational_cli_commands WHERE queue=? AND id=?`, q.name, id).
		Scan(&command.ID, &invocation, &status, &created, &started, &completed, &deadline,
			&command.CompletionWeek, &command.IdempotencyKey, &command.RetryOf, &exitCode, &command.Error,
			&command.OutputBytes, &command.OutputChunks, &command.OutputTruncated, &command.ExecutionClaimed)
	if errors.Is(err, sql.ErrNoRows) {
		return operational.CLICommand{}, operational.ErrCLICommandNotFound
	}
	if err != nil {
		return operational.CLICommand{}, err
	}
	command.Status = operational.CLICommandStatus(status)
	command.CreatedAt = time.Unix(0, created).UTC()
	command.StartedAt, command.CompletedAt, command.Deadline = fromNanos(started), fromNanos(completed), fromNanos(deadline)
	if exitCode.Valid {
		code := int(exitCode.Int64)
		command.ExitCode = &code
	}
	if err := json.Unmarshal(invocation, &command.CLICommandInvocation); err != nil {
		return operational.CLICommand{}, err
	}
	return command, nil
}

func (q *cliCommandQueue) Detail(ctx context.Context, id int64) (operational.CLICommand, error) {
	var command operational.CLICommand
	err := q.transact(ctx, false, func(t *transaction, _ cliQueueState) error {
		var err error
		command, err = q.detail(t, id)
		return err
	})
	if err != nil {
		return operational.CLICommand{}, err
	}
	return command, nil
}

func (q *cliCommandQueue) List(ctx context.Context, filter operational.CLICommandFilter) (operational.CLICommandPage, error) {
	if err := filter.Validate(); err != nil {
		return operational.CLICommandPage{}, err
	}
	page := operational.CLICommandPage{Commands: []operational.CLICommand{}}
	where := `queue=?`
	args := []any{q.name}
	if len(filter.Statuses) > 0 {
		where += ` AND status IN (?` + strings.Repeat(`,?`, len(filter.Statuses)-1) + `)`
		for _, status := range filter.Statuses {
			args = append(args, string(status))
		}
	}
	err := q.transact(ctx, false, func(t *transaction, state cliQueueState) error {
		page.Revision, page.RecoveryBlocked = state.revision, state.blocked
		// #nosec G202 -- where contains only fixed SQL and placeholders.
		if err := t.tx.QueryRowContext(ctx, `SELECT count(*) FROM cao_operational_cli_commands WHERE `+where, args...).Scan(&page.Total); err != nil {
			return err
		}
		if err := t.tx.QueryRowContext(ctx, `SELECT count(*) FROM cao_operational_cli_commands WHERE queue=? AND execution_claimed`, q.name).Scan(&page.Running); err != nil {
			return err
		}
		// #nosec G202 -- where contains only fixed SQL and placeholders.
		ids, err := queryIDs(t, `SELECT id FROM cao_operational_cli_commands WHERE `+where+` ORDER BY id DESC LIMIT ? OFFSET ?`,
			append(args, filter.Limit, filter.Offset)...)
		if err != nil {
			return err
		}
		for _, id := range ids {
			command, err := q.detail(t, id)
			if err != nil {
				return err
			}
			// History summaries never expose stdin or output transcripts.
			command.Input = nil
			page.Commands = append(page.Commands, command)
		}
		return nil
	})
	if err != nil {
		return operational.CLICommandPage{}, err
	}
	return page, nil
}

func (q *cliCommandQueue) ListBefore(ctx context.Context, filter operational.CLICommandCursorFilter) (operational.CLICommandCursorPage, error) {
	if err := filter.Validate(); err != nil {
		return operational.CLICommandCursorPage{}, err
	}
	page := operational.CLICommandCursorPage{Commands: []operational.CLICommand{}}
	where := `queue=?`
	args := []any{q.name}
	if filter.BeforeID > 0 {
		where += ` AND id<?`
		args = append(args, filter.BeforeID)
	}
	if len(filter.Statuses) > 0 {
		where += ` AND status IN (?` + strings.Repeat(`,?`, len(filter.Statuses)-1) + `)`
		for _, status := range filter.Statuses {
			args = append(args, string(status))
		}
	}
	err := q.transact(ctx, false, func(t *transaction, state cliQueueState) error {
		page.Revision, page.RecoveryBlocked = state.revision, state.blocked
		// #nosec G202 -- where contains only fixed SQL and placeholders.
		ids, err := queryIDs(t, `SELECT id FROM cao_operational_cli_commands WHERE `+where+` ORDER BY id DESC LIMIT ?`,
			append(args, filter.Limit+1)...)
		if err != nil {
			return err
		}
		page.HasMore = len(ids) > filter.Limit
		if page.HasMore {
			ids = ids[:filter.Limit]
		}
		for _, id := range ids {
			command, err := q.detail(t, id)
			if err != nil {
				return err
			}
			command.Input = nil
			page.Commands = append(page.Commands, command)
		}
		return nil
	})
	if err != nil {
		return operational.CLICommandCursorPage{}, err
	}
	return page, nil
}

func (q *cliCommandQueue) Output(ctx context.Context, id, after int64, limit int) ([]operational.CLICommandOutput, error) {
	if id < 1 || after < 0 || limit < 1 || limit > 500 {
		return nil, operational.ErrCLICommandInput
	}
	output := []operational.CLICommandOutput{}
	err := q.transact(ctx, false, func(t *transaction, _ cliQueueState) error {
		if _, err := q.detail(t, id); err != nil {
			return err
		}
		rows, err := t.tx.QueryContext(ctx, `SELECT sequence,stream,data FROM cao_operational_cli_output WHERE command_id=? AND sequence>? ORDER BY sequence LIMIT ?`, id, after, limit)
		if err != nil {
			return err
		}
		defer func() { _ = rows.Close() }()
		for rows.Next() {
			var chunk operational.CLICommandOutput
			if err := rows.Scan(&chunk.Sequence, &chunk.Stream, &chunk.Data); err != nil {
				return err
			}
			output = append(output, chunk)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return output, nil
}

func (q *cliCommandQueue) Retain(ctx context.Context) (int64, error) {
	var removed int64
	err := q.transact(ctx, true, func(t *transaction, _ cliQueueState) error {
		var err error
		removed, err = q.retain(t, 512)
		return err
	})
	if err != nil {
		return 0, err
	}
	return removed, nil
}

func (q *cliCommandQueue) retain(t *transaction, limit int) (int64, error) {
	cutoff := cliWeek(t.now.AddDate(0, 0, -q.options.RetentionDays))
	result, err := t.tx.ExecContext(t.ctx, `DELETE FROM cao_operational_cli_commands WHERE id IN (
		SELECT id FROM cao_operational_cli_commands WHERE queue=? AND completion_week<? AND NOT execution_claimed AND status NOT IN ('queued','running') ORDER BY completion_week,id LIMIT ?)`,
		q.name, cutoff, limit)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

func queryIDs(t *transaction, query string, args ...any) ([]int64, error) {
	rows, err := t.tx.QueryContext(t.ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
