package postgres

import (
	"errors"
	"strings"
	"testing"

	"github.com/githubnext/gh-cao/server/internal/operational"
)

func TestCLIExecutionIdentityIsDurableImmutableAndFenced(t *testing.T) {
	s, _ := testStore(t, Config{})
	ctx := t.Context()
	queue := commandQueue(t, s, operational.CLICommandQueueOptions{MaxConcurrency: 1})
	executions := queue.(operational.CLICommandExecutionQueue)
	lease := commandLease(t, queue)
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
	var before int64
	if err := s.db.QueryRowContext(ctx, `SELECT protected_bytes FROM cao_operational_namespaces WHERE namespace=$1`, s.namespace).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := executions.RegisterExecution(ctx, lease, identity); err != nil {
		t.Fatal(err)
	}
	if err := executions.RegisterExecution(ctx, lease, identity); !errors.Is(err, operational.ErrConflict) {
		t.Fatalf("identity registered twice: %v", err)
	}
	var after int64
	if err := s.db.QueryRowContext(ctx, `SELECT protected_bytes FROM cao_operational_namespaces WHERE namespace=$1`, s.namespace).Scan(&after); err != nil || after != before+int64(256+len(identity.Name)+len(identity.RuntimeID)) {
		t.Fatalf("execution metadata accounting: before=%d after=%d %v", before, after, err)
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE cao_operational_cli_queues SET lease_until=clock_timestamp()-interval '1 second' WHERE namespace=$1`, s.namespace); err != nil {
		t.Fatal(err)
	}
	if err := executions.RegisterExecution(ctx, lease, identity); !errors.Is(err, operational.ErrConflict) {
		t.Fatalf("stale registration: %v", err)
	}
	if _, err := executions.UnsettledExecutions(ctx, lease); !errors.Is(err, operational.ErrConflict) {
		t.Fatalf("stale recovery enumeration: %v", err)
	}
	reopened := commandQueue(t, s, operational.CLICommandQueueOptions{MaxConcurrency: 1})
	replacement := commandLease(t, reopened)
	saved, err := reopened.(operational.CLICommandExecutionQueue).UnsettledExecutions(ctx, replacement)
	if err != nil || len(saved) != 1 || saved[0] != identity {
		t.Fatalf("identity lost on restart: %+v %v", saved, err)
	}
	if _, err := reopened.Claim(ctx, replacement); !errors.Is(err, operational.ErrCLIQueueRecovery) {
		t.Fatalf("crash recovery did not block: %v", err)
	}
}
