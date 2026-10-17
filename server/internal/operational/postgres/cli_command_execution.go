package postgres

import (
	"context"
	"database/sql"
	"errors"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

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
		if err := t.tx.QueryRowContext(ctx, `SELECT count(*) FROM cao_operational_cli_commands WHERE namespace=$1 AND queue=$2 AND execution_claimed`, t.namespace, q.name).Scan(&count); err != nil {
			return err
		}
		if count >= q.options.MaxConcurrency {
			return nil
		}
		var id int64
		err := t.tx.QueryRowContext(ctx, `SELECT id FROM cao_operational_cli_commands WHERE namespace=$1 AND queue=$2 AND status='queued' ORDER BY id LIMIT 1`, t.namespace, q.name).Scan(&id)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if _, err := t.tx.ExecContext(ctx, `UPDATE cao_operational_cli_commands SET status='running',execution_claimed=TRUE,started_at=$4,deadline=$5 WHERE namespace=$1 AND queue=$2 AND id=$3`, t.namespace, q.name, id, t.now, t.now.Add(q.options.Timeout)); err != nil {
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

func (q *cliCommandQueue) Finish(ctx context.Context, lease operational.CLICommandLease, id int64, result operational.CLICommandResult) error {
	if ctx == nil {
		return invalid("nil context")
	}
	ctx, cancel := context.WithTimeout(ctx, operational.AuditWriteTimeout)
	defer cancel()
	if id < 1 || (result.Status != operational.CLICommandCompleted && result.Status != operational.CLICommandFailed && result.Status != operational.CLICommandTimedOut) ||
		len(result.Error) > 512 || operational.ValidateCLICommandText(result.Error) != nil ||
		(result.ExitCode != nil && (*result.ExitCode < -2147483648 || *result.ExitCode > 2147483647)) {
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
		_, err = t.tx.ExecContext(ctx, `UPDATE cao_operational_cli_commands SET status=$4,exit_code=$5,error=$6,completed_at=$7,completion_week=$8 WHERE namespace=$1 AND queue=$2 AND id=$3`,
			t.namespace, q.name, id, result.Status, result.ExitCode, result.Error, t.now, cliMonday(t.now))
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
	if id < 1 || (exitCode != nil && (*exitCode < -2147483648 || *exitCode > 2147483647)) {
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
		_, err = t.tx.ExecContext(ctx, `UPDATE cao_operational_cli_commands SET execution_claimed=FALSE,exit_code=coalesce($4,exit_code) WHERE namespace=$1 AND queue=$2 AND id=$3`, t.namespace, q.name, id, exitCode)
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
		if _, err := t.tx.ExecContext(ctx, `UPDATE cao_operational_cli_commands SET status='canceled',error='The CLI action was canceled.',completed_at=$4,completion_week=$5 WHERE namespace=$1 AND queue=$2 AND id=$3`, t.namespace, q.name, id, t.now, cliMonday(t.now)); err != nil {
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
	if id < 1 || (stream != "stdout" && stream != "stderr") || data == "" || int64(len(data)) > q.store.config.MaxRecordBytes || operational.ValidateCLICommandText(data) != nil {
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
		if err := t.tx.QueryRowContext(ctx, `SELECT coalesce(sum(output_bytes),0) FROM cao_operational_cli_commands WHERE namespace=$1 AND queue=$2`, t.namespace, q.name).Scan(&total); err != nil {
			return err
		}
		if len(data) > q.options.MaxChunkBytes || command.OutputBytes+len(data) > q.options.MaxOutputBytes ||
			command.OutputChunks >= q.options.MaxOutputChunks || total+len(data) > q.options.MaxQueueOutputBytes {
			output.Truncated = true
			_, err := t.tx.ExecContext(ctx, `UPDATE cao_operational_cli_commands SET output_truncated=TRUE WHERE namespace=$1 AND queue=$2 AND id=$3`, t.namespace, q.name, id)
			return err
		}
		size := int64(128 + len(data))
		if err := t.reserveCLI(size, 1); err != nil {
			return err
		}
		output = operational.CLICommandOutput{Sequence: int64(command.OutputChunks + 1), Stream: stream, Data: data}
		if _, err := t.tx.ExecContext(ctx, `INSERT INTO cao_operational_cli_output(namespace,queue,command_id,sequence,stream,data) VALUES($1,$2,$3,$4,$5,$6)`, t.namespace, q.name, id, output.Sequence, stream, data); err != nil {
			return err
		}
		_, err = t.tx.ExecContext(ctx, `UPDATE cao_operational_cli_commands SET output_bytes=output_bytes+$4,output_chunks=output_chunks+1,storage_bytes=storage_bytes+$5 WHERE namespace=$1 AND queue=$2 AND id=$3`, t.namespace, q.name, id, len(data), size)
		return err
	})
	if err != nil {
		return operational.CLICommandOutput{}, err
	}
	return output, nil
}
