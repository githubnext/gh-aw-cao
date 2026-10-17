package operational_test

import (
	"database/sql"
	"database/sql/driver"
	"errors"
	"os"
	"os/exec"
	"testing"

	sqlitedriver "modernc.org/sqlite"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
	"github.com/githubnext/gh-aw-cao/server/internal/operational/sqlite"
)

func TestAuditedSQLiteCrashDuringAppend(t *testing.T) {
	if path := os.Getenv("CAO_TEST_AUDIT_CRASH_DB"); path != "" {
		if err := sqlitedriver.RegisterScalarFunction("crash_during_audit", 0, func(*sqlitedriver.FunctionContext, []driver.Value) (driver.Value, error) {
			os.Exit(23)
			return int64(0), nil
		}); err != nil {
			t.Fatal(err)
		}
		store, err := sqlite.Open(t.Context(), path)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = store.Close() }()
		queue, err := store.OpenCLICommandQueue(t.Context(), "commands", operational.CLICommandQueueOptions{MaxConcurrency: 1})
		if err != nil {
			t.Fatal(err)
		}
		db, err := sql.Open("sqlite", path)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = db.Close() }()
		if _, err := db.ExecContext(t.Context(), `CREATE TRIGGER crash_audit BEFORE INSERT ON cao_operational_audit_events BEGIN SELECT crash_during_audit(); END`); err != nil {
			t.Fatal(err)
		}
		_, _, err = queue.(operational.AuditedCLICommandQueue).EnqueueAudited(t.Context(), auditInvocation, "request", 0, admissionEvent(0))
		t.Fatalf("expected process exit inside audit INSERT, got %v", err)
	}
	f := newAuditFixture(t, "sqlite")
	lease := acquireAuditLease(t, f)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	child := exec.CommandContext(t.Context(), executable, "-test.run=^TestAuditedSQLiteCrashDuringAppend$") // #nosec G204 -- rerun this test binary with an isolated temporary database.
	child.Env = append(os.Environ(), "CAO_TEST_AUDIT_CRASH_DB="+f.sqlitePath)
	output, err := child.CombinedOutput()
	var exited *exec.ExitError
	if !errors.As(err, &exited) || exited.ExitCode() != 23 {
		t.Fatalf("audit crash helper: %v\n%s", err, output)
	}
	f.exec(t, `DROP TRIGGER crash_audit`)
	verifyAuditCrashRecovery(t, f, lease)
}

func TestAuditedPostgresConnectionLossDuringAppend(t *testing.T) {
	f := newAuditFixture(t, "postgres")
	lease := acquireAuditLease(t, f)
	wait, release := f.gate(t, false)
	done := make(chan error, 1)
	go func() {
		_, _, err := f.queue.EnqueueAudited(t.Context(), auditInvocation, "request", 0, admissionEvent(0))
		done <- err
	}()
	wait()
	var pid int
	if err := f.db.QueryRowContext(t.Context(), `SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=9132 AND objid=$1 AND NOT granted`, f.gateKey).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	f.exec(t, `SELECT pg_terminate_backend($1)`, pid)
	if err := <-done; err == nil {
		t.Fatal("lost transaction connection reported success")
	}
	release()
	f.clearGate(t)
	verifyAuditCrashRecovery(t, f, lease)
}

func verifyAuditCrashRecovery(t *testing.T, f *auditFixture, lease operational.CLICommandLease) {
	t.Helper()
	if commands, events := f.counts(t); commands != 0 || events != 0 {
		t.Fatalf("crash leaked partial admission: commands=%d events=%d", commands, events)
	}
	command, err := f.executor.Claim(t.Context(), lease)
	if err != nil || command != nil {
		t.Fatalf("crash left runnable work: %+v, %v", command, err)
	}
	admitted, event, err := f.queue.EnqueueAudited(t.Context(), auditInvocation, "request", 0, admissionEvent(0))
	if err != nil || event.Sequence != 1 {
		t.Fatalf("recovery did not roll back idempotency and audit sequence: %+v, %v", event, err)
	}
	replayed, _, err := f.executor.EnqueueAudited(t.Context(), auditInvocation, "request", 0, admissionEvent(0))
	if err != nil || replayed.ID != admitted.ID {
		t.Fatalf("recovery duplicated work: %+v, %v", replayed, err)
	}
	if _, err := f.store.VerifyAudit(t.Context()); err != nil {
		t.Fatal(err)
	}
}
