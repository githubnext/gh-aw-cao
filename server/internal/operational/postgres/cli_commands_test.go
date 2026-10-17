package postgres

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

var compileInvocation = operational.CLICommandInvocation{ActionID: "compile", Command: "gh aw compile --strict"}

func commandQueue(t *testing.T, s *Store, options operational.CLICommandQueueOptions) operational.CLICommandQueue {
	t.Helper()
	services := s.OperationalServices()
	if err := operational.ValidateOperationalServices(s.Capabilities(), services, operational.Requirements{CLICommands: true}); err != nil {
		t.Fatal(err)
	}
	queue, err := services.CLICommands.OpenCLICommandQueue(t.Context(), "commands", options)
	if err != nil {
		t.Fatal(err)
	}
	return queue
}

func commandLease(t *testing.T, queue operational.CLICommandQueue) operational.CLICommandLease {
	t.Helper()
	lease, err := queue.Acquire(t.Context(), "executor", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	return lease
}

func TestCLICommandsAtomicFIFOAndCancellation(t *testing.T) {
	s, dsn := testStore(t, Config{})
	ctx := t.Context()
	options := operational.CLICommandQueueOptions{MaxConcurrency: 1}
	queue := commandQueue(t, s, options)
	lease := commandLease(t, queue)
	peer, err := Open(ctx, dsn, s.namespace, Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = peer.Close() }()
	other := commandQueue(t, peer, options)
	if _, err := other.Acquire(ctx, "other", time.Minute); !errors.Is(err, operational.ErrConflict) {
		t.Fatalf("duplicate owner: %v", err)
	}
	var wg sync.WaitGroup
	ids := make(chan int64, 24)
	for i := range 24 {
		wg.Go(func() {
			q := queue
			if i%2 != 0 {
				q = other
			}
			command, err := q.Enqueue(ctx, compileInvocation, "same", 0)
			if err != nil {
				t.Error(err)
				return
			}
			ids <- command.ID
		})
	}
	wg.Wait()
	close(ids)
	var first int64
	for id := range ids {
		if first != 0 && first != id {
			t.Fatal("idempotency admitted duplicate work")
		}
		first = id
	}
	second, err := other.Enqueue(ctx, compileInvocation, "second", 0)
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := queue.Claim(ctx, lease)
	if err != nil || claimed == nil || claimed.ID != first {
		t.Fatalf("FIFO: %+v %v", claimed, err)
	}
	if claimed, err := other.Claim(ctx, lease); err != nil || claimed != nil {
		t.Fatalf("concurrency: %+v %v", claimed, err)
	}
	if _, err := other.Cancel(ctx, first); err != nil {
		t.Fatal(err)
	}
	if err := queue.Finish(ctx, lease, first, operational.CLICommandResult{Status: operational.CLICommandCompleted, ExitCode: new(0)}); err != nil {
		t.Fatal(err)
	}
	canceled, err := queue.Detail(ctx, first)
	if err != nil || canceled.Status != operational.CLICommandCanceled || !canceled.ExecutionClaimed {
		t.Fatalf("cancellation lost: %+v %v", canceled, err)
	}
	if err := queue.Release(ctx, lease); !errors.Is(err, operational.ErrConflict) {
		t.Fatalf("released with an unverified subprocess: %v", err)
	}
	if next, err := queue.Claim(ctx, lease); err != nil || next != nil {
		t.Fatalf("slot reused before exit: %+v %v", next, err)
	}
	if err := queue.Settle(ctx, lease, first, new(143)); err != nil {
		t.Fatal(err)
	}
	next, err := queue.Claim(ctx, lease)
	if err != nil || next == nil || next.ID != second.ID {
		t.Fatalf("settled slot not reused: %+v %v", next, err)
	}
	if _, err := other.Enqueue(ctx, operational.CLICommandInvocation{ActionID: "compile", Command: "gh aw compile"}, "same", 0); !errors.Is(err, operational.ErrConflict) {
		t.Fatalf("idempotency mismatch: %v", err)
	}
	page, err := queue.List(ctx, operational.CLICommandFilter{Limit: 1, Statuses: []operational.CLICommandStatus{operational.CLICommandCanceled, operational.CLICommandRunning}})
	if err != nil || page.Total != 2 || page.Running != 1 || len(page.Commands) != 1 || page.Commands[0].ID != second.ID {
		t.Fatalf("filtered pagination: %+v %v", page, err)
	}
	isolated, _ := testStore(t, Config{})
	if _, err := commandQueue(t, isolated, options).Detail(ctx, first); !errors.Is(err, operational.ErrCLICommandNotFound) {
		t.Fatalf("namespace leak: %v", err)
	}
	canceledContext, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := queue.List(canceledContext, operational.CLICommandFilter{Limit: 10}); !errors.Is(err, context.Canceled) {
		t.Fatalf("ignored context: %v", err)
	}
}

func TestCLICommandExecutorLeaseSerializesConcurrentReplicas(t *testing.T) {
	s, dsn := testStore(t, Config{})
	ctx := t.Context()
	options := operational.CLICommandQueueOptions{MaxConcurrency: 1}
	first := commandQueue(t, s, options)
	peerStore, err := Open(ctx, dsn, s.namespace, Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = peerStore.Close() }()
	second := commandQueue(t, peerStore, options)

	start := make(chan struct{})
	results := make(chan error, 2)
	for index, queue := range []operational.CLICommandQueue{first, second} {
		owner := fmt.Sprintf("replica-%d", index)
		go func() {
			<-start
			_, err := queue.Acquire(ctx, owner, time.Minute)
			results <- err
		}()
	}
	close(start)
	acquired := 0
	for range 2 {
		err := <-results
		if err == nil {
			acquired++
		} else if !errors.Is(err, operational.ErrConflict) {
			t.Fatalf("replica acquisition error = %v, want lease conflict", err)
		}
	}
	if acquired != 1 {
		t.Fatalf("concurrent replicas acquired %d leases, want exactly one", acquired)
	}
}

func TestCLICommandsOutputAndRetry(t *testing.T) {
	s, _ := testStore(t, Config{})
	ctx := t.Context()
	queue := commandQueue(t, s, operational.CLICommandQueueOptions{
		MaxConcurrency: 1, MaxChunkBytes: 4, MaxOutputBytes: 8, MaxQueueOutputBytes: 6,
	})
	lease := commandLease(t, queue)
	command, err := queue.Enqueue(ctx, compileInvocation, "original", 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := queue.Claim(ctx, lease); err != nil {
		t.Fatal(err)
	}
	first, err := queue.AppendOutput(ctx, lease, command.ID, "stdout", "abc\n")
	if err != nil || first.Sequence != 1 {
		t.Fatalf("output: %+v %v", first, err)
	}
	second, err := queue.AppendOutput(ctx, lease, command.ID, "stderr", "e\n")
	if err != nil || second.Sequence != 2 {
		t.Fatalf("ordered streams: %+v %v", second, err)
	}
	dropped, err := queue.AppendOutput(ctx, lease, command.ID, "stdout", "x\n")
	if err != nil || !dropped.Truncated {
		t.Fatalf("truncation: %+v %v", dropped, err)
	}
	if _, err := queue.AppendOutput(ctx, lease, command.ID, "stdout", "ghp_example"); !errors.Is(err, operational.ErrCLICommandInput) {
		t.Fatalf("secret output persisted: %v", err)
	}
	chunks, err := queue.Output(ctx, command.ID, 1, 1)
	if err != nil || len(chunks) != 1 || chunks[0].Sequence != 2 || chunks[0].Stream != "stderr" {
		t.Fatalf("cursor replay: %+v %v", chunks, err)
	}
	if err := queue.Finish(ctx, lease, command.ID, operational.CLICommandResult{Status: operational.CLICommandTimedOut}); !errors.Is(err, operational.ErrConflict) {
		t.Fatalf("early timeout: %v", err)
	}
	if err := queue.Finish(ctx, lease, command.ID, operational.CLICommandResult{Status: operational.CLICommandFailed, ExitCode: new(1)}); err != nil {
		t.Fatal(err)
	}
	if err := queue.Settle(ctx, lease, command.ID, new(1)); err != nil {
		t.Fatal(err)
	}
	if _, err := queue.Enqueue(ctx, compileInvocation, "original", command.ID); !errors.Is(err, operational.ErrConflict) {
		t.Fatalf("retry reused original identity: %v", err)
	}
	retry, err := queue.Enqueue(ctx, compileInvocation, "retry", command.ID)
	if err != nil || retry.ID == command.ID || retry.RetryOf != command.ID {
		t.Fatalf("retry ancestry: %+v %v", retry, err)
	}
	detail, err := queue.Detail(ctx, command.ID)
	if err != nil || !detail.OutputTruncated || detail.OutputChunks != 2 || detail.OutputBytes != 6 {
		t.Fatalf("output accounting: %+v %v", detail, err)
	}
	if err := queue.Release(ctx, lease); err != nil {
		t.Fatal(err)
	}
}

func TestCLICommandsRestartAndFencedRecovery(t *testing.T) {
	s, dsn := testStore(t, Config{})
	ctx := t.Context()
	queue := commandQueue(t, s, operational.CLICommandQueueOptions{MaxConcurrency: 1})
	stale := commandLease(t, queue)
	claimed, err := queue.Enqueue(ctx, compileInvocation, "running", 0)
	if err != nil {
		t.Fatal(err)
	}
	pending, err := queue.Enqueue(ctx, compileInvocation, "pending", 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := queue.Claim(ctx, stale); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE cao_operational_cli_queues SET lease_until=clock_timestamp()-interval '1 second' WHERE namespace=$1 AND name='commands'`, s.namespace); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(ctx, dsn, s.namespace, Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reopened.Close() }()
	recovered := commandQueue(t, reopened, operational.CLICommandQueueOptions{MaxConcurrency: 1})
	lease := commandLease(t, recovered)
	if lease.Fence <= stale.Fence {
		t.Fatal("ownership fence did not advance")
	}
	if _, err := recovered.Renew(ctx, stale, time.Minute); !errors.Is(err, operational.ErrConflict) {
		t.Fatalf("stale renewal: %v", err)
	}
	if _, err := recovered.AppendOutput(ctx, stale, claimed.ID, "stdout", "stale\n"); !errors.Is(err, operational.ErrConflict) {
		t.Fatalf("stale writer: %v", err)
	}
	if err := recovered.Settle(ctx, stale, claimed.ID, nil); !errors.Is(err, operational.ErrConflict) {
		t.Fatalf("stale settlement: %v", err)
	}
	if _, err := recovered.Claim(ctx, lease); !errors.Is(err, operational.ErrCLIQueueRecovery) {
		t.Fatalf("uncertain subprocess ignored: %v", err)
	}
	detail, err := recovered.Detail(ctx, claimed.ID)
	if err != nil || detail.Status != operational.CLICommandFailed || !detail.ExecutionClaimed {
		t.Fatalf("interrupted command: %+v %v", detail, err)
	}
	if err := recovered.AcknowledgeRecovery(ctx, lease); err != nil {
		t.Fatal(err)
	}
	next, err := recovered.Claim(ctx, lease)
	if err != nil || next == nil || next.ID != pending.ID {
		t.Fatalf("pending work lost: %+v %v", next, err)
	}
	if _, err := recovered.Renew(ctx, lease, time.Minute); err != nil {
		t.Fatal(err)
	}
}

func TestCLICommandsCapacityRetentionAndConfiguration(t *testing.T) {
	s, _ := testStore(t, Config{})
	ctx := t.Context()
	options := operational.CLICommandQueueOptions{MaxConcurrency: 1, MaxJobs: 1}
	queue := commandQueue(t, s, options)
	lease := commandLease(t, queue)
	command, err := queue.Enqueue(ctx, compileInvocation, "first", 0)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := queue.Enqueue(ctx, compileInvocation, "second", 0); !errors.Is(err, operational.ErrCapacity) {
		t.Fatalf("job capacity: %v", err)
	}
	if _, err := s.OpenCLICommandQueue(ctx, "commands", operational.CLICommandQueueOptions{MaxJobs: 2}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("configuration drift: %v", err)
	}
	if _, err := queue.Claim(ctx, lease); err != nil {
		t.Fatal(err)
	}
	if _, err := queue.AppendOutput(ctx, lease, command.ID, "stdout", "retained\n"); err != nil {
		t.Fatal(err)
	}
	if _, err := queue.Cancel(ctx, command.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE cao_operational_cli_commands SET completion_week='2000-01-03' WHERE namespace=$1`, s.namespace); err != nil {
		t.Fatal(err)
	}
	if removed, err := queue.Retain(ctx); err != nil || removed != 0 {
		t.Fatalf("retained unsettled subprocess: %d %v", removed, err)
	}
	if err := queue.Settle(ctx, lease, command.ID, nil); err != nil {
		t.Fatal(err)
	}
	if err := s.Maintain(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := queue.Detail(ctx, command.ID); !errors.Is(err, operational.ErrCLICommandNotFound) {
		t.Fatalf("idle retention: %v", err)
	}
	var commands, output int
	if err := s.db.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM cao_operational_cli_commands WHERE namespace=$1),(SELECT count(*) FROM cao_operational_cli_output WHERE namespace=$1)`, s.namespace).Scan(&commands, &output); err != nil || commands != 0 || output != 0 {
		t.Fatalf("cascade: commands=%d output=%d %v", commands, output, err)
	}
	if _, err := queue.Enqueue(ctx, compileInvocation, "second", 0); err != nil {
		t.Fatalf("capacity not restored: %v", err)
	}
	bounded, _ := testStore(t, Config{MaxProtectedEntries: 2})
	small := commandQueue(t, bounded, operational.CLICommandQueueOptions{})
	smallLease := commandLease(t, small)
	job, err := small.Enqueue(ctx, compileInvocation, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := small.Claim(ctx, smallLease); err != nil {
		t.Fatal(err)
	}
	if _, err := small.AppendOutput(ctx, smallLease, job.ID, "stdout", "over budget\n"); !errors.Is(err, operational.ErrCapacity) {
		t.Fatalf("protected capacity: %v", err)
	}
	if chunks, err := small.Output(ctx, job.ID, 0, 10); err != nil || len(chunks) != 0 {
		t.Fatalf("partial output transaction: %+v %v", chunks, err)
	}
}
