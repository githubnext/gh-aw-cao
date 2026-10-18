package sqlite

import (
	"context"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

var _ operational.CLICommandExecutionQueue = (*cliCommandQueue)(nil)

func (q *cliCommandQueue) RegisterExecution(ctx context.Context, lease operational.CLICommandLease, execution operational.CLICommandExecution) error {
	if err := execution.Validate(); err != nil {
		return err
	}
	return q.transact(ctx, true, func(t *transaction, state cliQueueState) error {
		if err := cliLeaseValid(t, state, lease); err != nil {
			return err
		}
		if state.blocked {
			return operational.ErrCLIQueueRecovery
		}
		command, err := q.detail(t, execution.CommandID)
		if err != nil {
			return err
		}
		if command.Status != operational.CLICommandRunning || !command.ExecutionClaimed ||
			command.Deadline == nil || !t.now.Before(*command.Deadline) {
			return operational.ErrConflict
		}
		result, err := t.tx.ExecContext(ctx, `INSERT INTO cao_operational_cli_executions(command_id,name,runtime_id) VALUES(?,?,?) ON CONFLICT(command_id) DO NOTHING`,
			execution.CommandID, execution.Name, execution.RuntimeID)
		if err != nil {
			return err
		}
		n, err := result.RowsAffected()
		if err == nil && n != 1 {
			return operational.ErrConflict
		}
		return err
	})
}

func (q *cliCommandQueue) UnsettledExecutions(ctx context.Context, lease operational.CLICommandLease) ([]operational.CLICommandExecution, error) {
	executions := []operational.CLICommandExecution{}
	err := q.transact(ctx, false, func(t *transaction, state cliQueueState) error {
		if err := cliLeaseValid(t, state, lease); err != nil {
			return err
		}
		rows, err := t.tx.QueryContext(ctx, `SELECT e.command_id,e.name,e.runtime_id FROM cao_operational_cli_executions e JOIN cao_operational_cli_commands c ON c.id=e.command_id WHERE c.queue=? AND c.execution_claimed ORDER BY c.id`, q.name)
		if err != nil {
			return err
		}
		defer func() { _ = rows.Close() }()
		for rows.Next() {
			var execution operational.CLICommandExecution
			if err := rows.Scan(&execution.CommandID, &execution.Name, &execution.RuntimeID); err != nil {
				return err
			}
			executions = append(executions, execution)
		}
		return rows.Err()
	})
	return executions, err
}
