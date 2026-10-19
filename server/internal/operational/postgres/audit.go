package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/githubnext/gh-cao/server/internal/operational"
)

// AuditRetention is the minimum audit retention.
const AuditRetention = operational.AuditRetention

func validAuditEvent(event operational.AuditEvent) error {
	if err := operational.ValidateAuditEvent(event); err != nil {
		return invalid(err.Error())
	}
	return nil
}

// AppendAudit stores one event. The namespace row lock taken by transact
// serializes appends, so sequence numbers are gap-free and each record chains
// to its committed predecessor.
func (s *Store) AppendAudit(ctx context.Context, event operational.AuditEvent) (operational.AuditEvent, error) {
	if ctx == nil {
		return operational.AuditEvent{}, invalid("nil context")
	}
	ctx, cancel := context.WithTimeout(ctx, operational.AuditWriteTimeout)
	defer cancel()
	err := s.transact(ctx, func(t *transaction) error {
		var err error
		event, err = t.appendAudit(event)
		return err
	})
	if err != nil {
		return operational.AuditEvent{}, err
	}
	return event, nil
}

func (t *transaction) appendAudit(event operational.AuditEvent) (operational.AuditEvent, error) {
	if err := validAuditEvent(event); err != nil {
		return operational.AuditEvent{}, err
	}
	prev := operational.AuditGenesis()
	var last int64
	err := t.tx.QueryRowContext(t.ctx, `SELECT sequence,hash FROM cao_operational_audit_events WHERE namespace=$1 ORDER BY sequence DESC LIMIT 1`, t.namespace).Scan(&last, &prev)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return operational.AuditEvent{}, err
	}
	event.Sequence = last + 1
	event.OccurredAt = t.now
	record, err := operational.CanonicalAuditRecord(event)
	if err != nil {
		return operational.AuditEvent{}, invalid(err.Error())
	}
	_, err = t.tx.ExecContext(t.ctx, `INSERT INTO cao_operational_audit_events(namespace,sequence,occurred_at,event,outcome,actor,record,prev_hash,hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
		t.namespace, event.Sequence, event.OccurredAt, event.Event, event.Outcome, event.Actor, string(record), prev, operational.AuditChainHash(prev, record))
	return event, err
}

// ListAudit returns events in ascending sequence order.
func (s *Store) ListAudit(ctx context.Context, filter operational.AuditFilter) ([]operational.AuditEvent, error) {
	if ctx == nil {
		return nil, invalid("nil context")
	}
	limit := filter.Limit
	if limit <= 0 || limit > operational.AuditListLimit {
		limit = operational.AuditListLimit
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
func (s *Store) VerifyAudit(ctx context.Context, anchors ...operational.AuditAnchor) (operational.AuditVerification, error) {
	if ctx == nil {
		return operational.AuditVerification{}, invalid("nil context")
	}
	verifier, err := operational.NewAuditChainVerifier(anchors)
	if err != nil {
		return operational.AuditVerification{}, err
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
	for rows.Next() {
		var row operational.AuditRow
		if err := rows.Scan(&row.Indexed.Sequence, &row.Indexed.OccurredAt, &row.Indexed.Event, &row.Indexed.Outcome,
			&row.Indexed.Actor, &row.Record, &row.PrevHash, &row.Hash); err != nil {
			return verifier.Result(), err
		}
		if err := verifier.Check(row); err != nil {
			return verifier.Result(), err
		}
	}
	if err := rows.Err(); err != nil {
		return verifier.Result(), err
	}
	return verifier.Finish()
}

// RetainAudit invokes the bounded owner-defined retention operation. It is not
// part of operational.Store or Maintain, and requires a separate EXECUTE grant.
func (s *Store) RetainAudit(ctx context.Context) (int64, error) {
	var removed int64
	err := s.db.QueryRowContext(ctx, `SELECT cao_operational_retain_audit($1)`, s.namespace).Scan(&removed)
	return removed, err
}
