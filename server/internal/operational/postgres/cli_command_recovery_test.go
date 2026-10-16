package postgres

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

func TestCLICommandsUnsettledTerminalRecovery(t *testing.T) {
	for _, status := range []operational.CLICommandStatus{operational.CLICommandCanceled, operational.CLICommandTimedOut} {
		t.Run(string(status), func(t *testing.T) {
			s, _ := testStore(t, Config{})
			ctx := t.Context()
			queue := commandQueue(t, s, operational.CLICommandQueueOptions{MaxConcurrency: 1})
			lease := commandLease(t, queue)
			job, err := queue.Enqueue(ctx, compileInvocation, "", 0)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := queue.Claim(ctx, lease); err != nil {
				t.Fatal(err)
			}
			if status == operational.CLICommandCanceled {
				_, err = queue.Cancel(ctx, job.ID)
			} else {
				if _, err := s.db.ExecContext(ctx, `UPDATE cao_operational_cli_commands SET deadline=clock_timestamp()-interval '1 second' WHERE namespace=$1`, s.namespace); err != nil {
					t.Fatal(err)
				}
				err = queue.Finish(ctx, lease, job.ID, operational.CLICommandResult{Status: status})
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := s.db.ExecContext(ctx, `UPDATE cao_operational_cli_queues SET lease_until=clock_timestamp()-interval '1 second' WHERE namespace=$1`, s.namespace); err != nil {
				t.Fatal(err)
			}
			replacement := commandLease(t, queue)
			if _, err := queue.Claim(ctx, replacement); !errors.Is(err, operational.ErrCLIQueueRecovery) {
				t.Fatalf("terminal claim did not block recovery: %v", err)
			}
			if err := queue.AcknowledgeRecovery(ctx, lease); !errors.Is(err, operational.ErrConflict) {
				t.Fatalf("stale acknowledgement: %v", err)
			}
			if err := queue.AcknowledgeRecovery(ctx, replacement); err != nil {
				t.Fatal(err)
			}
			retained, err := queue.Detail(ctx, job.ID)
			if err != nil || retained.Status != status || retained.ExecutionClaimed {
				t.Fatalf("terminal state changed: %+v %v", retained, err)
			}
		})
	}
}

func TestCLICommandsMaintenanceIsBoundedAndRestoresBudgets(t *testing.T) {
	s, _ := testStore(t, Config{})
	ctx := t.Context()
	queue := commandQueue(t, s, operational.CLICommandQueueOptions{})
	var initialBytes int64
	if err := s.db.QueryRowContext(ctx, `SELECT protected_bytes FROM cao_operational_namespaces WHERE namespace=$1`, s.namespace).Scan(&initialBytes); err != nil {
		t.Fatal(err)
	}
	for i := range 600 {
		if _, err := queue.Enqueue(ctx, compileInvocation, fmt.Sprintf("retained-%d", i), 0); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE cao_operational_cli_commands SET status='completed',completed_at='2000-01-03',completion_week='2000-01-03' WHERE namespace=$1`, s.namespace); err != nil {
		t.Fatal(err)
	}
	if err := s.Maintain(ctx); err != nil {
		t.Fatal(err)
	}
	page, err := queue.List(ctx, operational.CLICommandFilter{Limit: 1})
	if err != nil || page.Total != 88 {
		t.Fatalf("maintenance removed more than 512: %+v %v", page, err)
	}
	if err := s.Maintain(ctx); err != nil {
		t.Fatal(err)
	}
	var bytes, entries int64
	if err := s.db.QueryRowContext(ctx, `SELECT protected_bytes,protected_entries FROM cao_operational_namespaces WHERE namespace=$1`, s.namespace).Scan(&bytes, &entries); err != nil || bytes != initialBytes || entries != 1 {
		t.Fatalf("protected accounting not restored: bytes=%d want=%d entries=%d %v", bytes, initialBytes, entries, err)
	}
}

func TestCLICommandRetentionWeeksUseUTC(t *testing.T) {
	for _, timestamp := range []string{"2026-10-11T23:59:59Z", "2026-10-12T01:59:59+02:00"} {
		now, err := time.Parse(time.RFC3339, timestamp)
		if err != nil {
			t.Fatal(err)
		}
		if got := cliMonday(now).Format("2006-01-02"); got != "2026-10-05" {
			t.Fatalf("partial week: %s", got)
		}
	}
}
