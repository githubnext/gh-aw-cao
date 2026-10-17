package hostedcli

import (
	"context"
	"errors"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

func (e *Executor) recover(ctx context.Context, lease operational.CLICommandLease) error {
	page, err := e.queue.List(ctx, operational.CLICommandFilter{Limit: 1})
	if err != nil {
		return err
	}
	if !page.RecoveryBlocked {
		return operational.ErrConflict
	}
	executions, err := e.executions.UnsettledExecutions(ctx, lease)
	if err != nil {
		return err
	}
	reconciler, ok := e.runner.(interface {
		Reconcile(context.Context, operational.CLICommandExecution) error
	})
	if len(executions) > 0 && !ok {
		return errors.New("hosted CLI runner cannot reconcile recorded containers")
	}
	for _, execution := range executions {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := reconciler.Reconcile(ctx, execution); err != nil {
			return err
		}
	}
	// This transition is lease-fenced. The operator's explicit acknowledgement
	// covers interrupted pre-registration work; containers also require proof.
	return e.queue.AcknowledgeRecovery(ctx, lease)
}
