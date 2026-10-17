package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

const (
	auditRetentionBatchCap = 512
	auditMaintenanceEvery  = 256
)

// AppendAudit stores one event. BEGIN IMMEDIATE serializes appends across
// processes, so sequence numbers are gap-free and each record chains to its
// committed predecessor.
func (s *Store) AppendAudit(ctx context.Context, event operational.AuditEvent) (operational.AuditEvent, error) {
	if err := operational.ValidateAuditEvent(event); err != nil {
		return operational.AuditEvent{}, invalid(err.Error())
	}
	err := s.transact(ctx, func(t *transaction) error {
		prev := operational.AuditGenesis()
		var last int64
		err := t.tx.QueryRowContext(ctx, `SELECT sequence,hash FROM cao_operational_audit_events ORDER BY sequence DESC LIMIT 1`).Scan(&last, &prev)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		event.Sequence = last + 1
		event.OccurredAt = t.now
		record, err := operational.CanonicalAuditRecord(event)
		if err != nil {
			return invalid(err.Error())
		}
		if _, err := t.tx.ExecContext(ctx, `INSERT INTO cao_operational_audit_events(sequence,occurred_at,event,outcome,actor,record,prev_hash,hash) VALUES (?,?,?,?,?,?,?,?)`,
			event.Sequence, nanos(event.OccurredAt), event.Event, event.Outcome, event.Actor, string(record), prev, operational.AuditChainHash(prev, record)); err != nil {
			return err
		}
		if event.Sequence%auditMaintenanceEvery == 0 {
			return t.maintainAudit()
		}
		return nil
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
	if limit <= 0 || limit > operational.AuditListLimit {
		limit = operational.AuditListLimit
	}
	rows, err := s.db.QueryContext(ctx, `SELECT record FROM cao_operational_audit_events WHERE sequence>? AND (?='' OR event=?) AND (?='' OR actor=?) ORDER BY sequence LIMIT ?`,
		filter.AfterSequence, filter.Event, filter.Event, filter.Actor, filter.Actor, limit)
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

// VerifyAudit recomputes the hash chain over every retained event inside one
// transaction.
func (s *Store) VerifyAudit(ctx context.Context) (operational.AuditVerification, error) {
	var verifier operational.AuditChainVerifier
	err := s.transact(ctx, func(t *transaction) error {
		rows, err := t.tx.QueryContext(ctx, `SELECT sequence,occurred_at,event,outcome,actor,record,prev_hash,hash FROM cao_operational_audit_events ORDER BY sequence`)
		if err != nil {
			return err
		}
		defer func() { _ = rows.Close() }()
		for rows.Next() {
			var row operational.AuditRow
			var occurred int64
			if err := rows.Scan(&row.Indexed.Sequence, &occurred, &row.Indexed.Event, &row.Indexed.Outcome,
				&row.Indexed.Actor, &row.Record, &row.PrevHash, &row.Hash); err != nil {
				return err
			}
			row.Indexed.OccurredAt = time.Unix(0, occurred).UTC()
			if err := verifier.Check(row); err != nil {
				return err
			}
		}
		return rows.Err()
	})
	return verifier.Result(), err
}

// maintainAudit removes events past retention in a bounded batch. Only a
// contiguous oldest prefix is removed and the newest event is always kept, so
// retained rows remain a verifiable suffix and sequences never restart.
func (t *transaction) maintainAudit() error {
	if _, err := t.tx.ExecContext(t.ctx, `INSERT INTO cao_operational_audit_retention(active) VALUES (1)`); err != nil {
		return err
	}
	if _, err := t.tx.ExecContext(t.ctx, `DELETE FROM cao_operational_audit_events WHERE sequence IN (
		SELECT sequence FROM cao_operational_audit_events
		WHERE sequence < MIN(
			coalesce((SELECT min(sequence) FROM cao_operational_audit_events WHERE occurred_at>=?), 9223372036854775807),
			coalesce((SELECT max(sequence) FROM cao_operational_audit_events), 0))
		ORDER BY sequence LIMIT ?)`, nanos(t.now.Add(-operational.AuditRetention)), auditRetentionBatchCap); err != nil {
		return err
	}
	_, err := t.tx.ExecContext(t.ctx, `DELETE FROM cao_operational_audit_retention`)
	return err
}
