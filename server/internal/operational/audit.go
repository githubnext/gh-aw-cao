package operational

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
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
// LastHash is the hex chain head; recording (LastSequence, LastHash) outside
// the database yields an AuditAnchor for later verifications.
type AuditVerification struct {
	Events         int64  `json:"events"`
	FirstSequence  int64  `json:"first_sequence"`
	LastSequence   int64  `json:"last_sequence"`
	LastHash       string `json:"last_hash,omitempty"`
	AnchorsChecked int    `json:"anchors_checked"`
	AnchorsExpired int    `json:"anchors_expired"`
}

// AuditAnchor is a previously reported chain position kept outside the
// database. A retained event at Sequence must still hash to Hash, and an
// anchor past the chain head means newer events were removed. Anchors before
// the retained window are counted as expired.
type AuditAnchor struct {
	Sequence int64  `json:"sequence"`
	Hash     string `json:"hash"`
}

// AuditLog is an append-only, tamper-evident audit table. Appends assign a
// gap-free sequence and chain each record to its predecessor by SHA-256.
type AuditLog interface {
	AppendAudit(context.Context, AuditEvent) (AuditEvent, error)
	ListAudit(context.Context, AuditFilter) ([]AuditEvent, error)
	VerifyAudit(context.Context, ...AuditAnchor) (AuditVerification, error)
}

const (
	// AuditWriteTimeout bounds audit persistence, including detached cleanup
	// and queue mutations that atomically append their admission event.
	AuditWriteTimeout = 5 * time.Second
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
	anchors      map[int64]string
}

// NewAuditChainVerifier returns a verifier that also checks anchors.
func NewAuditChainVerifier(anchors []AuditAnchor) (*AuditChainVerifier, error) {
	verifier := &AuditChainVerifier{anchors: make(map[int64]string, len(anchors))}
	for _, anchor := range anchors {
		hash := strings.ToLower(strings.TrimSpace(anchor.Hash))
		decoded, err := hex.DecodeString(hash)
		if anchor.Sequence <= 0 || err != nil || len(decoded) != sha256.Size {
			return nil, fmt.Errorf("%w: audit anchor requires a positive sequence and a 64-character hex SHA-256 hash", ErrAuditInput)
		}
		if previous, ok := verifier.anchors[anchor.Sequence]; ok && previous != hash {
			return nil, fmt.Errorf("%w: conflicting audit anchors for sequence %d", ErrAuditInput, anchor.Sequence)
		}
		verifier.anchors[anchor.Sequence] = hash
	}
	return verifier, nil
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
	if anchor, ok := v.anchors[sequence]; ok {
		if anchor != hex.EncodeToString(row.Hash) {
			return tampered("hash differs from the external anchor")
		}
		v.result.AnchorsChecked++
	}
	if v.result.Events == 0 {
		v.result.FirstSequence = sequence
	}
	v.result.Events++
	v.result.LastSequence = sequence
	v.result.LastHash = hex.EncodeToString(row.Hash)
	v.expectedPrev = row.Hash
	return nil
}

// Result returns the verification summary so far.
func (v *AuditChainVerifier) Result() AuditVerification { return v.result }

// Finish reports anchors that the retained chain cannot account for. An
// anchor beyond the head means events were removed from the newest end.
func (v *AuditChainVerifier) Finish() (AuditVerification, error) {
	for sequence := range v.anchors {
		switch {
		case v.result.Events == 0 || sequence > v.result.LastSequence:
			return v.result, fmt.Errorf("%w: anchored sequence %d is beyond the retained chain head", ErrAuditTampered, sequence)
		case sequence < v.result.FirstSequence:
			v.result.AnchorsExpired++
		}
	}
	return v.result, nil
}
