package operational

import (
	"context"
	"strconv"
)

// AuditedCLICommandLifecycle requires durable result and claim-settlement
// evidence, including interrupted-command recovery. Hosted production must
// require this capability rather than a best-effort logger fallback.
type AuditedCLICommandLifecycle interface {
	CLICommandQueue
	FinishAudited(context.Context, CLICommandLease, int64, CLICommandResult) error
	SettleAudited(context.Context, CLICommandLease, int64, *int) error
	AcknowledgeRecoveryAudited(context.Context, CLICommandLease) error
}

// RevocationTransitions atomically compares a cleanup journal version, replaces
// it (or deletes it for an empty replacement), and appends its pending events.
// A missing or changed version is a no-op, including after an uncertain commit.
// Empty expected inserts only if absent and requires a nonempty replacement
// without events. Token lifecycle events deduplicate against retained audit
// history even if initial journal persistence had an ambiguous outcome.
// Replacement values may contain encrypted credentials; events must not.
type RevocationTransitions interface {
	RevocationQueue
	TransitionRevocation(ctx context.Context, id, expected, replacement, namespace string, events []AuditEvent) (bool, error)
}

func ValidateRevocationTransition(id, expected, replacement string, events []AuditEvent) error {
	if len(events) > 2 || (expected == "" && (replacement == "" || len(events) != 0)) {
		return ErrAuditInput
	}
	for _, event := range events {
		if (event.Event != "token.revoked" && event.Event != "token.expired" && event.Event != "token.revoke_failed") ||
			event.Attributes["hashed_token"] != id {
			return ErrAuditInput
		}
		if err := ValidateAuditEvent(event); err != nil {
			return err
		}
	}
	return nil
}

// CLICommandLifecycleEvent uses only authoritative, credential-free command
// fields. A result is not proof of subprocess termination; finished is emitted
// only with claim settlement or explicit, reconciled recovery acknowledgement.
func CLICommandLifecycleEvent(command CLICommand, queue, event string, recovered bool) AuditEvent {
	outcome := "failure"
	if command.Status == CLICommandCompleted {
		outcome = "success"
	}
	attrs := map[string]string{
		"queue": queue, "command_id": strconv.FormatInt(command.ID, 10),
		"repository": command.Repository, "status": string(command.Status),
		"execution_claimed": strconv.FormatBool(command.ExecutionClaimed),
		"recovered":         strconv.FormatBool(recovered),
	}
	if command.ExitCode != nil {
		attrs["exit_code"] = strconv.Itoa(*command.ExitCode)
	}
	return AuditEvent{Event: event, Outcome: outcome, Actor: command.Actor, Attributes: attrs}
}
