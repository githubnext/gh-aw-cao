package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

const (
	// AuditRetention keeps audit events for at least thirteen months, which
	// covers annual compliance reviews with a margin.
	AuditRetention         = 400 * 24 * time.Hour
	maxAuditAttributes     = 64
	maxAuditValueBytes     = 4096
	maxAuditRecordBytes    = 64 << 10
	maxAuditListLimit      = 1000
	auditRetentionBatchCap = 512
)

var auditGenesis = make([]byte, sha256.Size)

func validAuditEvent(event operational.AuditEvent) error {
	if err := names(event.Event); err != nil {
		return err
	}
	switch event.Outcome {
	case "success", "denied", "failure":
	default:
		return invalid("audit outcome must be success, denied, or failure")
	}
	if len(event.Actor) > 1024 || strings.ContainsRune(event.Actor, 0) {
		return invalid("invalid audit actor")
	}
	if len(event.Attributes) > maxAuditAttributes {
		return invalid("too many audit attributes")
	}
	for name, value := range event.Attributes {
		if err := names(name); err != nil {
			return err
		}
		if len(value) > maxAuditValueBytes || strings.ContainsRune(value, 0) {
			return invalid("oversized or NUL-containing audit attribute")
		}
	}
	return nil
}

// canonicalAuditRecord is the exact text hashed into the chain. encoding/json
// sorts map keys, so equal events always produce equal bytes.
func canonicalAuditRecord(event operational.AuditEvent) ([]byte, error) {
	event.OccurredAt = event.OccurredAt.UTC()
	return json.Marshal(event)
}

func chainHash(prev, record []byte) []byte {
	sum := sha256.New()
	sum.Write(prev)
	sum.Write(record)
	return sum.Sum(nil)
}

// AppendAudit stores one event. The namespace row lock taken by transact
// serializes appends, so sequence numbers are gap-free and each record chains
// to its committed predecessor.
func (s *Store) AppendAudit(ctx context.Context, event operational.AuditEvent) (operational.AuditEvent, error) {
	if err := validAuditEvent(event); err != nil {
		return operational.AuditEvent{}, err
	}
	err := s.transact(ctx, func(t *transaction) error {
		prev := auditGenesis
		var last int64
		err := t.tx.QueryRowContext(ctx, `SELECT sequence,hash FROM cao_operational_audit_events WHERE namespace=$1 ORDER BY sequence DESC LIMIT 1`, t.namespace).Scan(&last, &prev)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		event.Sequence = last + 1
		event.OccurredAt = t.now
		record, err := canonicalAuditRecord(event)
		if err != nil {
			return err
		}
		if len(record) > maxAuditRecordBytes {
			return invalid("audit record exceeds payload limit")
		}
		_, err = t.tx.ExecContext(ctx, `INSERT INTO cao_operational_audit_events(namespace,sequence,occurred_at,event,outcome,actor,record,prev_hash,hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
			t.namespace, event.Sequence, event.OccurredAt, event.Event, event.Outcome, event.Actor, string(record), prev, chainHash(prev, record))
		return err
	})
	if err != nil {
		return operational.AuditEvent{}, err
	}
	return event, nil
}

// ListAudit returns events in ascending sequence order.
func (s *Store) ListAudit(ctx context.Context, filter operational.AuditFilter) ([]operational.AuditEvent, error) {
	if ctx == nil {
		return nil, invalid("nil context")
	}
	limit := filter.Limit
	if limit <= 0 || limit > maxAuditListLimit {
		limit = maxAuditListLimit
	}
	rows, err := s.db.QueryContext(ctx, `SELECT record FROM cao_operational_audit_events WHERE namespace=$1 AND sequence>$2 AND ($3='' OR event=$3) AND ($4='' OR actor=$4) ORDER BY sequence LIMIT $5`,
		s.namespace, filter.AfterSequence, filter.Event, filter.Actor, limit)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	events := []operational.AuditEvent{}
	for rows.Next() {
		var record string
		if err := rows.Scan(&record); err != nil {
			return nil, err
		}
		var event operational.AuditEvent
		if err := json.Unmarshal([]byte(record), &event); err != nil {
			return nil, fmt.Errorf("corrupt audit record: %w", err)
		}
		events = append(events, event)
	}
	return events, rows.Err()
}

// VerifyAudit recomputes the hash chain over every retained event. Retention
// removes the oldest prefix, so the oldest retained prev_hash is the anchor.
func (s *Store) VerifyAudit(ctx context.Context) (operational.AuditVerification, error) {
	if ctx == nil {
		return operational.AuditVerification{}, invalid("nil context")
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return operational.AuditVerification{}, err
	}
	defer func() { _ = tx.Rollback() }()
	rows, err := tx.QueryContext(ctx, `SELECT sequence,occurred_at,event,outcome,actor,record,prev_hash,hash FROM cao_operational_audit_events WHERE namespace=$1 ORDER BY sequence`, s.namespace)
	if err != nil {
		return operational.AuditVerification{}, err
	}
	defer func() { _ = rows.Close() }()
	var result operational.AuditVerification
	var expectedPrev []byte
	tampered := func(sequence int64, reason string) error {
		return fmt.Errorf("%w at sequence %d: %s", operational.ErrAuditTampered, sequence, reason)
	}
	for rows.Next() {
		var row operational.AuditEvent
		var record string
		var prev, hash []byte
		if err := rows.Scan(&row.Sequence, &row.OccurredAt, &row.Event, &row.Outcome, &row.Actor, &record, &prev, &hash); err != nil {
			return result, err
		}
		if result.Events > 0 && row.Sequence != result.LastSequence+1 {
			return result, tampered(row.Sequence, "sequence gap")
		}
		if expectedPrev != nil && !bytes.Equal(prev, expectedPrev) {
			return result, tampered(row.Sequence, "broken chain")
		}
		if !bytes.Equal(hash, chainHash(prev, []byte(record))) {
			return result, tampered(row.Sequence, "hash mismatch")
		}
		var stored operational.AuditEvent
		if err := json.Unmarshal([]byte(record), &stored); err != nil {
			return result, tampered(row.Sequence, "unreadable record")
		}
		if stored.Sequence != row.Sequence || !stored.OccurredAt.Equal(row.OccurredAt) || stored.Event != row.Event ||
			stored.Outcome != row.Outcome || stored.Actor != row.Actor {
			return result, tampered(row.Sequence, "indexed columns differ from the hashed record")
		}
		if result.Events == 0 {
			result.FirstSequence = row.Sequence
		}
		result.Events++
		result.LastSequence = row.Sequence
		expectedPrev = hash
	}
	return result, rows.Err()
}

// maintainAudit removes events past retention in bounded batches. Only a
// contiguous oldest prefix is removed, so retained rows remain a verifiable
// suffix of the chain even if the database clock moved backwards.
func (t *transaction) maintainAudit() error {
	if _, err := t.tx.ExecContext(t.ctx, `SET LOCAL cao.audit_retention = 'on'`); err != nil {
		return err
	}
	// The newest event is always kept so sequence numbers never restart.
	_, err := t.tx.ExecContext(t.ctx, `DELETE FROM cao_operational_audit_events WHERE namespace=$1 AND sequence IN (
		SELECT sequence FROM cao_operational_audit_events WHERE namespace=$1
		AND sequence < LEAST(
			coalesce((SELECT min(sequence) FROM cao_operational_audit_events WHERE namespace=$1 AND occurred_at>=$2), 9223372036854775807),
			(SELECT max(sequence) FROM cao_operational_audit_events WHERE namespace=$1))
		ORDER BY sequence LIMIT $3)`,
		t.namespace, t.now.Add(-AuditRetention), auditRetentionBatchCap)
	if err != nil {
		return err
	}
	_, err = t.tx.ExecContext(t.ctx, `SET LOCAL cao.audit_retention = 'off'`)
	return err
}
