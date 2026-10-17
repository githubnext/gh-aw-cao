package sqlite

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

func TestCLIExecutionIdentityIsDurableImmutableAndFenced(t *testing.T) {
	ctx := t.Context()
	path := filepath.Join(t.TempDir(), "cao.sqlite")
	store := openTest(t, path)
	now := time.Now()
	store.now = func() time.Time { return now }
	queue := testQueue(t, store, operational.CLICommandQueueOptions{MaxConcurrency: 1})
	executions := queue.(operational.CLICommandExecutionQueue)
	lease, err := queue.Acquire(ctx, "executor", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	command, err := queue.Enqueue(ctx, compileInvocation, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	identity := operational.CLICommandExecution{CommandID: command.ID, Name: "cao-hosted-cli-" + strings.Repeat("a", 32), RuntimeID: "daemon"}
	if err := executions.RegisterExecution(ctx, lease, identity); !errors.Is(err, operational.ErrConflict) {
		t.Fatalf("unclaimed registration: %v", err)
	}
	if _, err := queue.Claim(ctx, lease); err != nil {
		t.Fatal(err)
	}
	if err := executions.RegisterExecution(ctx, lease, identity); err != nil {
		t.Fatal(err)
	}
	if err := executions.RegisterExecution(ctx, lease, identity); !errors.Is(err, operational.ErrConflict) {
		t.Fatalf("identity registered twice: %v", err)
	}
	now = now.Add(2 * time.Minute)
	if err := executions.RegisterExecution(ctx, lease, identity); !errors.Is(err, operational.ErrConflict) {
		t.Fatalf("stale registration: %v", err)
	}
	if _, err := executions.UnsettledExecutions(ctx, lease); !errors.Is(err, operational.ErrConflict) {
		t.Fatalf("stale recovery enumeration: %v", err)
	}
	reopened := testQueue(t, openTest(t, path), operational.CLICommandQueueOptions{MaxConcurrency: 1})
	// Advance this handle's clock too, simulating lease expiration at restart.
	reopened.(*cliCommandQueue).store.now = func() time.Time { return now }
	replacement, err := reopened.Acquire(ctx, "replacement", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	saved, err := reopened.(operational.CLICommandExecutionQueue).UnsettledExecutions(ctx, replacement)
	if err != nil || len(saved) != 1 || saved[0] != identity {
		t.Fatalf("identity lost on restart: %+v %v", saved, err)
	}
	if _, err := reopened.Claim(ctx, replacement); !errors.Is(err, operational.ErrCLIQueueRecovery) {
		t.Fatalf("crash recovery did not block: %v", err)
	}
}
