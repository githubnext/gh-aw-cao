package sqlite

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/githubnext/gh-cao/server/internal/operational"
)

var compileInvocation = operational.CLICommandInvocation{ActionID: "compile", Command: "gh aw compile --strict", Actor: "octocat", ActorID: 101, Repository: "octo/repo"}

func openTest(t *testing.T, path string) *Store {
	t.Helper()
	store, err := Open(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func testQueue(t *testing.T, store *Store, options operational.CLICommandQueueOptions) operational.CLICommandQueue {
	t.Helper()
	queue, err := store.OpenCLICommandQueue(t.Context(), "commands", options)
	if err != nil {
		t.Fatal(err)
	}
	return queue
}

func TestOpenCreatesPrivateFileAndRejectsURIPaths(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cao.sqlite")
	openTest(t, path)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v", info.Mode().Perm())
	}
	for _, bad := range []string{"", "x.db?mode=memory", "x.db#frag"} {
		if _, err := Open(t.Context(), bad); !errors.Is(err, ErrInvalid) {
			t.Fatalf("Open(%q) = %v", bad, err)
		}
	}
}

func TestCLICommandLifecycleAcrossHandles(t *testing.T) {
	ctx := t.Context()
	path := filepath.Join(t.TempDir(), "cao.sqlite")
	web, executor := openTest(t, path), openTest(t, path)
	options := operational.CLICommandQueueOptions{MaxConcurrency: 1}
	admit, run := testQueue(t, web, options), testQueue(t, executor, options)
	if _, err := web.OpenCLICommandQueue(ctx, "commands", operational.CLICommandQueueOptions{MaxConcurrency: 2}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("changed options: %v", err)
	}

	var wg sync.WaitGroup
	ids := make(chan int64, 8)
	for range 8 {
		wg.Go(func() {
			command, err := admit.Enqueue(ctx, compileInvocation, "same", 0)
			if err != nil {
				t.Error(err)
				return
			}
			ids <- command.ID
		})
	}
	wg.Wait()
	close(ids)
	first := <-ids
	for id := range ids {
		if id != first {
			t.Fatalf("idempotent enqueue created %d and %d", first, id)
		}
	}
	if _, err := admit.Enqueue(ctx, operational.CLICommandInvocation{ActionID: "other", Command: "gh aw logs"}, "same", 0); !errors.Is(err, operational.ErrConflict) {
		t.Fatalf("idempotency conflict: %v", err)
	}
	second, err := admit.Enqueue(ctx, compileInvocation, "", 0)
	if err != nil {
		t.Fatal(err)
	}

	lease, err := run.Acquire(ctx, "executor", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admit.Acquire(ctx, "other", time.Minute); !errors.Is(err, operational.ErrConflict) {
		t.Fatalf("second owner: %v", err)
	}
	claimed, err := run.Claim(ctx, lease)
	if err != nil || claimed == nil || claimed.ID != first || claimed.Status != operational.CLICommandRunning ||
		claimed.Actor != "octocat" || claimed.ActorID != 101 || claimed.Repository != "octo/repo" || claimed.Deadline == nil {
		t.Fatalf("claim = %+v, %v", claimed, err)
	}
	if next, err := run.Claim(ctx, lease); err != nil || next != nil {
		t.Fatalf("concurrency bound: %+v, %v", next, err)
	}
	chunk, err := run.AppendOutput(ctx, lease, first, "stdout", "compiled 3 workflows\n")
	if err != nil || chunk.Sequence != 1 {
		t.Fatalf("output: %+v, %v", chunk, err)
	}
	code := 0
	if err := run.Finish(ctx, lease, first, operational.CLICommandResult{Status: operational.CLICommandCompleted, ExitCode: &code}); err != nil {
		t.Fatal(err)
	}
	if err := run.Settle(ctx, lease, first, &code); err != nil {
		t.Fatal(err)
	}
	detail, err := admit.Detail(ctx, first)
	if err != nil || detail.Status != operational.CLICommandCompleted || detail.ExitCode == nil || *detail.ExitCode != 0 ||
		detail.ExecutionClaimed || detail.CompletionWeek == "" || detail.OutputBytes != len("compiled 3 workflows\n") {
		t.Fatalf("detail = %+v, %v", detail, err)
	}
	output, err := admit.Output(ctx, first, 0, 10)
	if err != nil || len(output) != 1 || output[0].Data != "compiled 3 workflows\n" {
		t.Fatalf("output = %+v, %v", output, err)
	}

	canceled, err := admit.Cancel(ctx, second.ID)
	if err != nil || canceled.Status != operational.CLICommandCanceled {
		t.Fatalf("cancel = %+v, %v", canceled, err)
	}
	page, err := admit.List(ctx, operational.CLICommandFilter{Limit: 10, Statuses: []operational.CLICommandStatus{operational.CLICommandCompleted}})
	if err != nil || page.Total != 1 || len(page.Commands) != 1 || page.Commands[0].ID != first || page.Revision == 0 {
		t.Fatalf("list = %+v, %v", page, err)
	}
	if err := run.Release(ctx, lease); err != nil {
		t.Fatal(err)
	}
}

func TestCLICommandRecoveryAfterInterruptedExecutor(t *testing.T) {
	ctx := t.Context()
	store := openTest(t, filepath.Join(t.TempDir(), "cao.sqlite"))
	queue := testQueue(t, store, operational.CLICommandQueueOptions{})
	command, err := queue.Enqueue(ctx, compileInvocation, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	lease, err := queue.Acquire(ctx, "first", 500*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := queue.Claim(ctx, lease); err != nil {
		t.Fatal(err)
	}
	time.Sleep(600 * time.Millisecond)
	if err := queue.Finish(ctx, lease, command.ID, operational.CLICommandResult{Status: operational.CLICommandFailed}); !errors.Is(err, operational.ErrConflict) {
		t.Fatalf("expired lease finished: %v", err)
	}
	next, err := queue.Acquire(ctx, "second", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := queue.Claim(ctx, next); !errors.Is(err, operational.ErrCLIQueueRecovery) {
		t.Fatalf("claim before recovery: %v", err)
	}
	detail, err := queue.Detail(ctx, command.ID)
	if err != nil || detail.Status != operational.CLICommandFailed || !strings.Contains(detail.Error, "interrupted") {
		t.Fatalf("interrupted = %+v, %v", detail, err)
	}
	if err := queue.AcknowledgeRecovery(ctx, next); err != nil {
		t.Fatal(err)
	}
	retry, err := queue.Enqueue(ctx, compileInvocation, "", command.ID)
	if err != nil || retry.RetryOf != command.ID {
		t.Fatalf("retry = %+v, %v", retry, err)
	}
	if claimed, err := queue.Claim(ctx, next); err != nil || claimed == nil || claimed.ID != retry.ID {
		t.Fatalf("claim after recovery = %+v, %v", claimed, err)
	}
}

func TestCLICommandExecutorLeaseSerializesConcurrentHandles(t *testing.T) {
	ctx := t.Context()
	path := filepath.Join(t.TempDir(), "cao.sqlite")
	firstStore, secondStore := openTest(t, path), openTest(t, path)
	options := operational.CLICommandQueueOptions{MaxConcurrency: 1}
	first, second := testQueue(t, firstStore, options), testQueue(t, secondStore, options)

	start := make(chan struct{})
	errs := make(chan error, 2)
	for index, queue := range []operational.CLICommandQueue{first, second} {
		owner := []string{"replica-1", "replica-2"}[index]
		go func() {
			<-start
			_, err := queue.Acquire(ctx, owner, time.Minute)
			errs <- err
		}()
	}
	close(start)
	acquired, conflicted := 0, 0
	for range 2 {
		err := <-errs
		switch {
		case err == nil:
			acquired++
		case errors.Is(err, operational.ErrConflict):
			conflicted++
		default:
			t.Fatalf("replica acquisition error = %v", err)
		}
	}
	if acquired != 1 || conflicted != 1 {
		t.Fatalf("concurrent replica results: acquired=%d conflicted=%d", acquired, conflicted)
	}
}

func TestAuditTableChainsAndRejectsEdits(t *testing.T) {
	ctx := t.Context()
	path := filepath.Join(t.TempDir(), "cao.sqlite")
	web, executor := openTest(t, path), openTest(t, path)
	var wg sync.WaitGroup
	for i := range 20 {
		wg.Go(func() {
			store := web
			if i%2 == 1 {
				store = executor
			}
			if _, err := store.AppendAudit(ctx, operational.AuditEvent{Event: "cli_command.admitted", Outcome: "success", Actor: "octocat",
				Attributes: map[string]string{"repository": "octo/repo"}}); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	verification, err := web.VerifyAudit(ctx)
	if err != nil || verification.Events != 20 || verification.FirstSequence != 1 || verification.LastSequence != 20 {
		t.Fatalf("verify = %+v, %v", verification, err)
	}
	events, err := executor.ListAudit(ctx, operational.AuditFilter{AfterSequence: 18, Actor: "octocat"})
	if err != nil || len(events) != 2 || events[0].Sequence != 19 || events[0].Attributes["repository"] != "octo/repo" {
		t.Fatalf("list = %+v, %v", events, err)
	}
	if _, err := web.AppendAudit(ctx, operational.AuditEvent{Event: "x", Outcome: "maybe"}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("invalid outcome: %v", err)
	}
	for _, statement := range []string{
		`UPDATE cao_operational_audit_events SET actor='mallory' WHERE sequence=3`,
		`DELETE FROM cao_operational_audit_events WHERE sequence=3`,
	} {
		if _, err := web.db.ExecContext(ctx, statement); err == nil || !strings.Contains(err.Error(), "append-only") {
			t.Fatalf("%s: %v", statement, err)
		}
	}

	// A writer who bypasses the trigger is still detected by the chain.
	if _, err := web.db.ExecContext(ctx, `DROP TRIGGER cao_operational_audit_no_update`); err != nil {
		t.Fatal(err)
	}
	if _, err := web.db.ExecContext(ctx, `UPDATE cao_operational_audit_events SET record=replace(record,'octo/repo','evil/repo') WHERE sequence=5`); err != nil {
		t.Fatal(err)
	}
	if _, err := web.VerifyAudit(ctx); !errors.Is(err, operational.ErrAuditTampered) || !strings.Contains(err.Error(), "sequence 5") {
		t.Fatalf("tamper: %v", err)
	}
}

func TestAuditRetentionKeepsVerifiableSuffix(t *testing.T) {
	ctx := t.Context()
	store := openTest(t, filepath.Join(t.TempDir(), "cao.sqlite"))
	old := time.Now().Add(-2 * operational.AuditRetention)
	store.now = func() time.Time { return old }
	for range 3 {
		if _, err := store.AppendAudit(ctx, operational.AuditEvent{Event: "token.minted", Outcome: "success"}); err != nil {
			t.Fatal(err)
		}
	}
	store.now = time.Now
	if removed, err := store.RetainAudit(ctx); err != nil || removed != 2 {
		t.Fatalf("retention removed %d events: %v", removed, err)
	}
	// The newest row is kept even though it is past retention.
	verification, err := store.VerifyAudit(ctx)
	if err != nil || verification.Events != 1 || verification.FirstSequence != 3 {
		t.Fatalf("after retention = %+v, %v", verification, err)
	}
	event, err := store.AppendAudit(ctx, operational.AuditEvent{Event: "token.revoked", Outcome: "success"})
	if err != nil || event.Sequence != 4 {
		t.Fatalf("append after retention = %+v, %v", event, err)
	}
	if verification, err := store.VerifyAudit(ctx); err != nil || verification.Events != 2 {
		t.Fatalf("verify = %+v, %v", verification, err)
	}
	var markers int
	if err := store.db.QueryRowContext(ctx, `SELECT count(*) FROM cao_operational_audit_retention`).Scan(&markers); err != nil || markers != 0 {
		t.Fatalf("retention marker left behind: %d, %v", markers, err)
	}
}

func TestAuditAnchorsDetectRewriteAndRollback(t *testing.T) {
	ctx := t.Context()
	store := openTest(t, filepath.Join(t.TempDir(), "cao.sqlite"))
	for range 3 {
		if _, err := store.AppendAudit(ctx, operational.AuditEvent{Event: "token.minted", Outcome: "success"}); err != nil {
			t.Fatal(err)
		}
	}
	head, err := store.VerifyAudit(ctx)
	if err != nil || head.LastSequence != 3 || len(head.LastHash) != 64 {
		t.Fatalf("head = %+v, %v", head, err)
	}
	anchor := operational.AuditAnchor{Sequence: head.LastSequence, Hash: head.LastHash}
	if result, err := store.VerifyAudit(ctx, anchor); err != nil || result.AnchorsChecked != 1 {
		t.Fatalf("anchored verify = %+v, %v", result, err)
	}
	wrong := operational.AuditAnchor{Sequence: 2, Hash: head.LastHash}
	if _, err := store.VerifyAudit(ctx, wrong); !errors.Is(err, operational.ErrAuditTampered) {
		t.Fatalf("mismatched anchor accepted: %v", err)
	}
	if _, err := store.VerifyAudit(ctx, operational.AuditAnchor{Sequence: 2, Hash: "zz"}); !errors.Is(err, operational.ErrAuditInput) {
		t.Fatalf("malformed anchor accepted: %v", err)
	}
	// A file owner can drop the triggers and roll back the newest event; the
	// chain alone still verifies, but the external anchor does not.
	if _, err := store.db.ExecContext(ctx, `DROP TRIGGER cao_operational_audit_no_delete`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(ctx, `DELETE FROM cao_operational_audit_events WHERE sequence=3`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.VerifyAudit(ctx); err != nil {
		t.Fatalf("truncated chain should verify without anchors: %v", err)
	}
	if _, err := store.VerifyAudit(ctx, anchor); !errors.Is(err, operational.ErrAuditTampered) {
		t.Fatalf("rollback past the anchor was not detected: %v", err)
	}
}
