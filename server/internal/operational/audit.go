package operational

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
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

const (
	// AuditRetention keeps audit events for at least thirteen months, which
	// covers annual compliance reviews with a margin.
	AuditRetention = 400 * 24 * time.Hour
	// AuditListLimit caps one ListAudit page.
	AuditListLimit      = 1000
	maxAuditAttributes  = 64
	maxAuditValueBytes  = 4096
	maxAuditRecordBytes = 64 << 10
)

// ErrAuditInput reports an event that cannot be stored.
var ErrAuditInput = errors.New("invalid audit event")

func auditInput(message string) error { return fmt.Errorf("%s: %w", message, ErrAuditInput) }

func auditName(value string) bool {
	return strings.TrimSpace(value) != "" && len(value) <= 1024 && !strings.ContainsRune(value, 0)
}

// ValidateAuditEvent checks the bounds every AuditLog enforces.
func ValidateAuditEvent(event AuditEvent) error {
	if !auditName(event.Event) {
		return auditInput("invalid audit event name")
	}
	switch event.Outcome {
	case "success", "denied", "failure":
	default:
		return auditInput("audit outcome must be success, denied, or failure")
	}
	if len(event.Actor) > 1024 || strings.ContainsRune(event.Actor, 0) {
		return auditInput("invalid audit actor")
	}
	if len(event.Attributes) > maxAuditAttributes {
		return auditInput("too many audit attributes")
	}
	for name, value := range event.Attributes {
		if !auditName(name) || len(value) > maxAuditValueBytes || strings.ContainsRune(value, 0) {
			return auditInput("oversized or NUL-containing audit attribute")
		}
	}
	return nil
}

// AuditGenesis is the previous hash of the first event in a chain.
func AuditGenesis() []byte { return make([]byte, sha256.Size) }

// CanonicalAuditRecord is the exact text hashed into the chain. encoding/json
// sorts map keys, so equal events always produce equal bytes.
func CanonicalAuditRecord(event AuditEvent) ([]byte, error) {
	event.OccurredAt = event.OccurredAt.UTC()
	record, err := json.Marshal(event)
	if err != nil {
		return nil, err
	}
	if len(record) > maxAuditRecordBytes {
		return nil, auditInput("audit record exceeds payload limit")
	}
	return record, nil
}

// AuditChainHash links a record to its predecessor.
func AuditChainHash(prev, record []byte) []byte {
	sum := sha256.New()
	sum.Write(prev)
	sum.Write(record)
	return sum.Sum(nil)
}

// AuditRow is one stored audit row as read back for verification.
type AuditRow struct {
	Indexed  AuditEvent
	Record   string
	PrevHash []byte
	Hash     []byte
}

// AuditChainVerifier checks retained rows in ascending sequence order.
// Retention removes the oldest prefix, so the first retained prev_hash is the
// anchor.
type AuditChainVerifier struct {
	result       AuditVerification
	expectedPrev []byte
}

// Check verifies the next row. Indexed carries the separately stored
// sequence, time, event, outcome, and actor columns.
func (v *AuditChainVerifier) Check(row AuditRow) error {
	sequence := row.Indexed.Sequence
	tampered := func(reason string) error {
		return fmt.Errorf("%w at sequence %d: %s", ErrAuditTampered, sequence, reason)
	}
	if v.result.Events > 0 && sequence != v.result.LastSequence+1 {
		return tampered("sequence gap")
	}
	if v.expectedPrev != nil && !bytes.Equal(row.PrevHash, v.expectedPrev) {
		return tampered("broken chain")
	}
	if !bytes.Equal(row.Hash, AuditChainHash(row.PrevHash, []byte(row.Record))) {
		return tampered("hash mismatch")
	}
	var stored AuditEvent
	if err := json.Unmarshal([]byte(row.Record), &stored); err != nil {
		return tampered("unreadable record")
	}
	indexed := row.Indexed
	if stored.Sequence != indexed.Sequence || !stored.OccurredAt.Equal(indexed.OccurredAt) || stored.Event != indexed.Event ||
		stored.Outcome != indexed.Outcome || stored.Actor != indexed.Actor {
		return tampered("indexed columns differ from the hashed record")
	}
	if v.result.Events == 0 {
		v.result.FirstSequence = sequence
	}
	v.result.Events++
	v.result.LastSequence = sequence
	v.expectedPrev = row.Hash
	return nil
}

// Result returns the verification summary so far.
func (v *AuditChainVerifier) Result() AuditVerification { return v.result }
