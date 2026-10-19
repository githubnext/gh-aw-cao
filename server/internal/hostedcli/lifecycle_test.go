package hostedcli

import (
	"io"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-cao/server/internal/audit"
	"github.com/githubnext/gh-cao/server/internal/operational"
)

func TestLifecycleExecutorRequiresAtomicCapabilities(t *testing.T) {
	for _, missing := range []string{"queue", "revocations"} {
		t.Run(missing, func(t *testing.T) {
			f := newLifecycleExecutor(t, "write", "")
			queue, broker := f.queue, f.executor.broker
			if missing == "queue" {
				queue = struct {
					operational.CLICommandQueue
					operational.CLICommandExecutionQueue
				}{queue, queue.(operational.CLICommandExecutionQueue)}
			} else {
				broker.options.Revocations.queue = struct{ operational.RevocationQueue }{broker.options.Revocations.queue}
			}
			_, err := NewExecutor(queue, broker, fakeGitHub{permission: "write"}, f.runner, f.executor.options)
			if err == nil || !strings.Contains(err.Error(), "atomic lifecycle audit storage") {
				t.Fatal("production executor accepted non-atomic lifecycle storage")
			}
		})
	}
}

type lifecycleExecutor struct {
	executor *Executor
	queue    operational.CLICommandQueue
	store    operational.AuditLog
	minter   *fakeMinter
	runner   *fakeRunner
}

func newLifecycleExecutor(t *testing.T, permission, rejectEvent string) lifecycleExecutor {
	t.Helper()
	journal, faults := testTokenJournal(t)
	store := faults.RevocationQueue.(interface {
		operational.CLICommandQueues
		operational.AuditLog
	})
	queue, err := store.OpenCLICommandQueue(t.Context(), "commands", operational.CLICommandQueueOptions{})
	if err != nil {
		t.Fatal(err)
	}
	auditLog := audit.New(io.Discard).WithStore(store)
	if rejectEvent != "" {
		auditLog = audit.New(io.Discard).WithStore(failingAuditStore{event: rejectEvent})
	}
	minter := newFakeMinter()
	runner := &fakeRunner{minter: minter}
	broker := NewBroker(minter, BrokerOptions{Audit: auditLog, Revocations: journal})
	executor, err := NewExecutor(queue, broker, fakeGitHub{permission: permission}, runner,
		Options{Owner: "test", Audit: auditLog, WorkRoot: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := broker.Close(t.Context()); err != nil {
			t.Error(err)
		}
	})
	return lifecycleExecutor{executor, queue, store, minter, runner}
}

func (f lifecycleExecutor) execute(t *testing.T) operational.CLICommand {
	t.Helper()
	lease, err := f.queue.Acquire(t.Context(), "test", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.queue.Enqueue(t.Context(), operational.CLICommandInvocation{
		ActionID: "upgrade", Command: "gh aw upgrade --repo octo/app --create-pull-request",
		Repository: "octo/app", Actor: "mona",
	}, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	command, err := f.queue.Claim(t.Context(), lease)
	if err != nil || command == nil {
		t.Fatal("could not claim command", err)
	}
	f.executor.execute(t.Context(), lease, *command)
	if err := f.executor.broker.Maintain(t.Context()); err != nil {
		t.Fatal(err)
	}
	result, err := f.queue.Detail(t.Context(), command.ID)
	if err != nil {
		t.Fatal(err)
	}
	return result
}
