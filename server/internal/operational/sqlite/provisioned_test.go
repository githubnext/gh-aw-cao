package sqlite

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

func TestSQLiteExistingOpenDoesNotProvision(t *testing.T) {
	ctx := t.Context()
	for _, readOnly := range []bool{false, true} {
		open := OpenExisting
		if readOnly {
			open = OpenReadOnly
		}
		path := filepath.Join(t.TempDir(), "missing.sqlite")
		if store, err := open(ctx, path); err == nil {
			_ = store.Close()
			t.Fatal("opened an unprovisioned database")
		}
		if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("opening missing state created a file: %v", err)
		}
		if err := os.WriteFile(path, nil, 0o600); err != nil {
			t.Fatal(err)
		}
		if store, err := open(ctx, path); err == nil {
			_ = store.Close()
			t.Fatal("opened an empty database")
		}
		if info, err := os.Stat(path); err != nil || info.Size() != 0 {
			t.Fatalf("opening empty state modified its file: %v", err)
		}
		if _, err := open(nil, path); !errors.Is(err, ErrInvalid) {
			t.Fatalf("nil context: %v", err)
		}
	}

	path := filepath.Join(t.TempDir(), "provisioned.sqlite")
	owner := openTest(t, path)
	var before, after int
	if err := owner.db.QueryRowContext(ctx, "PRAGMA schema_version").Scan(&before); err != nil {
		t.Fatal(err)
	}
	for _, open := range []func(context.Context, string) (*Store, error){OpenExisting, OpenReadOnly} {
		store, err := open(ctx, path)
		if err != nil {
			t.Fatal(err)
		}
		if err := store.Close(); err != nil {
			t.Fatal(err)
		}
	}
	if err := owner.db.QueryRowContext(ctx, "PRAGMA schema_version").Scan(&after); err != nil || before != after {
		t.Fatalf("runtime opening changed schema version %d -> %d: %v", before, after, err)
	}
	if _, err := owner.db.ExecContext(ctx, "DROP TRIGGER cao_operational_audit_no_delete"); err != nil {
		t.Fatal(err)
	}
	for _, open := range []func(context.Context, string) (*Store, error){OpenExisting, OpenReadOnly} {
		if store, err := open(ctx, path); err == nil {
			_ = store.Close()
			t.Fatal("opening repaired or accepted a missing audit guard")
		}
	}
	repaired, err := New(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if err := repaired.Close(); err != nil {
		t.Fatal(err)
	}
	runtime, err := OpenExisting(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if err := runtime.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestSQLiteReadOnlyAudit(t *testing.T) {
	ctx := t.Context()
	path := filepath.Join(t.TempDir(), "audit.sqlite")
	writer := openTest(t, path)
	event := operational.AuditEvent{Event: "test.accepted", Outcome: "success"}
	if _, err := writer.AppendAudit(ctx, event); err != nil {
		t.Fatal(err)
	}
	reader, err := OpenReadOnly(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reader.Close() }()
	// A WAL reader can verify the committed chain while another connection
	// holds the write lock; BEGIN IMMEDIATE would fail here.
	tx, err := writer.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	if result, err := reader.VerifyAudit(ctx); err != nil || result.Events != 1 {
		t.Fatalf("read-only verification: %+v, %v", result, err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	if events, err := reader.ListAudit(ctx, operational.AuditFilter{}); err != nil || len(events) != 1 {
		t.Fatalf("read-only listing: %+v, %v", events, err)
	}
	if _, err := reader.AppendAudit(ctx, event); err == nil {
		t.Fatal("read-only append succeeded")
	}
	if removed, err := reader.RetainAudit(ctx); err == nil || removed != 0 {
		t.Fatalf("read-only retention: %d, %v", removed, err)
	}
	for _, statement := range []string{
		"INSERT INTO cao_operational_audit_retention VALUES (1)",
		"UPDATE cao_operational_audit_events SET actor='changed'",
		"DELETE FROM cao_operational_audit_events",
		"DROP TRIGGER cao_operational_audit_no_delete",
		"DROP TABLE cao_operational_audit_events",
		"CREATE TABLE unauthorized (value TEXT)",
	} {
		if _, err := reader.db.ExecContext(ctx, statement); err == nil {
			t.Fatalf("read-only connection accepted %s", statement)
		}
	}
	if result, err := reader.VerifyAudit(ctx); err != nil || result.Events != 1 {
		t.Fatalf("denied mutations changed history: %+v, %v", result, err)
	}
}

func TestSQLiteRetentionIsExplicitAndBounded(t *testing.T) {
	ctx := t.Context()
	path := filepath.Join(t.TempDir(), "audit.sqlite")
	store := openTest(t, path)
	old := time.Now().Add(-2 * operational.AuditRetention)
	store.now = func() time.Time { return old }
	if err := store.transact(ctx, func(tx *transaction) error {
		for range 514 {
			if _, err := tx.appendAudit(operational.AuditEvent{Event: "test.expired", Outcome: "success"}); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	// Neither legacy bootstrap, explicit bootstrap nor runtime opens may
	// perform implicit retention on existing history.
	for _, open := range []func(context.Context, string) (*Store, error){Open, New, OpenExisting, OpenReadOnly} {
		handle, err := open(ctx, path)
		if err != nil {
			t.Fatal(err)
		}
		result, verifyErr := handle.VerifyAudit(ctx)
		closeErr := handle.Close()
		if verifyErr != nil || closeErr != nil || result.Events != 514 {
			t.Fatalf("open retained audit history: %+v, %v, %v", result, verifyErr, closeErr)
		}
	}
	store.now = time.Now
	// Cross a former automatic-maintenance boundary at sequence 768.
	for range 254 {
		if _, err := store.AppendAudit(ctx, operational.AuditEvent{Event: "test.current", Outcome: "success"}); err != nil {
			t.Fatal(err)
		}
	}
	if result, err := store.VerifyAudit(ctx); err != nil || result.Events != 768 {
		t.Fatalf("append retained audit history: %+v, %v", result, err)
	}
	for _, want := range []int64{512, 2, 0} {
		if removed, err := store.RetainAudit(ctx); err != nil || removed != want {
			t.Fatalf("retention removed %d, want %d: %v", removed, want, err)
		}
	}
	if result, err := store.VerifyAudit(ctx); err != nil || result.FirstSequence != 515 || result.LastSequence != 768 {
		t.Fatalf("retained suffix: %+v, %v", result, err)
	}
}

func TestSQLiteRetentionPreservesRecentPrefixAndRollsBack(t *testing.T) {
	ctx := t.Context()
	store := openTest(t, filepath.Join(t.TempDir(), "audit.sqlite"))
	now := time.Now()
	for _, at := range []time.Time{now.Add(-2 * operational.AuditRetention), now, now.Add(-2 * operational.AuditRetention), now} {
		store.now = func() time.Time { return at }
		if _, err := store.AppendAudit(ctx, operational.AuditEvent{Event: "test.accepted", Outcome: "success"}); err != nil {
			t.Fatal(err)
		}
	}
	store.now = func() time.Time { return now }
	if _, err := store.db.ExecContext(ctx, `CREATE TEMP TRIGGER fail_retention_cleanup
		BEFORE DELETE ON cao_operational_audit_retention
		BEGIN SELECT RAISE(ABORT, 'injected cleanup failure'); END`); err != nil {
		t.Fatal(err)
	}
	if removed, err := store.RetainAudit(ctx); err == nil || removed != 0 {
		t.Fatalf("failed retention reported success: %d, %v", removed, err)
	}
	if result, err := store.VerifyAudit(ctx); err != nil || result.Events != 4 {
		t.Fatalf("failed retention committed changes: %+v, %v", result, err)
	}
	var markers int
	if err := store.db.QueryRowContext(ctx, "SELECT count(*) FROM cao_operational_audit_retention").Scan(&markers); err != nil || markers != 0 {
		t.Fatalf("failed retention left authority marker: %d, %v", markers, err)
	}
	if _, err := store.db.ExecContext(ctx, "DROP TRIGGER fail_retention_cleanup"); err != nil {
		t.Fatal(err)
	}
	if removed, err := store.RetainAudit(ctx); err != nil || removed != 1 {
		t.Fatalf("nonmonotonic retention: %d, %v", removed, err)
	}
	if result, err := store.VerifyAudit(ctx); err != nil || result.FirstSequence != 2 || result.Events != 3 {
		t.Fatalf("retention deleted beyond recent prefix: %+v, %v", result, err)
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if removed, err := store.RetainAudit(canceled); !errors.Is(err, context.Canceled) || removed != 0 {
		t.Fatalf("canceled retention: %d, %v", removed, err)
	}
}
