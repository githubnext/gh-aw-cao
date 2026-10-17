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

func TestLifecycleSQLiteProcessCrash(t *testing.T) {
	if path := os.Getenv("CAO_TEST_LIFECYCLE_CRASH_DB"); path != "" {
		crashLifecycleSQLite(t, path, os.Getenv("CAO_TEST_LIFECYCLE_PHASE"))
		return
	}
	for _, phase := range []string{"result", "finished"} {
		t.Run(phase, func(t *testing.T) {
			f := newAuditFixture(t, "sqlite")
			lease := acquireAuditLease(t, f)
			command := claimedLifecycleCommand(t, f, lease)
			if phase == "finished" {
				if err := f.executor.Finish(t.Context(), lease, command.ID, operational.CLICommandResult{Status: operational.CLICommandCompleted}); err != nil {
					t.Fatal(err)
				}
			}
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			child := exec.CommandContext(t.Context(), executable, "-test.run=^TestLifecycleSQLiteProcessCrash$") // #nosec G204 -- same test binary and isolated temporary database.
			child.Env = append(os.Environ(), "CAO_TEST_LIFECYCLE_CRASH_DB="+f.sqlitePath, "CAO_TEST_LIFECYCLE_PHASE="+phase)
			output, err := child.CombinedOutput()
			var exited *exec.ExitError
			if !errors.As(err, &exited) || exited.ExitCode() != 23 {
				t.Fatalf("lifecycle crash helper: %v\n%s", err, output)
			}
			f.exec(t, `DROP TRIGGER lifecycle_crash`)
			verifyLifecycleCrash(t, f, phase, command.ID)
		})
	}
}

func crashLifecycleSQLite(t *testing.T, path, phase string) {
	t.Helper()
	if err := sqlitedriver.RegisterScalarFunction("crash_lifecycle", 0, func(*sqlitedriver.FunctionContext, []driver.Value) (driver.Value, error) {
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
	if _, err := db.ExecContext(t.Context(), `CREATE TRIGGER lifecycle_crash BEFORE INSERT ON cao_operational_audit_events BEGIN SELECT crash_lifecycle(); END`); err != nil {
		t.Fatal(err)
	}
	lease := operational.CLICommandLease{Owner: "executor", Fence: 1}
	if phase == "result" {
		err = queue.Finish(t.Context(), lease, 1, operational.CLICommandResult{Status: operational.CLICommandCompleted})
	} else {
		err = queue.Settle(t.Context(), lease, 1, nil)
	}
	t.Fatal("expected process crash within audit INSERT", err)
}

func TestLifecyclePostgresConnectionLoss(t *testing.T) {
	for _, phase := range []string{"result", "finished"} {
		t.Run(phase, func(t *testing.T) {
			f := newAuditFixture(t, "postgres")
			lease := acquireAuditLease(t, f)
			command := claimedLifecycleCommand(t, f, lease)
			if phase == "finished" {
				if err := f.executor.Finish(t.Context(), lease, command.ID, operational.CLICommandResult{Status: operational.CLICommandCompleted}); err != nil {
					t.Fatal(err)
				}
			}
			wait, release := f.gate(t, false)
			done := make(chan error, 1)
			go func() {
				if phase == "result" {
					done <- f.executor.Finish(t.Context(), lease, command.ID, operational.CLICommandResult{Status: operational.CLICommandCompleted})
				} else {
					done <- f.executor.Settle(t.Context(), lease, command.ID, nil)
				}
			}()
			wait()
			var pid int
			if err := f.db.QueryRowContext(t.Context(), `SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=9132 AND objid=$1 AND NOT granted`, f.gateKey).Scan(&pid); err != nil {
				t.Fatal(err)
			}
			f.exec(t, `SELECT pg_terminate_backend($1)`, pid)
			if err := <-done; err == nil {
				t.Fatal("lost connection was reported as successful completion")
			}
			release()
			f.clearGate(t)
			verifyLifecycleCrash(t, f, phase, command.ID)
		})
	}
}

func verifyLifecycleCrash(t *testing.T, f *auditFixture, phase string, id int64) {
	t.Helper()
	current, err := f.queue.Detail(t.Context(), id)
	if err != nil || !current.ExecutionClaimed || (phase == "result" && current.Status != operational.CLICommandRunning) {
		t.Fatal("crash committed unaudited lifecycle state", err)
	}
	lifecycleEvents(t, f, "cli_command."+phase, 0)
	expireLifecycleLease(t, f)
	lease := acquireAuditLease(t, f)
	// An interrupted known result remains known. A lost result is explicitly
	// failed/unknown, and neither permits dispatch before operator recovery.
	if _, err := f.executor.Claim(t.Context(), lease); !errors.Is(err, operational.ErrCLIQueueRecovery) {
		t.Fatal("crash recovery silently dispatched work")
	}
	if err := f.executor.AcknowledgeRecovery(t.Context(), lease); err != nil {
		t.Fatal(err)
	}
	event := lifecycleEvents(t, f, "cli_command.finished", 1)[0]
	wantStatus := "failed"
	if phase == "finished" {
		wantStatus = "completed"
	}
	if event.Attributes["status"] != wantStatus || event.Attributes["recovered"] != "true" {
		t.Fatal("recovery misrepresented the retained execution result")
	}
}
