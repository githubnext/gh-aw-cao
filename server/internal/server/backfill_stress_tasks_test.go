package server

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/collect"
	"github.com/githubnext/gh-aw-cao/server/internal/operational"
	"github.com/githubnext/gh-aw-cao/server/internal/simulator"
)

func validateSyntheticRunTasks(t *testing.T, ctx context.Context, backfill collect.Backfill, scenario simulator.Scenario, horizon int) {
	t.Helper()
	expected := scenario.Repositories * horizon * scenario.History.RunsPerDay
	seen := make([]byte, (expected+7)/8)
	const stream, group = "collect:run-tasks", "stress-audit"
	if err := backfill.Queue.Tasks.EnsureQueue(ctx, stream, group); err != nil {
		t.Fatal(err)
	}
	total := 0
	for {
		messages, err := backfill.Queue.Tasks.ReadTasks(ctx, operational.QueueRead{Queue: stream, Group: group, Consumer: "audit", Count: 1000})
		if err != nil {
			t.Fatal(err)
		}
		if len(messages) == 0 {
			break
		}
		for _, message := range messages {
			var task collect.RunTask
			if err := json.Unmarshal([]byte(message.Fields.Task), &task); err != nil {
				t.Fatal(err)
			}
			if task.RunID < 1 {
				t.Fatal("synthetic run identity is invalid")
			}
			repository := int(task.RunID-1) / (scenario.History.Days * scenario.History.RunsPerDay)
			offset := int(task.RunID-1) % (scenario.History.Days * scenario.History.RunsPerDay)
			if repository >= scenario.Repositories || offset >= horizon*scenario.History.RunsPerDay {
				t.Fatal("backfill admitted a run outside its seven-day horizon")
			}
			run := scenario.History.Run(repository, offset)
			name := fmt.Sprintf("simulator/repo-%05d", repository+1)
			if task.Repository != name || task.InstallationID != 1 || task.Attempt != 1 ||
				!task.CreatedAt.Equal(run.CreatedAt) || task.Key != fmt.Sprintf("%s:%d:1", name, run.ID) {
				t.Fatalf("durable task lost its synthetic run/repository identity: %+v", task)
			}
			index := repository*horizon*scenario.History.RunsPerDay + offset
			mask := byte(1 << uint(index%8))
			if seen[index/8]&mask != 0 {
				t.Fatal("duplicate synthetic run admission")
			}
			seen[index/8] |= mask
			total++
		}
	}
	if total != expected {
		t.Fatalf("durable run identities = %d, want exactly %d", total, expected)
	}
}
