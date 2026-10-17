package operational

import (
	"context"
	"errors"
	"time"
)

// ErrAuditTampered reports an audit trail whose sequence or hash chain does
// not verify.
var ErrAuditTampered = errors.New("audit trail integrity check failed")

// AuditEvent is one security audit record. Attributes must not contain
// credentials.
type AuditEvent struct {
	Sequence   int64             `json:"sequence"`
	OccurredAt time.Time         `json:"occurred_at"`
	Event      string            `json:"event"`
	Outcome    string            `json:"outcome"`
	Actor      string            `json:"actor,omitempty"`
	Attributes map[string]string `json:"attributes,omitempty"`
}

// AuditFilter selects stored audit events in ascending sequence order.
type AuditFilter struct {
	AfterSequence int64
	Event         string
	Actor         string
	Limit         int
}

// AuditVerification summarizes one integrity check over retained events.
type AuditVerification struct {
	Events        int64
	FirstSequence int64
	LastSequence  int64
}

// AuditLog is an append-only, tamper-evident audit table. Appends assign a
// gap-free sequence and chain each record to its predecessor by SHA-256.
type AuditLog interface {
	AppendAudit(context.Context, AuditEvent) (AuditEvent, error)
	ListAudit(context.Context, AuditFilter) ([]AuditEvent, error)
	VerifyAudit(context.Context) (AuditVerification, error)
}
