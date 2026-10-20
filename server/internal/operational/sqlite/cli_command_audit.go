package sqlite

import (
	"context"

	"github.com/githubnext/gh-cao/server/internal/operational"
)

var _ operational.AuditedCLICommandQueue = (*cliCommandQueue)(nil)

func (q *cliCommandQueue) EnqueueAudited(ctx context.Context, invocation operational.CLICommandInvocation, key string, retryOf int64, event operational.AuditEvent) (operational.CLICommand, operational.AuditEvent, error) {
	if ctx == nil {
		return operational.CLICommand{}, operational.AuditEvent{}, invalid("nil context")
	}
	if event.Event != "cli_command.admitted" && retryOf == 0 || event.Event != "cli_command.retried" && retryOf != 0 {
		return operational.CLICommand{}, operational.AuditEvent{}, operational.ErrAuditInput
	}
	ctx, cancel := context.WithTimeout(ctx, operational.AuditWriteTimeout)
	defer cancel()
	command, err := q.enqueue(ctx, invocation, key, retryOf, &event)
	if err != nil {
		return operational.CLICommand{}, operational.AuditEvent{}, err
	}
	return command, event, nil
}

func (q *cliCommandQueue) CancelAudited(ctx context.Context, id int64, event operational.AuditEvent) (operational.CLICommand, operational.AuditEvent, error) {
	if ctx == nil {
		return operational.CLICommand{}, operational.AuditEvent{}, invalid("nil context")
	}
	if event.Event != "cli_command.cancel_requested" {
		return operational.CLICommand{}, operational.AuditEvent{}, operational.ErrAuditInput
	}
	ctx, cancel := context.WithTimeout(ctx, operational.AuditWriteTimeout)
	defer cancel()
	command, err := q.cancel(ctx, id, &event)
	if err != nil {
		return operational.CLICommand{}, operational.AuditEvent{}, err
	}
	return command, event, nil
}

func (q *cliCommandQueue) mutateCommand(ctx context.Context, command *operational.CLICommand, event *operational.AuditEvent, fn func(*transaction, cliQueueState) error) error {
	return q.transact(ctx, true, func(t *transaction, state cliQueueState) error {
		if err := fn(t, state); err != nil {
			return err
		}
		if event == nil {
			return nil
		}
		bound, err := operational.CLICommandAuditEvent(*event, *command)
		if err != nil {
			return err
		}
		*event, err = t.appendAudit(bound)
		return err
	})
}
