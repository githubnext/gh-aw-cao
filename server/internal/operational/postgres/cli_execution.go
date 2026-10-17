package postgres

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
		result, err := t.tx.ExecContext(ctx, `INSERT INTO cao_operational_cli_executions(namespace,queue,command_id,name,runtime_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(namespace,queue,command_id) DO NOTHING`,
			t.namespace, q.name, execution.CommandID, execution.Name, execution.RuntimeID)
		if err != nil {
			return err
		}
		n, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			return operational.ErrConflict
		}
		size := int64(256 + len(execution.Name) + len(execution.RuntimeID))
		// Execution metadata is accounted as part of its owning command, so
		// retention refunds it together with that command's existing entry.
		if err := t.reserveCLI(size, 0); err != nil {
			return err
		}
		_, err = t.tx.ExecContext(ctx, `UPDATE cao_operational_cli_commands SET storage_bytes=storage_bytes+$4 WHERE namespace=$1 AND queue=$2 AND id=$3`, t.namespace, q.name, execution.CommandID, size)
		return err
	})
}

func (q *cliCommandQueue) UnsettledExecutions(ctx context.Context, lease operational.CLICommandLease) ([]operational.CLICommandExecution, error) {
	executions := []operational.CLICommandExecution{}
	err := q.transact(ctx, false, func(t *transaction, state cliQueueState) error {
		if err := cliLeaseValid(t, state, lease); err != nil {
			return err
		}
		rows, err := t.tx.QueryContext(ctx, `SELECT e.command_id,e.name,e.runtime_id FROM cao_operational_cli_executions e JOIN cao_operational_cli_commands c ON c.namespace=e.namespace AND c.queue=e.queue AND c.id=e.command_id WHERE c.namespace=$1 AND c.queue=$2 AND c.execution_claimed ORDER BY c.id`, t.namespace, q.name)
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
