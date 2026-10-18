package operational

import (
	"context"
	"maps"
	"strconv"
)

// AuditedCLICommandQueue commits each mutation and its hash-chained audit
// event in the same transaction. An error (including an uncertain commit)
// must never leave a runnable command without its admission event. Repeating
// a nonempty idempotency key returns the same retained command and audits
// that request too.
// Hosted admission must require this interface, not compensate with Cancel.
type AuditedCLICommandQueue interface {
	CLICommandQueue
	EnqueueAudited(context.Context, CLICommandInvocation, string, int64, AuditEvent) (CLICommand, AuditEvent, error)
	CancelAudited(context.Context, int64, AuditEvent) (CLICommand, AuditEvent, error)
}

// CLICommandAuditEvent binds caller assurance to the command read within the
// mutation transaction, rather than trusting caller-supplied command fields.
func CLICommandAuditEvent(event AuditEvent, command CLICommand) (AuditEvent, error) {
	if event.Outcome != "success" || event.Actor == "" {
		return AuditEvent{}, ErrAuditInput
	}
	event.Attributes = maps.Clone(event.Attributes)
	if event.Attributes == nil {
		event.Attributes = make(map[string]string)
	}
	event.Attributes["command_id"] = strconv.FormatInt(command.ID, 10)
	event.Attributes["action"] = command.ActionID
	event.Attributes["repository"] = command.Repository
	event.Attributes["status"] = string(command.Status)
	if command.RetryOf != 0 {
		event.Attributes["retry_of"] = strconv.FormatInt(command.RetryOf, 10)
	} else {
		delete(event.Attributes, "retry_of")
	}
	return event, ValidateAuditEvent(event)
}
