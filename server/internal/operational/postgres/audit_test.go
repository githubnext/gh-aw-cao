package postgres

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

func TestSQLAuditRetentionMatchesContract(t *testing.T) {
	if !strings.Contains(schema, fmt.Sprintf("INTERVAL '%d hours'", int64(AuditRetention/time.Hour))) {
		t.Fatal("SQL retention must match the minimum elapsed-duration contract independently of session timezone")
	}
}

func appendAuditEvents(t *testing.T, s *Store, count int) {
	t.Helper()
	for i := range count {
		event, err := s.AppendAudit(t.Context(), operational.AuditEvent{Event: "cli_command.admitted", Outcome: "success", Actor: "octocat",
			Attributes: map[string]string{"command_id": string(rune('a' + i)), "repository": "octo/repo"}})
		if err != nil {
			t.Fatal(err)
		}
		if event.Sequence != int64(i+1) || event.OccurredAt.IsZero() {
			t.Fatalf("event %d = %+v", i, event)
		}
	}
}

// tamper runs SQL with triggers disabled for this session only, simulating a
// privileged actor who bypasses the append-only guard.
func tamper(t *testing.T, dsn, statement string, args ...any) {
	t.Helper()
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	tx, err := db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(t.Context(), `SET LOCAL session_replication_role = replica`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(t.Context(), statement, args...); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}

func TestAuditAppendListAndVerify(t *testing.T) {
	s, _ := testStore(t, Config{})
	if _, err := s.AppendAudit(t.Context(), operational.AuditEvent{Event: "x", Outcome: "maybe"}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("invalid outcome err = %v", err)
	}
	appendAuditEvents(t, s, 3)
	if _, err := s.AppendAudit(t.Context(), operational.AuditEvent{Event: "admin.denied", Outcome: "denied", Actor: "mallory"}); err != nil {
		t.Fatal(err)
	}
	all, err := s.ListAudit(t.Context(), operational.AuditFilter{})
	if err != nil || len(all) != 4 || all[0].Attributes["repository"] != "octo/repo" || all[3].Actor != "mallory" {
		t.Fatalf("list = %+v, %v", all, err)
	}
	filtered, err := s.ListAudit(t.Context(), operational.AuditFilter{Actor: "octocat", AfterSequence: 1, Limit: 1})
	if err != nil || len(filtered) != 1 || filtered[0].Sequence != 2 {
		t.Fatalf("filtered = %+v, %v", filtered, err)
	}
	result, err := s.VerifyAudit(t.Context())
	if err != nil || result.Events != 4 || result.FirstSequence != 1 || result.LastSequence != 4 {
		t.Fatalf("verify = %+v, %v", result, err)
	}
}

func TestAuditRejectsUpdateAndDelete(t *testing.T) {
	s, _ := testStore(t, Config{})
	appendAuditEvents(t, s, 1)
	for _, statement := range []string{
		`UPDATE cao_operational_audit_events SET actor='mallory' WHERE namespace=$1`,
		`DELETE FROM cao_operational_audit_events WHERE namespace=$1`,
	} {
		if _, err := s.db.ExecContext(t.Context(), statement, s.namespace); err == nil || !strings.Contains(err.Error(), "append-only") {
			t.Fatalf("%s err = %v", statement, err)
		}
	}
}

func TestAuditVerifyDetectsTampering(t *testing.T) {
	cases := map[string]string{
		"edited record":  `UPDATE cao_operational_audit_events SET record=replace(record,'octocat','mallory'), actor='mallory' WHERE namespace=$1 AND sequence=2`,
		"edited column":  `UPDATE cao_operational_audit_events SET actor='mallory' WHERE namespace=$1 AND sequence=2`,
		"deleted middle": `DELETE FROM cao_operational_audit_events WHERE namespace=$1 AND sequence=2`,
	}
	for name, statement := range cases {
		t.Run(name, func(t *testing.T) {
			s, dsn := testStore(t, Config{})
			appendAuditEvents(t, s, 3)
			tamper(t, dsn, statement, s.namespace)
			if _, err := s.VerifyAudit(t.Context()); !errors.Is(err, operational.ErrAuditTampered) {
				t.Fatalf("verify err = %v", err)
			}
		})
	}
}

func TestAuditRetentionKeepsVerifiableSuffix(t *testing.T) {
	s, dsn := testStore(t, Config{})
	appendAuditEvents(t, s, 4)
	old := time.Now().Add(-AuditRetention - 24*time.Hour)
	// Age every row, including the newest, past retention.
	tamper(t, dsn, `UPDATE cao_operational_audit_events SET occurred_at=$2 WHERE namespace=$1`, s.namespace, old)
	if _, err := s.RetainAudit(t.Context()); err != nil {
		t.Fatal(err)
	}
	var remaining, first int64
	if err := s.db.QueryRowContext(t.Context(), `SELECT count(*),min(sequence) FROM cao_operational_audit_events WHERE namespace=$1`, s.namespace).Scan(&remaining, &first); err != nil {
		t.Fatal(err)
	}
	if remaining != 1 || first != 4 {
		t.Fatalf("remaining=%d first=%d; the newest event must survive retention", remaining, first)
	}
	event, err := s.AppendAudit(t.Context(), operational.AuditEvent{Event: "token.revoked", Outcome: "success"})
	if err != nil || event.Sequence != 5 {
		t.Fatalf("append after retention = %+v, %v", event, err)
	}
	// Column/record time differ for the aged row, so verify only the chain of
	// rows appended after retention by checking hashes link.
	var prevMatches bool
	if err := s.db.QueryRowContext(t.Context(), `SELECT b.prev_hash=a.hash FROM cao_operational_audit_events a JOIN cao_operational_audit_events b ON b.namespace=a.namespace AND b.sequence=a.sequence+1 WHERE a.namespace=$1 AND a.sequence=4`, s.namespace).Scan(&prevMatches); err != nil || !prevMatches {
		t.Fatalf("chain link after retention = %v, %v", prevMatches, err)
	}
}

func TestAuditNamespaceDeletionCascades(t *testing.T) {
	s, dsn := testStore(t, Config{})
	appendAuditEvents(t, s, 2)
	if err := s.DeleteNamespace(t.Context()); err != nil {
		t.Fatalf("namespace deletion must cascade through the append-only guard: %v", err)
	}
	var remaining int64
	if err := s.db.QueryRowContext(t.Context(), `SELECT count(*) FROM cao_operational_audit_events WHERE namespace=$1`, s.namespace).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("remaining=%d err=%v", remaining, err)
	}
	if _, err := New(t.Context(), dsn, s.namespace, Config{}); err != nil {
		t.Fatal(err)
	}
}
